export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS 설정 (웹뷰 앱이나 웹페이지에서 호출할 때 에러 안 나게 허용)
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // 1. 서버 정상 작동 확인용 (핑)
    if (url.pathname === "/") {
      return new Response(JSON.stringify({ message: "JSEC Serverless API Running OK!" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
      });
    }

    // 2. 직원 차량 조회 API (예시: /api/vehicles?carNumber=1234)
    if (url.pathname === "/api/vehicles" && request.method === "GET") {
      const carNumber = url.searchParams.get("carNumber") || "";

      // Supabase REST API 호출
      const supabaseUrl = env.SUPABASE_URL || 'https://nihsmjfcriqeuflujrrh.supabase.co';
      const supabaseKey = env.SUPABASE_ANON_KEY || 'sb_publishable_hM0gN_gaG4d86oT9k-laRg_KOmfqrn8';

      try {
        // Supabase의 'vehicles' 테이블에서 차량번호 검색
        const queryUrl = `${supabaseUrl}/rest/v1/vehicles?car_number=ilike.%${carNumber}%`;
        const sbResponse = await fetch(queryUrl, {
          method: "GET",
          headers: {
            "apikey": supabaseKey,
            "Authorization": `Bearer ${supabaseKey}`,
            "Content-Type": "application/json",
          },
        });

        const data = await sbResponse.json();

        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
        });
      }
    }

    // 404 처리
    return new Response(JSON.stringify({ error: "Not Found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
    });
  },
};