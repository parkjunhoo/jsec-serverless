export async function handleCreateUser(request, supabaseAdmin) {
  try {
    const body = await request.json();
    const { username, name, password, role, contract_type, work_location, hire_date, annual_base_date, phone } = body;

    if (!username || !password) {
      return new Response(JSON.stringify({ error: '이름과 비밀번호는 필수 입력 항목입니다.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const virtualEmail = `${username}@jsec.com`;

    // 1. Supabase Auth 계정 생성
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: virtualEmail,
      password: password,
      email_confirm: true
    });

    if (authError) {
      return new Response(JSON.stringify({ error: authError.message }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const userId = authData.user.id;

    // 2. users 테이블에 프로필 정보 삽입
    const { error: insertError } = await supabaseAdmin
      .from('users')
      .insert([{
        id: userId,
        username: username,
        name: name || username,
        email: virtualEmail,
        role: role || 'user',
        contract_type: contract_type || '정규직',
        work_location: work_location || '지산리조트',
        hire_date: hire_date || null,
        annual_base_date: annual_base_date || null,
        phone: phone || null,
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