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

    // Supabase Admin Client 초기화 (Service Role Key 사용)
    const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

    // 라우팅 분기
    if (url.pathname === '/api/login' && request.method === 'POST') {
      return handleLogin(request, supabaseAdmin);
    }

    if (url.pathname === '/api/users/create' && request.method === 'POST') {
      return handleCreateUser(request, supabaseAdmin);
    }

    if (url.pathname === '/api/users/list' && request.method === 'GET') {
      return handleListUsers(request, supabaseAdmin);
    }

    // 기본 404
    return new Response(JSON.stringify({ error: 'Not Found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
};