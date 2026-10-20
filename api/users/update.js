import { authenticateRequest, jsonResponse } from '../push.js';

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

function isValidDate(value) {
  if (value === null || value === '') return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

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

    const updateData = {};
    if (Object.hasOwn(body, 'phone')) {
      if (typeof body.phone !== 'string' || body.phone.length > 40) {
        return jsonResponse({ error: '연락처는 40자 이내로 입력해 주세요.' }, 400);
      }
      updateData.phone = body.phone.trim();
    }

    if (isAdmin) {
      if (Object.hasOwn(body, 'name')) {
        if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 100) {
          return jsonResponse({ error: '이름은 1~100자 이내로 입력해 주세요.' }, 400);
        }
        updateData.name = body.name.trim();
      }
      if (Object.hasOwn(body, 'role')) {
        if (!['user', 'admin'].includes(body.role)) {
          return jsonResponse({ error: '사용자 권한 값이 올바르지 않습니다.' }, 400);
        }
        updateData.role = body.role;
      }
      if (Object.hasOwn(body, 'job_title')) {
        if (!['소장', '부소장', '사원'].includes(body.job_title)) {
          return jsonResponse({ error: '직책 값이 올바르지 않습니다.' }, 400);
        }
        updateData.job_title = body.job_title;
      }
      if (Object.hasOwn(body, 'contract_type')) {
        if (!['정규직', '계약직', '아르바이트'].includes(body.contract_type)) {
          return jsonResponse({ error: '계약 형태 값이 올바르지 않습니다.' }, 400);
        }
        updateData.contract_type = body.contract_type;
      }
      if (Object.hasOwn(body, 'status')) {
        if (!['재직', '퇴직'].includes(body.status)) {
          return jsonResponse({ error: '재직 상태 값이 올바르지 않습니다.' }, 400);
        }
        updateData.status = body.status;
      }
      if (Object.hasOwn(body, 'work_location')) {
        if (typeof body.work_location !== 'string' || !body.work_location.trim() || body.work_location.trim().length > 100) {
          return jsonResponse({ error: '근무지는 1~100자 이내로 입력해 주세요.' }, 400);
        }
        updateData.work_location = body.work_location.trim();
      }
      for (const field of ['hire_date', 'annual_base_date']) {
        if (Object.hasOwn(body, field)) {
          if (!isValidDate(body[field])) {
            return jsonResponse({ error: `${field === 'hire_date' ? '입사일' : '연차 기준일'}이 올바르지 않습니다.` }, 400);
          }
          updateData[field] = body[field] || null;
        }
      }
      if (Object.hasOwn(body, 'color')) {
        if (typeof body.color !== 'string' || !/^#[\da-f]{6}$/i.test(body.color)) {
          return jsonResponse({ error: '사용자 색상 값이 올바르지 않습니다.' }, 400);
        }
        updateData.color = body.color;
      }
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
