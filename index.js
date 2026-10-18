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
        // PostgREST ilike 문법은 와일드카드로 % 대신 *를 사용합니다.
        const queryUrl = `${supabaseUrl}/rest/v1/skicar_data?or=(number.ilike.*${keyword}*,full_number.ilike.*${keyword}*,name.ilike.*${keyword}*)`;
        
        const sbResponse = await fetch(queryUrl, {
          method: "GET",
          headers: {
            "apikey": supabaseKey,
            "Authorization": `Bearer ${supabaseKey}`,
            "Content-Type": "application/json",
          },
        });

        // Supabase가 에러를 뱉었을 경우를 대비한 예외 처리
        if (!sbResponse.ok) {
          const errText = await sbResponse.text();
          return new Response(JSON.stringify({ error: "Supabase Error", details: errText }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
          });
        }

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