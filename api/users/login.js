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

    // 1. users 테이블 조회
    const { data: userProfile, error: profileError } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('username', username)
      .maybeSingle();

    if (profileError) {
      // 💡 어떤 DB 에러인지 구체적으로 응답에 담아봅니다!
      return new Response(JSON.stringify({ error: `DB 조회 실패: ${profileError.message} (코드: ${profileError.code})` }), {
        status: 400,
        headers: corsHeaders
      });
    }

    if (!userProfile) {
      return new Response(JSON.stringify({ error: '존재하지 않는 사용자입니다.' }), {
        status: 400,
        headers: corsHeaders
      });
    }

    // email 컬럼이 테이블에 없다면 userProfile.email 대신 auth 이메일 규칙을 쓰거나 해야 합니다.
    const userEmail = userProfile.email || `${username}@jsec.com`;

    // 2. Supabase Auth 로그인 처리
    const { data: authData, error: authError } = await supabaseAdmin.auth.signInWithPassword({
      email: userEmail,
      password: password
    });

    if (authError) {
      return new Response(JSON.stringify({ error: `인증 실패: ${authError.message}` }), {
        status: 400,
        headers: corsHeaders
      });
    }

    return new Response(JSON.stringify(authData), {
      status: 200,
      headers: corsHeaders
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: `서버 내부 오류: ${err.message}` }), {
      status: 500,
      headers: corsHeaders
    });
  }
}