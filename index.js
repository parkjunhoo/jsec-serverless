import { createClient } from '@supabase/supabase-js';
import { handleLogin } from './api/users/login.js';
import { handleCreateUser } from './api/users/create.js';
import { handleListUsers } from './api/users/list.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 공통 CORS 헤더
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', // 👈 여기에 DELETE 반드시 추가!
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

      // 5. 404 경로 처리
      return new Response(JSON.stringify({ error: 'Not Found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });

    } catch (err) {
      console.error('Worker Top-Level Error:', err);
      // 최상위 예외 발생 시에도 CORS 헤더를 유지하면서 500 에러 응답 반환
      return new Response(JSON.stringify({ error: `Worker 치명적 오류: ${err.message}` }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }
};