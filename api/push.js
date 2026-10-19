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

  const registrations = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabaseAdmin
      .from('push_tokens')
      .select('token')
      .range(offset, offset + 999);
    if (error) throw error;
    registrations.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  if (registrations.length === 0) return { sent: 0, failed: 0 };

  const accessToken = await getFcmAccessToken(serviceAccount);
  let sent = 0;
  let failed = 0;

  for (let offset = 0; offset < registrations.length; offset += 25) {
    const batch = registrations.slice(offset, offset + 25);
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
    .select('id, name, username, role')
    .eq('id', data.user.id)
    .maybeSingle();
  if (profileError) throw profileError;
  if (!profile) {
    return { error: jsonResponse({ error: '사용자 프로필을 찾을 수 없습니다.' }, 403) };
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

  const { error } = await supabaseAdmin
    .from('push_tokens')
    .upsert({
      token,
      user_id: auth.user.id,
      platform: 'android',
      updated_at: new Date().toISOString()
    }, { onConflict: 'token' });
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

  const result = await sendPushToAll(supabaseAdmin, env, {
    title,
    body: message,
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

export { jsonResponse };
