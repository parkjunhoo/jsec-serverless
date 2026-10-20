import { authenticateRequest, jsonResponse } from '../push.js';
import { hasLoginIdentifierConflict, validateUserFields } from './validation.js';

export async function handleCreateUser(request, supabaseAdmin) {
  try {
    const auth = await authenticateRequest(request, supabaseAdmin);
    if (auth.error) return auth.error;
    if (auth.profile.role !== 'admin') {
      return jsonResponse({ error: '관리자만 회원을 등록할 수 있습니다.' }, 403);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: '요청 내용이 올바른 JSON이 아닙니다.' }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return jsonResponse({ error: '회원 정보를 입력해 주세요.' }, 400);
    }
    const { username, name, password, role, contract_type, work_location, hire_date, annual_base_date, phone, color } = body;

    if (typeof password !== 'string' || !password.trim()) {
      return jsonResponse({ error: '비밀번호는 필수 입력 항목입니다.' }, 400);
    }
    const realUserName = (typeof username === 'string' ? username : typeof name === 'string' ? name : '').trim();
    const validation = validateUserFields({
      name: realUserName,
      role: role === undefined ? 'user' : role,
      contract_type: contract_type === undefined ? '정규직' : contract_type,
      work_location: work_location === undefined ? '지산리조트' : work_location,
      hire_date: hire_date === undefined ? null : hire_date,
      annual_base_date: annual_base_date === undefined ? null : annual_base_date,
      phone: phone === undefined ? '' : phone,
      color: color === undefined ? '#38bdf8' : color
    });
    if (validation.error) return jsonResponse({ error: validation.error }, 400);
    const profile = validation.values;

    if (await hasLoginIdentifierConflict(supabaseAdmin, profile.name)) {
      return jsonResponse({ error: '이미 사용 중인 로그인 식별자와 중복되는 이름입니다.' }, 409);
    }

    const { data: profiles, error: profilesError } = await supabaseAdmin
      .from('users')
      .select('email');
    if (profilesError) throw profilesError;
    const usedEmails = new Set((profiles || []).map(profile => profile.email));
    let nextIndex = 0;
    while (usedEmails.has(`${nextIndex}@jsec.com`)) nextIndex += 1;
    const virtualEmail = `${nextIndex}@jsec.com`; // 예: 12@jsec.com

    // 💡 2. 관리자가 입력한 4자리 비밀번호 뒤에 'jsec'을 붙여서 6자리 이상으로 변환 (Supabase Auth 정책 대응)
    const securePassword = password.trim() + 'jsec';

    // 3. Supabase Auth 계정 생성
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: virtualEmail,
      password: securePassword, // 변환된 안전한 비밀번호 사용
      email_confirm: true
    });

    if (authError) {
      return jsonResponse({ error: authError.message }, 400);
    }

    const userId = authData.user.id; // 생성된 Auth의 UUID
    const jobTitle = realUserName === '지은석'
      ? '소장'
      : realUserName === '김동석'
        ? '부소장'
        : '사원';

    // 4. users 테이블에 프로필 저장
    const { error: insertError } = await supabaseAdmin
      .from('users')
      .insert([{
        id: userId,                      // Auth UID 매핑
        username: profile.name,
        name: profile.name,
        email: virtualEmail,
        role: profile.role,
        job_title: jobTitle,
        contract_type: profile.contract_type,
        work_location: profile.work_location,
        hire_date: profile.hire_date,
        annual_base_date: profile.annual_base_date,
        phone: profile.phone,
        color: profile.color,
        status: '재직'
      }]);

    if (insertError) {
      const { error: rollbackError } = await supabaseAdmin.auth.admin.deleteUser(userId);
      if (rollbackError) {
        console.error('프로필 저장 실패 후 Auth 계정 정리 오류:', rollbackError);
        return jsonResponse({
          error: `회원 프로필 저장에 실패했고 Auth 계정 정리도 실패했습니다. 관리자에게 문의해 주세요. (${insertError.message})`
        }, 500);
      }
      return jsonResponse({ error: insertError.message }, 400);
    }

    return jsonResponse({ success: true, message: '회원이 성공적으로 등록되었습니다.' });

  } catch (err) {
    console.error('회원 등록 오류:', err);
    return jsonResponse({ error: err.message || '서버 오류 발생' }, 500);
  }
}