import { authenticateRequest, jsonResponse } from '../push.js';

export async function handleDeleteUser(request, supabaseAdmin) {
  try {
    const auth = await authenticateRequest(request, supabaseAdmin);
    if (auth.error) return auth.error;
    if (auth.profile.role !== 'admin') {
      return jsonResponse({ error: '관리자만 회원을 삭제할 수 있습니다.' }, 403);
    }

    const url = new URL(request.url);
    const userId = url.pathname.split('/').pop();

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId || '')) {
      return jsonResponse({ error: '삭제할 회원 ID가 올바르지 않습니다.' }, 400);
    }

    const { error: authDeleteError } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (authDeleteError) {
      throw authDeleteError;
    }

    const { error: dbDeleteError } = await supabaseAdmin
      .from('users')
      .delete()
      .eq('id', userId);

    if (dbDeleteError) {
      throw dbDeleteError;
    }

    return jsonResponse({ success: true, message: '회원이 완전히 삭제되었습니다.' });

  } catch (err) {
    console.error('회원 삭제 오류:', err);
    return jsonResponse({ error: err.message || '서버 오류 발생' }, 500);
  }
}