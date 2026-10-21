import { authenticateRequest, jsonResponse } from '../push.js';

export async function handleListUsers(request, supabaseAdmin) {
  try {
    const auth = await authenticateRequest(request, supabaseAdmin);
    if (auth.error) return auth.error;

    const { data, error } = await supabaseAdmin
      .from('users')
      .select('id, username, name, role, job_title, contract_type, work_location, hire_date, annual_base_date, phone, color, status, resignation_reason')
      .order('name', { ascending: true });

    if (error) throw error;
    return jsonResponse(data || []);
  } catch (err) {
    console.error('회원 목록 조회 오류:', err);
    return jsonResponse({ error: err.message || '서버 오류 발생' }, 500);
  }
}