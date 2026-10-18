import { createClient } from '@supabase/supabase-js';
import { handleLogin } from './api/users/login.js';
import { handleCreateUser } from './api/users/create.js';
import { handleListUsers } from './api/users/list.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS Preflight 처리
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

    // 1. 로그인 API 라우팅 (여기 꼭 있어야 합니다!)
    if (url.pathname === '/api/login' && request.method === 'POST') {
      return handleLogin(request, supabaseAdmin);
    }

    // 2. 회원 등록 API 라우팅
    if (url.pathname === '/api/users/create' && request.method === 'POST') {
      return handleCreateUser(request, supabaseAdmin);
    }

    // 3. 회원 목록 조회 API 라우팅
    if (url.pathname === '/api/users/list' && request.method === 'GET') {
      return handleListUsers(request, supabaseAdmin);
    }

    return new Response(JSON.stringify({ error: 'Not Found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
};