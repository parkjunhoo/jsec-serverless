export async function handleLogin(request, supabaseAdmin) {
  try {
    const { username, password } = await request.json();

    if (!username || !password) {
      return new Response(JSON.stringify({ error: '이름과 비밀번호를 모두 입력해 주세요.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

// 1. users 테이블에서 username(아이디) 컬럼으로 사용자 프로필 조회
    const { data: userProfile, error: profileError } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('username', username) // 'name'을 'username'으로 변경!
      .maybeSingle();

    if (profileError) {
      console.error('Profile Fetch Error:', profileError);
      return new Response(JSON.stringify({ error: '데이터베이스 조회 중 오류가 발생했습니다.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    if (!userProfile || !userProfile.email) {
      return new Response(JSON.stringify({ error: '존재하지 않는 사용자입니다.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 2. Supabase Auth 로그인 처리
    const { data: authData, error: authError } = await supabaseAdmin.auth.signInWithPassword({
      email: userProfile.email,
      password: password
    });

    if (authError) {
      return new Response(JSON.stringify({ error: '비밀번호가 올바르지 않습니다.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    return new Response(JSON.stringify(authData), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });

  } catch (err) {
    console.error('Server Catch Error:', err);
    return new Response(JSON.stringify({ error: err.message || '서버 오류 발생' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}