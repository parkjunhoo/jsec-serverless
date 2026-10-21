const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

let cachedAccessToken = '';
let cachedAccessTokenExpiresAt = 0;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

function base64UrlEncode(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function decodePrivateKey(pem) {
  const encoded = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');
  const binary = atob(encoded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function getFcmAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedAccessToken && cachedAccessTokenExpiresAt > now + 60) {
    return cachedAccessToken;
  }

  const issuedAt = now;
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64UrlEncode(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: FCM_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: issuedAt,
    exp: issuedAt + 3600
  }));
  const unsignedToken = `${header}.${claim}`;
  const signingKey = await crypto.subtle.importKey(
    'pkcs8',
    decodePrivateKey(serviceAccount.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    signingKey,
    new TextEncoder().encode(unsignedToken)
  );
  const assertion = `${unsignedToken}.${base64UrlEncode(new Uint8Array(signature))}`;

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });
  const result = await response.json();
  if (!response.ok || !result.access_token) {
    throw new Error(`FCM 인증 실패: ${result.error_description || result.error || response.status}`);
  }

  cachedAccessToken = result.access_token;
  cachedAccessTokenExpiresAt = now + Number(result.expires_in || 3600);
  return cachedAccessToken;
}

export async function sendPushToUsers(supabaseAdmin, env, userIds, notification) {
  if (!env.FCM_SERVICE_ACCOUNT_JSON) {
    throw new Error('FCM_SERVICE_ACCOUNT_JSON secret이 설정되지 않았습니다.');
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(env.FCM_SERVICE_ACCOUNT_JSON);
  } catch {
    throw new Error('FCM_SERVICE_ACCOUNT_JSON이 올바른 JSON이 아닙니다.');
  }
  if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error('FCM 서비스 계정 JSON에 필수 항목이 없습니다.');
  }

  const uniqueUserIds = [...new Set(userIds)];
  if (uniqueUserIds.length === 0) return { sent: 0, failed: 0 };
  const registrations = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabaseAdmin
      .from('push_tokens')
      .select('token, user_id, enabled')
      .in('user_id', uniqueUserIds)
      .range(offset, offset + 999);
    if (error) throw error;
    registrations.push(...(data || []));
    if (!data || data.length < 1000) break;
  }

  const enabledRegistrations = registrations.filter(registration => registration.enabled);
  if (enabledRegistrations.length === 0) return { sent: 0, failed: 0 };
  const accessToken = await getFcmAccessToken(serviceAccount);
  let sent = 0;
  let failed = 0;

  for (let offset = 0; offset < enabledRegistrations.length; offset += 25) {
    const batch = enabledRegistrations.slice(offset, offset + 25);
    const results = await Promise.all(batch.map(async ({ token }) => {
      const response = await fetch(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(serviceAccount.project_id)}/messages:send`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            message: {
              token,
              notification: {
                title: notification.title,
                body: notification.body
              },
              data: { type: notification.type },
              android: { priority: 'high' }
            }
          })
        }
      );

      if (response.ok) return { token, sent: true };
      const result = await response.json().catch(() => ({}));
      const details = JSON.stringify(result);
      if (details.includes('UNREGISTERED') || details.includes('INVALID_ARGUMENT')) {
        const { error: deleteError } = await supabaseAdmin
          .from('push_tokens')
          .delete()
          .eq('token', token);
        if (deleteError) console.error('FCM 토큰 정리 실패:', deleteError.message);
      }
      console.error('FCM 발송 실패:', response.status, result);
      return { token, sent: false };
    }));

    sent += results.filter(result => result.sent).length;
    failed += results.length - results.filter(result => result.sent).length;
  }

  return { sent, failed };
}

export async function sendPushToAll(supabaseAdmin, env, notification) {
  if (!env.FCM_SERVICE_ACCOUNT_JSON) {
    throw new Error('FCM_SERVICE_ACCOUNT_JSON secret이 설정되지 않았습니다.');
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(env.FCM_SERVICE_ACCOUNT_JSON);
  } catch {
    throw new Error('FCM_SERVICE_ACCOUNT_JSON이 올바른 JSON이 아닙니다.');
  }

  if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error('FCM 서비스 계정 JSON에 필수 항목이 없습니다.');
  }

  const userIds = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('id')
      .range(offset, offset + 999);
    if (error) throw error;
    userIds.push(...(data || []).map(user => user.id));
    if (!data || data.length < 1000) break;
  }

  for (let offset = 0; offset < userIds.length; offset += 500) {
    const { error } = await supabaseAdmin
      .from('notifications')
      .insert(userIds.slice(offset, offset + 500).map(userId => ({
        user_id: userId,
        title: notification.title,
        body: notification.body,
        type: notification.type
      })));
    if (error) throw error;
  }

  const registrations = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabaseAdmin
      .from('push_tokens')
      .select('token, user_id, enabled')
      .range(offset, offset + 999);
    if (error) throw error;
    registrations.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const enabledRegistrations = registrations.filter(registration => registration.enabled);
  if (enabledRegistrations.length === 0) return { sent: 0, failed: 0 };

  const accessToken = await getFcmAccessToken(serviceAccount);
  let sent = 0;
  let failed = 0;

  for (let offset = 0; offset < enabledRegistrations.length; offset += 25) {
    const batch = enabledRegistrations.slice(offset, offset + 25);
    const results = await Promise.all(batch.map(async ({ token }) => {
      const response = await fetch(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(serviceAccount.project_id)}/messages:send`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            message: {
              token,
              notification: {
                title: notification.title,
                body: notification.body
              },
              data: {
                type: notification.type
              },
              android: {
                priority: 'high'
              }
            }
          })
        }
      );

      if (response.ok) return { token, sent: true };

      const result = await response.json().catch(() => ({}));
      const details = JSON.stringify(result);
      if (details.includes('UNREGISTERED') || details.includes('INVALID_ARGUMENT')) {
        const { error: deleteError } = await supabaseAdmin
          .from('push_tokens')
          .delete()
          .eq('token', token);
        if (deleteError) console.error('FCM 토큰 정리 실패:', deleteError.message);
      }
      console.error('FCM 발송 실패:', response.status, result);
      return { token, sent: false };
    }));

    sent += results.filter(result => result.sent).length;
    failed += results.length - results.filter(result => result.sent).length;
  }

  return { sent, failed };
}

export async function authenticateRequest(request, supabaseAdmin) {
  const authorization = request.headers.get('Authorization') || '';
  const accessToken = authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : '';
  if (!accessToken) {
    return { error: jsonResponse({ error: '로그인이 필요합니다.' }, 401) };
  }

  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data.user) {
    return { error: jsonResponse({ error: '유효하지 않은 로그인 세션입니다.' }, 401) };
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('users')
    .select('id, name, username, role, status')
    .eq('id', data.user.id)
    .maybeSingle();
  if (profileError) throw profileError;
  if (!profile) {
    return { error: jsonResponse({ error: '사용자 프로필을 찾을 수 없습니다.' }, 403) };
  }
  if (profile.status === '퇴직') {
    return { error: jsonResponse({ error: '퇴직 처리된 계정은 이용할 수 없습니다.' }, 403) };
  }

  return { user: data.user, profile };
}

export async function handleRegisterPushToken(request, supabaseAdmin) {
  const auth = await authenticateRequest(request, supabaseAdmin);
  if (auth.error) return auth.error;

  const body = await request.json();
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!token || token.length > 4096) {
    return jsonResponse({ error: '유효한 FCM 토큰이 필요합니다.' }, 400);
  }

  const { data: existingToken, error: lookupError } = await supabaseAdmin
    .from('push_tokens')
    .select('enabled')
    .eq('token', token)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (lookupError) throw lookupError;

  const { error } = await supabaseAdmin
    .from('push_tokens')
    .upsert({
      token,
      user_id: auth.user.id,
      platform: 'android',
      enabled: existingToken ? existingToken.enabled : true,
      updated_at: new Date().toISOString()
    }, { onConflict: 'token' });
  if (error) throw error;

  return jsonResponse({ success: true });
}

export async function handleGetPushPreference(request, supabaseAdmin) {
  const auth = await authenticateRequest(request, supabaseAdmin);
  if (auth.error) return auth.error;

  const token = new URL(request.url).searchParams.get('token') || '';
  if (!token || token.length > 4096) {
    return jsonResponse({ error: '유효한 FCM 토큰이 필요합니다.' }, 400);
  }

  const { data, error } = await supabaseAdmin
    .from('push_tokens')
    .select('enabled')
    .eq('token', token)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    return jsonResponse({ error: '이 기기의 푸시 토큰이 아직 등록되지 않았습니다. 앱을 다시 실행해 주세요.' }, 404);
  }
  return jsonResponse({ enabled: data.enabled });
}

export async function handleSetPushPreference(request, supabaseAdmin) {
  const auth = await authenticateRequest(request, supabaseAdmin);
  if (auth.error) return auth.error;

  const body = await request.json();
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!token || token.length > 4096 || typeof body.enabled !== 'boolean') {
    return jsonResponse({ error: 'FCM 토큰 또는 알림 설정이 올바르지 않습니다.' }, 400);
  }

  const { data, error } = await supabaseAdmin
    .from('push_tokens')
    .update({ enabled: body.enabled, updated_at: new Date().toISOString() })
    .eq('token', token)
    .eq('user_id', auth.user.id)
    .select('enabled')
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    return jsonResponse({ error: '이 기기의 푸시 토큰이 아직 등록되지 않았습니다. 앱을 다시 실행해 주세요.' }, 404);
  }

  return jsonResponse({ success: true, enabled: data.enabled });
}

export async function handleListNotifications(request, supabaseAdmin) {
  const auth = await authenticateRequest(request, supabaseAdmin);
  if (auth.error) return auth.error;

  const { data: notifications, error } = await supabaseAdmin
    .from('notifications')
    .select('id, title, body, type, created_at, read_at')
    .eq('user_id', auth.user.id)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;

  const { count, error: countError } = await supabaseAdmin
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', auth.user.id)
    .is('read_at', null);
  if (countError) throw countError;

  return jsonResponse({ notifications, unreadCount: count || 0 });
}

export async function handleMarkNotificationRead(request, supabaseAdmin, notificationId) {
  const auth = await authenticateRequest(request, supabaseAdmin);
  if (auth.error) return auth.error;

  const { data, error } = await supabaseAdmin
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', notificationId)
    .eq('user_id', auth.user.id)
    .is('read_at', null)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const { data: existing, error: lookupError } = await supabaseAdmin
      .from('notifications')
      .select('id')
      .eq('id', notificationId)
      .eq('user_id', auth.user.id)
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (!existing) return jsonResponse({ error: '알림을 찾을 수 없습니다.' }, 404);
  }

  return jsonResponse({ success: true });
}

export async function handleMarkAllNotificationsRead(request, supabaseAdmin) {
  const auth = await authenticateRequest(request, supabaseAdmin);
  if (auth.error) return auth.error;

  const { error } = await supabaseAdmin
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('user_id', auth.user.id)
    .is('read_at', null);
  if (error) throw error;

  return jsonResponse({ success: true });
}

export async function handleDeleteNotification(request, supabaseAdmin, notificationId) {
  const auth = await authenticateRequest(request, supabaseAdmin);
  if (auth.error) return auth.error;

  const { data, error } = await supabaseAdmin
    .from('notifications')
    .delete()
    .eq('id', notificationId)
    .eq('user_id', auth.user.id)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) return jsonResponse({ error: '알림을 찾을 수 없습니다.' }, 404);

  return jsonResponse({ success: true });
}

export async function handleDeleteAllNotifications(request, supabaseAdmin) {
  const auth = await authenticateRequest(request, supabaseAdmin);
  if (auth.error) return auth.error;

  const { error } = await supabaseAdmin
    .from('notifications')
    .delete()
    .eq('user_id', auth.user.id);
  if (error) throw error;

  return jsonResponse({ success: true });
}

export async function handleBroadcastPush(request, supabaseAdmin, env) {
  const auth = await authenticateRequest(request, supabaseAdmin);
  if (auth.error) return auth.error;
  if (auth.profile.role !== 'admin') {
    return jsonResponse({ error: '관리자만 전체 알림을 보낼 수 있습니다.' }, 403);
  }

  const body = await request.json();
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const message = typeof body.body === 'string' ? body.body.trim() : '';
  if (!title || !message || title.length > 80 || message.length > 500) {
    return jsonResponse({ error: '제목(1~80자)과 내용(1~500자)을 입력해 주세요.' }, 400);
  }

  const senderName = auth.profile.name || auth.profile.username || '관리자';
  const result = await sendPushToAll(supabaseAdmin, env, {
    title,
    body: `${senderName} 님: ${message}`,
    type: 'admin_broadcast'
  });
  return jsonResponse({ success: true, ...result });
}

export function schedulePush(context, supabaseAdmin, env, notification) {
  context.waitUntil(
    sendPushToAll(supabaseAdmin, env, notification)
      .then(result => console.log('FCM 발송 결과:', notification.type, result))
      .catch(error => console.error('FCM 발송 오류:', error.message))
  );
}

export function schedulePushToUsers(context, supabaseAdmin, env, userIds, notification) {
  context.waitUntil(
    sendPushToUsers(supabaseAdmin, env, userIds, notification)
      .then(result => console.log('FCM 대상 발송 결과:', notification.type, result))
      .catch(error => console.error('FCM 대상 발송 오류:', error.message))
  );
}

export { jsonResponse };
