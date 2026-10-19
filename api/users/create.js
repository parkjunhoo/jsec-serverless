export async function handleCreateUser(request, supabaseAdmin) {
  try {
    const body = await request.json();
    const { username, name, password, role, contract_type, work_location, hire_date, annual_base_date, phone } = body;

    if (!password) {
      return new Response(JSON.stringify({ error: '비밀번호는 필수 입력 항목입니다.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const realUserName = username || name || '이름 없음';

    // 1. 기존 users 테이블 수 카운트하여 순차 번호(0, 1, 2...) 생성
    const { count, error: countError } = await supabaseAdmin
      .from('users')
      .select('*', { count: 'exact', head: true });

    if (countError) throw countError;

    const nextIndex = count !== null ? count : 0;
    const virtualEmail = `${nextIndex}@jsec.com`; // 예: 12@jsec.com

    // 💡 2. 관리자가 입력한 4자리 비밀번호 뒤에 'jsec'을 붙여서 6자리 이상으로 변환 (Supabase Auth 정책 대응)
    const securePassword = password.trim() + "jsec";

    // 3. Supabase Auth 계정 생성
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: virtualEmail,
      password: securePassword, // 변환된 안전한 비밀번호 사용
      email_confirm: true
    });

    if (authError) {
      return new Response(JSON.stringify({ error: authError.message }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const userId = authData.user.id; // 생성된 Auth의 UUID

    // 4. users 테이블에 프로필 저장
    const { error: insertError } = await supabaseAdmin
      .from('users')
      .insert([{
        id: userId,                      // Auth UID 매핑
        username: realUserName,          
        name: realUserName,              
        email: virtualEmail,             
        role: role || 'user',
        contract_type: contract_type || '정규직',
        work_location: work_location || '지산리조트',
        hire_date: hire_date || null,
        annual_base_date: annual_base_date || null,
        phone: phone || '',
        status: '재직'
      }]);

    if (insertError) {
      return new Response(JSON.stringify({ error: insertError.message }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    return new Response(JSON.stringify({ success: true, message: '회원이 성공적으로 등록되었습니다.' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || '서버 오류 발생' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}