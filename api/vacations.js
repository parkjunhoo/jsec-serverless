// 1. 휴무 목록 조회 (GET /api/vacations?start=...&end=...)
export async function handleListVacations(request, supabaseAdmin) {
  try {
    const url = new URL(request.url);
    const start = url.searchParams.get('start');
    const end = url.searchParams.get('end');

    let query = supabaseAdmin.from('vacations').select('*').order('date', { ascending: true });

    if (start && end) {
      query = query.gte('date', start).lte('date', end);
    }

    const { data, error } = await query;
    if (error) throw error;

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}

// 2. 휴무 등록 (POST /api/vacations/create)
export async function handleCreateVacation(request, supabaseAdmin) {
  try {
    const body = await request.json();
    const { user_id, username, date, leave_type, time_detail, memo } = body;

    if (!user_id || !date || !leave_type) {
      return new Response(JSON.stringify({ error: '필수 입력 항목이 누락되었습니다.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const { error } = await supabaseAdmin
      .from('vacations')
      .insert([{ user_id, username, date, leave_type, time_detail, memo }]);

    if (error) throw error;

    return new Response(JSON.stringify({ success: true, message: '휴무가 등록되었습니다.' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}

// 3. 휴무 삭제 (DELETE /api/vacations/delete/:id)
export async function handleDeleteVacation(request, supabaseAdmin) {
  try {
    const url = new URL(request.url);
    const pathSegments = url.pathname.split('/');
    const vacationId = pathSegments[pathSegments.length - 1];

    if (!vacationId || vacationId === 'delete') {
      return new Response(JSON.stringify({ error: '삭제할 ID가 없습니다.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const { error } = await supabaseAdmin
      .from('vacations')
      .delete()
      .eq('id', vacationId);

    if (error) throw error;

    return new Response(JSON.stringify({ success: true, message: '휴무가 삭제되었습니다.' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}