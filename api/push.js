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

const PUSH_SETTINGS_FIELDS = 'push_vacation_all, push_vacation_user_ids, push_admin_notifications, push_quiet_hours_enabled, push_quiet_hours_start, push_quiet_hours_end';

function isValidUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isValidTime(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function isInQuietHours(settings) {
  if (!settings?.push_quiet_hours_enabled) return false;
  const start = String(settings.push_quiet_hours_start || '').slice(0, 5);
  const end = String(settings.push_quiet_hours_end || '').slice(0, 5);
  if (!isValidTime(start) || !isValidTime(end)) return false;
  if (start === end) return true;
  const current = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(new Date());
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function allowsNotification(settings, notification) {
  if (notification.type === 'admin_broadcast' && (!settings || settings.push_admin_notifications === false)) return false;
  if (notification.type.startsWith('vacation_') && settings) {
    if (settings.push_vacation_all === false
      && !(notification.audience_user_ids || []).some(userId => (settings.push_vacation_user_ids || []).includes(userId))) return false;
  }
  if (notification.type.startsWith('vacation_') && !settings) return false;
  return true;
}

async function loadPushSettings(supabaseAdmin, userIds) {
  if (!userIds.length) return new Map();
  const { data, error } = await supabaseAdmin
    .from('user_settings')
    .select(`user_id, ${PUSH_SETTINGS_FIELDS}`)
    .in('user_id', userIds);
  if (error) throw error;
  return new Map((data || []).map(settings => [settings.user_id, settings]));
}

async function deleteExpiredNotifications(supabaseAdmin, userId = null) {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  let query = supabaseAdmin.from('notifications').delete().lt('created_at', cutoff);
  if (userId) query = query.eq('user_id', userId);
  const { error } = await query;
  if (error) throw error;
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
  const settingsByUser = await loadPushSettings(supabaseAdmin, uniqueUserIds);
  const allowedRegistrations = enabledRegistrations.filter(registration => {
    const settings = settingsByUser.get(registration.user_id);
    return allowsNotification(settings, notification) && !isInQuietHours(settings);
  });
  if (allowedRegistrations.length === 0) return { sent: 0, failed: 0 };
  const accessToken = await getFcmAccessToken(serviceAccount);
  let sent = 0;
  let failed = 0;

  for (let offset = 0; offset < allowedRegistrations.length; offset += 25) {
    const batch = allowedRegistrations.slice(offset, offset + 25);
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

  await deleteExpiredNotifications(supabaseAdmin);

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

  const settingsByUser = await loadPushSettings(supabaseAdmin, userIds);
  const eligibleUserIds = userIds.filter(userId => allowsNotification(settingsByUser.get(userId), notification));
  for (let offset = 0; offset < eligibleUserIds.length; offset += 500) {
    const { error } = await supabaseAdmin
      .from('notifications')
      .insert(eligibleUserIds.slice(offset, offset + 500).map(userId => ({
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
  const eligibleRegistrations = registrations.filter(registration => {
    const settings = settingsByUser.get(registration.user_id);
    return registration.enabled && eligibleUserIds.includes(registration.user_id) && !isInQuietHours(settings);
  });
  if (eligibleRegistrations.length === 0) return { sent: 0, failed: 0 };

  const accessToken = await getFcmAccessToken(serviceAccount);
  let sent = 0;
  let failed = 0;

  for (let offset = 0; offset < eligibleRegistrations.length; offset += 25) {
    const batch = eligibleRegistrations.slice(offset, offset + 25);
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
      enabled: existingToken
        ? existingToken.enabled
        : false,
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

export async function handleGetPushSettings(request, supabaseAdmin) {
  const auth = await authenticateRequest(request, supabaseAdmin);
  if (auth.error) return auth.error;
  const [{ data: settings, error: settingsError }, { data: members, error: membersError }] = await Promise.all([
    supabaseAdmin.from('user_settings').select(PUSH_SETTINGS_FIELDS).eq('user_id', auth.user.id).maybeSingle(),
    supabaseAdmin.from('users').select('id, name, username, role, status').not('status', 'eq', '퇴직').order('name', { ascending: true })
  ]);
  if (settingsError) throw settingsError;
  if (membersError) throw membersError;
  return jsonResponse({
    settings: settings || { push_vacation_all: false, push_vacation_user_ids: [], push_admin_notifications: false, push_quiet_hours_enabled: false, push_quiet_hours_start: '22:00:00', push_quiet_hours_end: '07:00:00' },
    members: (members || []).filter(member => !['guest', 'monitor'].includes(member.role))
  });
}

export async function handleSetPushSettings(request, supabaseAdmin) {
  const auth = await authenticateRequest(request, supabaseAdmin);
  if (auth.error) return auth.error;
  const body = await request.json().catch(() => ({}));
  const vacationAll = body.push_vacation_all === true;
  const vacationUserIds = Array.isArray(body.push_vacation_user_ids)
    ? [...new Set(body.push_vacation_user_ids)]
    : [];
  if (vacationUserIds.length > 500 || vacationUserIds.some(userId => !isValidUuid(userId))) {
    return jsonResponse({ error: '휴무 알림 대상이 올바르지 않습니다.' }, 400);
  }
  const quietEnabled = body.push_quiet_hours_enabled === true;
  const quietStart = body.push_quiet_hours_start || null;
  const quietEnd = body.push_quiet_hours_end || null;
  if (quietEnabled && (!isValidTime(quietStart) || !isValidTime(quietEnd))) {
    return jsonResponse({ error: '방해금지 시간은 HH:MM 형식으로 입력해 주세요.' }, 400);
  }
  if (vacationUserIds.length) {
    const { data: members, error } = await supabaseAdmin.from('users').select('id').in('id', vacationUserIds);
    if (error) throw error;
    if ((members || []).length !== vacationUserIds.length) return jsonResponse({ error: '휴무 알림 대상에 없는 회원이 포함되어 있습니다.' }, 400);
  }
  const { data, error } = await supabaseAdmin
    .from('user_settings')
    .upsert({
      user_id: auth.user.id,
      push_vacation_all: vacationAll,
      push_vacation_user_ids: vacationUserIds,
      push_admin_notifications: body.push_admin_notifications === true,
      push_quiet_hours_enabled: quietEnabled,
      push_quiet_hours_start: quietEnabled ? quietStart : null,
      push_quiet_hours_end: quietEnabled ? quietEnd : null,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' })
    .select(PUSH_SETTINGS_FIELDS)
    .single();
  if (error) throw error;
  return jsonResponse({ success: true, settings: data });
}

export async function handleListNotifications(request, supabaseAdmin) {
  const auth = await authenticateRequest(request, supabaseAdmin);
  if (auth.error) return auth.error;

  await deleteExpiredNotifications(supabaseAdmin, auth.user.id);

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
