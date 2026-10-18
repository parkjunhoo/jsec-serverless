export async function handleCreateUser(request, supabaseAdmin) {
  try {
    const body = await request.json();
    const { name, password, role, contract_type, work_location, hire_date, annual_base_date, phone } = body;

    if (!password) {
      return new Response(JSON.stringify({ error: '비밀번호는 필수 입력 항목입니다.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 1. 기존 users 테이블에서 데이터 개수나 가장 큰 순번을 확인하여 다음 순번 결정
    // 예: 현재 등록된 유저 수를 세서 다음 인덱스로 활용 (또는 고유 번호 부여)
    const { count, error: countError } = await supabaseAdmin
      .from('users')
      .select('*', { count: 'exact', head: true });

    if (countError) throw countError;

    // 순차 번호 부여 (0부터 시작: 0, 1, 2, 3...)
    const nextIndex = count !== null ? count : 0;
    const virtualEmail = `${nextIndex}@jsec.com`;
    const usernameString = `${nextIndex}`; // username을 '0', '1' 형태로 관리할 경우

    // 2. Supabase Auth 계정 생성 (0@jsec.com, 1@jsec.com ...)
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

    // 3. users 테이블에 프로필 정보 삽입 (Auth의 UUID와 매핑)
    const { error: insertError } = await supabaseAdmin
      .from('users')
      .insert([{
        id: userId,
        username: usernameString, // '0', '1', '2' 등 순차 ID
        name: name || `사용자${nextIndex}`, // 실제 성함 (예: 홍길동)
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