import { createClient } from '@supabase/supabase-js';
import { handleLogin } from './api/users/login.js';
import { handleCreateUser } from './api/users/create.js';
import { handleListUsers } from './api/users/list.js';

// 1. 회원 삭제 핸들러 함수 직접 포함 (또는 별도 파일에서 import 하셔도 됩니다)
async function handleDeleteUser(request, supabaseAdmin) {
  try {
    const url = new URL(request.url);
    const pathSegments = url.pathname.split('/');
    const userId = pathSegments[pathSegments.length - 1]; // URL 마지막 경로의 UUID 추출

    if (!userId || userId === 'delete') {
      return new Response(JSON.stringify({ error: '삭제할 회원 ID가 지정되지 않았습니다.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 1. Supabase Auth 관리자 API를 통해 Auth 계정 완전 삭제
    const { error: authDeleteError } = await supabaseAdmin.auth.admin.deleteUser(userId);

    if (authDeleteError) {
      console.warn('Auth 삭제 경고 (이미 없거나 처리됨):', authDeleteError.message);
    }

    // 2. users 테이블에서 해당 프로필 정보 삭제
    const { error: dbDeleteError } = await supabaseAdmin
      .from('users')
      .delete()
      .eq('id', userId);

    if (dbDeleteError) {
      throw new Error(dbDeleteError.message);
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 공통 CORS 헤더 (DELETE 허용 포함)
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    
    // 1. 브라우저 OPTIONS Preflight 요청 처리
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    try {
      // Supabase Admin 클라이언트 생성 (환경변수 검증)
      if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error('Supabase 환경 변수(URL 또는 SERVICE_ROLE_KEY)가 설정되지 않았습니다.');
      }

      const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

      // 2. 로그인 라우팅
      if (url.pathname === '/api/login' && request.method === 'POST') {
        return await handleLogin(request, supabaseAdmin);
      }

      // 3. 회원 생성 라우팅
      if (url.pathname === '/api/users/create' && request.method === 'POST') {
        return await handleCreateUser(request, supabaseAdmin);
      }

      // 4. 회원 목록 라우팅
      if (url.pathname === '/api/users/list' && request.method === 'GET') {
        return await handleListUsers(request, supabaseAdmin);
      }

      // 5. 회원 삭제 라우팅 (경로가 /api/users/delete/ 로 시작하고 DELETE 요청인 경우)
      if (url.pathname.startsWith('/api/users/delete/') && request.method === 'DELETE') {
        return await handleDeleteUser(request, supabaseAdmin);
      }

      // 6. 휴무 관련 라우팅 분기
      if (url.pathname === '/api/vacations' && request.method === 'GET') {
        return await handleListVacations(request, supabaseAdmin);
      }
      if (url.pathname === '/api/vacations/create' && request.method === 'POST') {
        return await handleCreateVacation(request, supabaseAdmin);
      }
      if (url.pathname.startsWith('/api/vacations/delete/') && request.method === 'DELETE') {
        return await handleDeleteVacation(request, supabaseAdmin);
      }

      // 6. 404 경로 처리
      return new Response(JSON.stringify({ error: 'Not Found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });

    } catch (err) {
      console.error('Worker Top-Level Error:', err);
      return new Response(JSON.stringify({ error: `Worker 치명적 오류: ${err.message}` }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }
};