export async function handleCreateUser(request, supabaseAdmin) {
  try {
    const body = await request.json();
    // 프론트엔드에서 전달받은 이름, 비밀번호 등의 정보
    const { username, name, password, role, contract_type, work_location, hire_date, annual_base_date, phone } = body;

    if (!password) {
      return new Response(JSON.stringify({ error: '비밀번호는 필수 입력 항목입니다.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 실제 사람 이름 (username으로 넘어온 값이 있으면 우선 사용, 없으면 name 사용)
    const realUserName = username || name || '이름 없음';

    // 1. 기존 users 테이블 수 카운트하여 순차 번호(0, 1, 2...) 생성
    const { count, error: countError } = await supabaseAdmin
      .from('users')
      .select('*', { count: 'exact', head: true });

    if (countError) throw countError;

    const nextIndex = count !== null ? count : 0;
    const virtualEmail = `${nextIndex}@jsec.com`; // 예: 1@jsec.com

    // 2. Supabase Auth 계정 생성 (1@jsec.com)
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

    const userId = authData.user.id; // 생성된 Auth의 UUID

    // 3. users 테이블에 프로필 저장
    // ★ username과 name에 실제 사람 이름('황치웅')이 그대로 저장됩니다!
    const { error: insertError } = await supabaseAdmin
      .from('users')
      .insert([{
        id: userId,                   // Auth UID 매핑
        username: realUserName,       // '황치웅'
        name: realUserName,           // '황치웅'
        email: virtualEmail,          // '1@jsec.com'
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