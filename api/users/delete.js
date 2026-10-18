export async function handleDeleteUser(request, supabaseAdmin) {
  try {
    const url = new URL(request.url);
    const userId = url.pathname.split('/').pop(); // URL에서 userId 추출 (예: /api/users/delete/:id)
    // 또는 body로 받을 수도 있음: const { userId } = await request.json();

    if (!userId) {
      return new Response(JSON.stringify({ error: '삭제할 회원 ID가 없습니다.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 1. Supabase Auth 관리자 API를 통해 Auth 계정 완전 삭제
    const { error: authDeleteError } = await supabaseAdmin.auth.admin.deleteUser(userId);

    if (authDeleteError) {
      console.error('Auth 삭제 오류:', authDeleteError.message);
      // Auth에 이미 없거나 에러가 나더라도 users 테이블 삭제는 진행할 수 있도록 넘어갈 수 있음
    }

    // 2. users 테이블에서 해당 프로필 정보 삭제
    const { error: dbDeleteError } = await supabaseAdmin
      .from('users')
      .delete()
      .eq('id', userId);

    if (dbDeleteError) {
      return new Response(JSON.stringify({ error: dbDeleteError.message }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    return new Response(JSON.stringify({ success: true, message: '회원이 완전히 삭제되었습니다.' }), {
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