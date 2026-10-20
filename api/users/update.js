import { authenticateRequest, jsonResponse } from '../push.js';
import { hasLoginIdentifierConflict, validateUserFields } from './validation.js';

const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADMIN_FIELDS = new Set([
  'name',
  'role',
  'job_title',
  'contract_type',
  'status',
  'work_location',
  'hire_date',
  'annual_base_date',
  'phone',
  'color'
]);

export async function handleUpdateUser(request, supabaseAdmin, userId) {
  try {
    const auth = await authenticateRequest(request, supabaseAdmin);
    if (auth.error) return auth.error;

    if (!USER_ID_PATTERN.test(userId || '')) {
      return jsonResponse({ error: '수정할 회원 ID가 올바르지 않습니다.' }, 400);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: '요청 내용이 올바른 JSON이 아닙니다.' }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return jsonResponse({ error: '수정할 회원 정보가 필요합니다.' }, 400);
    }

    const isAdmin = auth.profile.role === 'admin';
    if (!isAdmin && (auth.user.id !== userId || Object.keys(body).some(key => key !== 'phone'))) {
      return jsonResponse({ error: '본인의 연락처만 수정할 수 있습니다.' }, 403);
    }

    const allowedFields = isAdmin ? ADMIN_FIELDS : new Set(['phone']);
    if (Object.keys(body).length === 0 || Object.keys(body).some(key => !allowedFields.has(key))) {
      return jsonResponse({ error: '수정할 수 없는 회원 정보가 포함되어 있습니다.' }, 400);
    }

    const fieldsToValidate = isAdmin ? body : { phone: body.phone };
    const validation = validateUserFields(fieldsToValidate);
    if (validation.error) return jsonResponse({ error: validation.error }, 400);
    const updateData = validation.values;

    if (isAdmin && Object.hasOwn(updateData, 'name') &&
        await hasLoginIdentifierConflict(supabaseAdmin, updateData.name, userId)) {
      return jsonResponse({ error: '이미 사용 중인 로그인 식별자와 중복되는 이름입니다.' }, 409);
    }

    const { data, error } = await supabaseAdmin
      .from('users')
      .update(updateData)
      .eq('id', userId)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) return jsonResponse({ error: '회원을 찾을 수 없습니다.' }, 404);

    return jsonResponse({ success: true });
  } catch (err) {
    console.error('회원 정보 수정 오류:', err);
    return jsonResponse({ error: err.message || '서버 오류가 발생했습니다.' }, 500);
  }
}
