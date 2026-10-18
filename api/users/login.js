export async function handleLogin(request, supabaseAdmin) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };

  try {
    const { username, password } = await request.json();

    if (!username || !password) {
      return new Response(JSON.stringify({ error: '이름과 비밀번호를 모두 입력해 주세요.' }), {
        status: 400,
        headers: corsHeaders
      });
    }

// 1. users 테이블에서 username으로 조회
    const { data: userProfile, error: profileError } = await supabaseAdmin
      .from('users')
      .select('email')
      .eq('username', username)
      .maybeSingle();

    if (profileError || !userProfile || !userProfile.email) {
      // 💡 어떤 아이디로 조회를 시도했는지 응답에 담아봅니다!
      return new Response(JSON.stringify({ error: `사용자 없음 (입력된 값: "${username}", 에러: ${profileError ? profileError.message : '데이터 없음'})` }), {
        status: 400,
        headers: corsHeaders
      });
    }

    // 2. 조회된 진짜 이메일(0@jsec.com)과 입력받은 비밀번호로 Supabase Auth 로그인
    const { data: authData, error: authError } = await supabaseAdmin.auth.signInWithPassword({
      email: userProfile.email,
      password: password
    });

    if (authError) {
      return new Response(JSON.stringify({ error: '비밀번호가 올바르지 않습니다.' }), {
        status: 400,
        headers: corsHeaders
      });
    }

    return new Response(JSON.stringify(authData), {
      status: 200,
      headers: corsHeaders
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: `서버 오류: ${err.message}` }), {
      status: 500,
      headers: corsHeaders
    });
  }
}