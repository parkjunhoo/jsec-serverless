export async function handleLogin(request, supabaseAdmin) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };

  try {
    const body = await request.json();
    const inputVal = body.username ? body.username.trim() : '';
    const password = body.password;

    if (!inputVal || !password) {
      return new Response(JSON.stringify({ error: '아이디(이름)와 비밀번호를 모두 입력해 주세요.' }), {
        status: 400,
        headers: corsHeaders
      });
    }

    // 💡 name, username, email 중 사용자가 무엇을 입력했든 찾을 수 있도록 name.eq 추가!
    const { data: userProfile, error: profileError } = await supabaseAdmin
      .from('users')
      .select('email, username, name')
      .or(`username.eq.${inputVal},email.eq.${inputVal},name.eq.${inputVal}`)
      .maybeSingle();

    if (profileError || !userProfile || !userProfile.email) {
      return new Response(JSON.stringify({ error: `사용자를 찾을 수 없습니다. (입력값: "${inputVal}")` }), {
        status: 400,
        headers: corsHeaders
      });
    }

    // Supabase Auth 로그인 처리 (찾아낸 userProfile.email 사용)
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
    return new Response(JSON.stringify({ error: `서버 내부 오류: ${err.message}` }), {
      status: 500,
      headers: corsHeaders
    });
  }
}