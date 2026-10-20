import { authenticateRequest, jsonResponse, schedulePushToUsers } from './push.js';

const REQUEST_FIELDS = 'id, user_id, username, item_name, quantity, specification, reason, example_url, status, review_note, reviewed_by, reviewed_at, created_at, updated_at';
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseExampleUrl(value) {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

async function notifyUsers(supabaseAdmin, userIds, title, body, type) {
  if (userIds.length === 0) return '';
  const { error } = await supabaseAdmin
    .from('notifications')
    .insert(userIds.map(userId => ({ user_id: userId, title, body, type })));
  return error;
}

export async function handleListItemRequests(request, supabaseAdmin) {
  try {
    const auth = await authenticateRequest(request, supabaseAdmin);
    if (auth.error) return auth.error;

    let query = supabaseAdmin
      .from('item_requests')
      .select(REQUEST_FIELDS)
      .order('created_at', { ascending: false })
      .limit(500);
    if (auth.profile.role !== 'admin') query = query.eq('user_id', auth.user.id);

    const { data, error } = await query;
    if (error) throw error;
    return jsonResponse(data || []);
  } catch (error) {
    console.error('물품 신청 목록 조회 오류:', error);
    return jsonResponse({ error: error.message || '물품 신청 목록을 불러오지 못했습니다.' }, 500);
  }
}

export async function handleCreateItemRequest(request, supabaseAdmin, env, context) {
  try {
    const auth = await authenticateRequest(request, supabaseAdmin);
    if (auth.error) return auth.error;

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: '신청 내용이 올바른 JSON이 아닙니다.' }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return jsonResponse({ error: '물품 신청 내용을 입력해 주세요.' }, 400);
    }

    const itemName = typeof body.item_name === 'string' ? body.item_name.trim() : '';
    const quantity = Number(body.quantity);
    const specification = typeof body.specification === 'string' ? body.specification.trim() : '';
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    const exampleUrl = parseExampleUrl(typeof body.example_url === 'string' ? body.example_url.trim() : '');
    if (!itemName || itemName.length > 100) return jsonResponse({ error: '물품명은 1~100자로 입력해 주세요.' }, 400);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) {
      return jsonResponse({ error: '수량은 1~9999 사이의 정수로 입력해 주세요.' }, 400);
    }
    if (specification.length > 500) return jsonResponse({ error: '규격은 500자 이내로 입력해 주세요.' }, 400);
    if (reason.length > 1000) return jsonResponse({ error: '신청 사유는 1000자 이내로 입력해 주세요.' }, 400);
    if (exampleUrl === null) return jsonResponse({ error: '예시 링크는 http 또는 https 주소로 입력해 주세요.' }, 400);

    const { data, error } = await supabaseAdmin
      .from('item_requests')
      .insert({
        user_id: auth.user.id,
        username: auth.profile.name || auth.profile.username || '회원',
        item_name: itemName,
        quantity,
        specification,
        reason,
        example_url: exampleUrl
      })
      .select(REQUEST_FIELDS)
      .single();
    if (error) throw error;

    let notificationWarning = '';
    let adminUserIds = [];
    try {
      const { data: admins, error: adminsError } = await supabaseAdmin
        .from('users')
        .select('id')
        .eq('role', 'admin');
      if (adminsError) throw adminsError;
      adminUserIds = (admins || []).map(admin => admin.id);
      const notificationError = await notifyUsers(
        supabaseAdmin,
        adminUserIds,
        '새 물품 신청',
        `${data.username} 님이 ${data.item_name} ${data.quantity}개를 신청했습니다.`,
        'item_request'
      );
      if (notificationError) throw notificationError;
    } catch (notificationError) {
      console.error('물품 신청 등록 후 관리자 알림 전송 오류:', notificationError);
      notificationWarning = '신청은 등록됐지만 관리자 알림 전송에 실패했습니다.';
    }

    if (adminUserIds.length > 0) {
      schedulePushToUsers(context, supabaseAdmin, env, adminUserIds, {
        title: '새 물품 신청',
        body: `${data.username} 님이 ${data.item_name} ${data.quantity}개를 신청했습니다.`,
        type: 'item_request'
      });
    }

    return jsonResponse({ success: true, request: data, notificationWarning }, 201);
  } catch (error) {
    console.error('물품 신청 등록 오류:', error);
    return jsonResponse({ error: error.message || '물품 신청을 등록하지 못했습니다.' }, 500);
  }
}

export async function handleReviewItemRequest(request, supabaseAdmin, requestId) {
  try {
    const auth = await authenticateRequest(request, supabaseAdmin);
    if (auth.error) return auth.error;
    if (auth.profile.role !== 'admin') return jsonResponse({ error: '관리자만 신청을 승인 또는 반려할 수 있습니다.' }, 403);
    if (!REQUEST_ID_PATTERN.test(requestId || '')) return jsonResponse({ error: '신청 ID가 올바르지 않습니다.' }, 400);

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: '검토 내용이 올바른 JSON이 아닙니다.' }, 400);
    }
    const status = body?.status;
    const reviewNote = typeof body?.review_note === 'string' ? body.review_note.trim() : '';
    if (!['approved', 'rejected'].includes(status)) {
      return jsonResponse({ error: '승인 또는 반려 상태를 선택해 주세요.' }, 400);
    }
    if (reviewNote.length > 1000) return jsonResponse({ error: '관리자 메모는 1000자 이내로 입력해 주세요.' }, 400);

    const { data, error } = await supabaseAdmin
      .from('item_requests')
      .update({
        status,
        review_note: reviewNote,
        reviewed_by: auth.user.id,
        reviewed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', requestId)
      .eq('status', 'pending')
      .select(REQUEST_FIELDS)
      .maybeSingle();
    if (error) throw error;
    if (!data) return jsonResponse({ error: '대기 중인 신청을 찾을 수 없습니다. 이미 처리되었는지 새로고침해 주세요.' }, 409);

    let notificationWarning = '';
    const reviewerName = auth.profile.name || auth.profile.username || '관리자';
    try {
      const notificationError = await notifyUsers(
        supabaseAdmin,
        [data.user_id],
        status === 'approved' ? '물품 신청 승인' : '물품 신청 반려',
        `${data.item_name} 신청이 ${status === 'approved' ? '승인' : '반려'}되었습니다.${reviewNote ? ` 메모: ${reviewNote}` : ''} (${reviewerName})`,
        'item_request_review'
      );
      if (notificationError) throw notificationError;
    } catch (notificationError) {
      console.error('물품 신청 처리 후 신청자 알림 전송 오류:', notificationError);
      notificationWarning = '신청 처리는 완료됐지만 신청자 알림 전송에 실패했습니다.';
    }
    return jsonResponse({ success: true, request: data, notificationWarning });
  } catch (error) {
    console.error('물품 신청 검토 오류:', error);
    return jsonResponse({ error: error.message || '물품 신청을 처리하지 못했습니다.' }, 500);
  }
}
