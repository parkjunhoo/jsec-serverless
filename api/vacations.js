import { authenticateRequest, jsonResponse, schedulePush } from './push.js';

export async function handleListVacations(request, supabaseAdmin) {
  try {
    const url = new URL(request.url);
    const start = url.searchParams.get('start');
    const end = url.searchParams.get('end');

    let query = supabaseAdmin.from('vacations').select('*').order('date', { ascending: true });
    if (start && end) query = query.gte('date', start).lte('date', end);

    const { data, error } = await query;
    if (error) throw error;
    return jsonResponse(data);
  } catch (error) {
    console.error('휴무 목록 조회 오류:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}

async function getTargetMember(supabaseAdmin, userId) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, name, username')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getVacationForAuthorizedUser(request, supabaseAdmin, vacationId) {
  const auth = await authenticateRequest(request, supabaseAdmin);
  if (auth.error) return auth;

  const { data: vacation, error } = await supabaseAdmin
    .from('vacations')
    .select('*')
    .eq('id', vacationId)
    .maybeSingle();
  if (error) throw error;
  if (!vacation) return { response: jsonResponse({ error: '휴무 일정을 찾을 수 없습니다.' }, 404) };
  if (vacation.user_id !== auth.user.id && auth.profile.role !== 'admin') {
    return { response: jsonResponse({ error: '수정 또는 삭제 권한이 없습니다.' }, 403) };
  }

  return { ...auth, vacation };
}

export async function handleCreateVacation(request, supabaseAdmin, env, context) {
  try {
    const auth = await authenticateRequest(request, supabaseAdmin);
    if (auth.error) return auth.error;

    const body = await request.json();
    const date = typeof body.date === 'string' ? body.date : '';
    const leaveType = typeof body.leave_type === 'string' ? body.leave_type : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !['휴무', '연차', '시간차'].includes(leaveType)) {
      return jsonResponse({ error: '휴무 날짜 또는 종류가 올바르지 않습니다.' }, 400);
    }
    const timeDetail = typeof body.time_detail === 'string' ? body.time_detail : '종일';
    if (!['종일', '오전반차', '오후반차', '시간지정'].includes(timeDetail)) {
      return jsonResponse({ error: '세부 시간이 올바르지 않습니다.' }, 400);
    }

    const userId = auth.profile.role === 'admin' && body.user_id
      ? body.user_id
      : auth.user.id;
    const member = await getTargetMember(supabaseAdmin, userId);
    if (!member) return jsonResponse({ error: '대상 팀원을 찾을 수 없습니다.' }, 404);

    const vacation = {
      user_id: member.id,
      username: member.name || member.username,
      date,
      leave_type: leaveType,
      time_detail: timeDetail,
      memo: typeof body.memo === 'string' ? body.memo.trim() : ''
    };
    const { data, error } = await supabaseAdmin
      .from('vacations')
      .insert([vacation])
      .select('*')
      .single();
    if (error) throw error;

    schedulePush(context, supabaseAdmin, env, {
      title: '휴무 일정 등록',
      body: `${vacation.username} 님의 ${date} ${leaveType} 일정이 등록되었습니다.`,
      type: 'vacation_create'
    });
    return jsonResponse({ success: true, vacation: data });
  } catch (error) {
    console.error('휴무 등록 오류:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}

export async function handleUpdateVacation(request, supabaseAdmin, env, context, vacationId) {
  try {
    const authorized = await getVacationForAuthorizedUser(request, supabaseAdmin, vacationId);
    if (authorized.error) return authorized.error;
    if (authorized.response) return authorized.response;

    const body = await request.json();
    const date = typeof body.date === 'string' ? body.date : '';
    const leaveType = typeof body.leave_type === 'string' ? body.leave_type : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !['휴무', '연차', '시간차'].includes(leaveType)) {
      return jsonResponse({ error: '휴무 날짜 또는 종류가 올바르지 않습니다.' }, 400);
    }
    const timeDetail = typeof body.time_detail === 'string' ? body.time_detail : '종일';
    if (!['종일', '오전반차', '오후반차', '시간지정'].includes(timeDetail)) {
      return jsonResponse({ error: '세부 시간이 올바르지 않습니다.' }, 400);
    }

    const update = {
      date,
      leave_type: leaveType,
      time_detail: timeDetail,
      memo: typeof body.memo === 'string' ? body.memo.trim() : ''
    };

    if (authorized.profile.role === 'admin' && body.user_id) {
      const member = await getTargetMember(supabaseAdmin, body.user_id);
      if (!member) return jsonResponse({ error: '대상 팀원을 찾을 수 없습니다.' }, 404);
      update.user_id = member.id;
      update.username = member.name || member.username;
    }

    const { data, error } = await supabaseAdmin
      .from('vacations')
      .update(update)
      .eq('id', vacationId)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) return jsonResponse({ error: '휴무 일정이 수정되지 않았습니다.' }, 409);

    schedulePush(context, supabaseAdmin, env, {
      title: '휴무 일정 수정',
      body: `${data.username} 님의 ${date} ${leaveType} 일정이 수정되었습니다.`,
      type: 'vacation_update'
    });
    return jsonResponse({ success: true, vacation: data });
  } catch (error) {
    console.error('휴무 수정 오류:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}

export async function handleDeleteVacation(request, supabaseAdmin, env, context, vacationId) {
  try {
    const authorized = await getVacationForAuthorizedUser(request, supabaseAdmin, vacationId);
    if (authorized.error) return authorized.error;
    if (authorized.response) return authorized.response;

    const { error } = await supabaseAdmin
      .from('vacations')
      .delete()
      .eq('id', vacationId);
    if (error) throw error;

    schedulePush(context, supabaseAdmin, env, {
      title: '휴무 일정 삭제',
      body: `${authorized.vacation.username} 님의 ${authorized.vacation.date} 일정이 삭제되었습니다.`,
      type: 'vacation_delete'
    });
    return jsonResponse({ success: true, message: '휴무가 삭제되었습니다.' });
  } catch (error) {
    console.error('휴무 삭제 오류:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}
