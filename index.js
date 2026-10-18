export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // 서버 상태 확인
    if (url.pathname === "/") {
      return new Response(JSON.stringify({ message: "JSEC Serverless API Running OK!" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
      });
    }

    // 직원 차량 조회 API (/api/vehicles?keyword=검색어)
    if (url.pathname === "/api/vehicles" && request.method === "GET") {
      const keyword = url.searchParams.get("keyword") || "";

      const supabaseUrl = 'https://nihsmjfcriqeuflujrrh.supabase.co';
      const supabaseKey = 'sb_publishable_hM0gN_gaG4d86oT9k-laRg_KOmfqrn8';

      try {
        // skicar_data 테이블에서 number, full_number, 혹은 name에 검색어가 포함된 데이터 조회
        const queryUrl = `${supabaseUrl}/rest/v1/skicar_data?or=(number.ilike.%${keyword}%,full_number.ilike.%${keyword}%,name.ilike.%${keyword}%)`;
        
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

    return new Response(JSON.stringify({ error: "Not Found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
    });
  },
};