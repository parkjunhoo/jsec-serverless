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
    const rawPassword = body.password ? body.password.trim() : ''; // 사용자가 입력한 4자리 등

    if (!inputVal || !rawPassword) {
      return new Response(JSON.stringify({ error: '아이디(이름)와 비밀번호를 모두 입력해 주세요.' }), {
        status: 400,
        headers: corsHeaders
      });
    }

    // 1. 사용자 프로필 조회 (이름, username, email 모두 대응)
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

    // 💡 2. 사용자가 입력한 비밀번호가 4자리든 짧든, 
    // Supabase Auth 정책(6자리 이상)을 만족하도록 뒤에 고정 접미사를 붙여줍니다.
    // (예: 사용자가 "1234" 입력 -> "1234jsec"으로 변환하여 인증 시도)
    const securePassword = rawPassword + "jsec"; 

    // 3. Supabase Auth 로그인 처리
    const { data: authData, error: authError } = await supabaseAdmin.auth.signInWithPassword({
      email: userProfile.email,
      password: securePassword
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