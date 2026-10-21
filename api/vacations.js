import { authenticateRequest, jsonResponse, schedulePush } from './push.js';

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export async function handleListVacations(request, supabaseAdmin) {
  try {
    const auth = await authenticateRequest(request, supabaseAdmin);
    if (auth.error) return auth.error;

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
  if (auth.profile.role === 'guest' || auth.profile.role === 'monitor') {
    return { response: jsonResponse({ error: '게스트 계정은 휴무 일정을 변경할 수 없습니다.' }, 403) };
  }

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

function getHoursUsed(leaveType, timeDetail, value) {
  if (leaveType !== '시간차') return null;
  if (timeDetail !== '시간지정') return undefined;
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours < 0.25 || hours > 24) return undefined;
  return Math.round(hours * 100) / 100;
}

export async function handleCreateVacation(request, supabaseAdmin, env, context) {
  try {
    const auth = await authenticateRequest(request, supabaseAdmin);
    if (auth.error) return auth.error;
    if (auth.profile.role === 'guest' || auth.profile.role === 'monitor') {
      return jsonResponse({ error: '게스트 계정은 휴무 일정을 등록할 수 없습니다.' }, 403);
    }

    const body = await request.json();
    const date = typeof body.date === 'string' ? body.date : '';
    const leaveType = typeof body.leave_type === 'string' ? body.leave_type : '';
    if (!isValidDate(date) || !['휴무', '연차', '시간차', '공가'].includes(leaveType)) {
      return jsonResponse({ error: '휴무 날짜 또는 종류가 올바르지 않습니다.' }, 400);
    }
    const timeDetail = typeof body.time_detail === 'string' ? body.time_detail : '종일';
    if (!['종일', '시간지정'].includes(timeDetail)) {
      return jsonResponse({ error: '세부 시간이 올바르지 않습니다.' }, 400);
    }
    if (leaveType !== '시간차' && timeDetail !== '종일') {
      return jsonResponse({ error: '시간차 이외의 휴무는 종일로 등록해 주세요.' }, 400);
    }
    const hoursUsed = getHoursUsed(leaveType, timeDetail, body.hours_used);
    if (leaveType === '시간차' && hoursUsed === undefined) {
      return jsonResponse({ error: '시간차 사용 시간을 0.25~24시간 사이로 입력해 주세요.' }, 400);
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
      hours_used: hoursUsed,
      memo: typeof body.memo === 'string' ? body.memo.trim() : ''
    };
    const { data, error } = await supabaseAdmin
      .from('vacations')
      .insert([vacation])
      .select('*')
      .single();
    if (error) throw error;

    const creatorName = auth.profile.name || auth.profile.username || '사용자';
    const createDescription = auth.user.id === member.id
      ? `${creatorName} 님이 본인의`
      : `관리자 ${creatorName} 님이 ${vacation.username} 님의`;
    schedulePush(context, supabaseAdmin, env, {
      title: '휴무 일정 등록',
      body: `${createDescription} ${date} ${leaveType} 일정을 등록했습니다.`,
      type: 'vacation_create'
    });
    return jsonResponse({ success: true, vacation: data });
  } catch (error) {
    console.error('휴무 등록 오류:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}

export async function handleBulkCreateVacations(request, supabaseAdmin, env, context) {
  try {
    const auth = await authenticateRequest(request, supabaseAdmin);
    if (auth.error) return auth.error;
    if (auth.profile.role === 'guest' || auth.profile.role === 'monitor') {
      return jsonResponse({ error: '게스트 계정은 휴무 일정을 등록할 수 없습니다.' }, 403);
    }

    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return jsonResponse({ error: '요청 형식이 올바르지 않습니다.' }, 400);
    }
    const dates = body.dates;
    if (!Array.isArray(dates) || dates.length === 0 || dates.length > 31
      || dates.some(date => typeof date !== 'string' || !isValidDate(date))
      || new Set(dates).size !== dates.length
      || new Set(dates.map(date => date.slice(0, 7))).size !== 1) {
      return jsonResponse({ error: '같은 달의 서로 다른 날짜를 1~31개 선택해 주세요.' }, 400);
    }

    const userId = auth.profile.role === 'admin' && typeof body.user_id === 'string'
      ? body.user_id
      : auth.user.id;
    const member = await getTargetMember(supabaseAdmin, userId);
    if (!member) return jsonResponse({ error: '대상 팀원을 찾을 수 없습니다.' }, 404);

    const memo = typeof body.memo === 'string' ? body.memo.trim() : '';
    if (memo.length > 500) {
      return jsonResponse({ error: '비고는 500자 이하로 입력해 주세요.' }, 400);
    }

    const vacations = dates.map(date => ({
      user_id: member.id,
      username: member.name || member.username,
      date,
      leave_type: '휴무',
      time_detail: '종일',
      hours_used: null,
      memo
    }));
    const { data, error } = await supabaseAdmin
      .from('vacations')
      .insert(vacations)
      .select('*');
    if (error) throw error;

    const creatorName = auth.profile.name || auth.profile.username || '사용자';
    const createDescription = auth.user.id === member.id
      ? `${creatorName} 님이 본인의`
      : `관리자 ${creatorName} 님이 ${vacations[0].username} 님의`;
    schedulePush(context, supabaseAdmin, env, {
      title: '휴무 일정 일괄 등록',
      body: `${createDescription} 휴무 ${data.length}건을 등록했습니다.`,
      type: 'vacation_create'
    });
    return jsonResponse({ success: true, count: data.length, vacations: data });
  } catch (error) {
    console.error('휴무 일괄 등록 오류:', error);
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
    if (!isValidDate(date) || !['휴무', '연차', '시간차', '공가'].includes(leaveType)) {
      return jsonResponse({ error: '휴무 날짜 또는 종류가 올바르지 않습니다.' }, 400);
    }
    const timeDetail = typeof body.time_detail === 'string' ? body.time_detail : '종일';
    if (!['종일', '시간지정'].includes(timeDetail)) {
      return jsonResponse({ error: '세부 시간이 올바르지 않습니다.' }, 400);
    }
    if (leaveType !== '시간차' && timeDetail !== '종일') {
      return jsonResponse({ error: '시간차 이외의 휴무는 종일로 등록해 주세요.' }, 400);
    }
    const hoursUsed = getHoursUsed(leaveType, timeDetail, body.hours_used);
    if (leaveType === '시간차' && hoursUsed === undefined) {
      return jsonResponse({ error: '시간차 사용 시간을 0.25~24시간 사이로 입력해 주세요.' }, 400);
    }

    const update = {
      date,
      leave_type: leaveType,
      time_detail: timeDetail,
      hours_used: hoursUsed,
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

    const editorName = authorized.profile.name || authorized.profile.username || '사용자';
    const editDescription = authorized.user.id === authorized.vacation.user_id
      ? `${editorName} 님이 본인의`
      : `관리자 ${editorName} 님이 ${data.username} 님의`;
    schedulePush(context, supabaseAdmin, env, {
      title: '휴무 일정 수정',
      body: `${editDescription} ${authorized.vacation.date} ${authorized.vacation.leave_type} 일정을 ${date} ${leaveType}로 변경했습니다.`,
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

    const editorName = authorized.profile.name || authorized.profile.username || '사용자';
    const deleteDescription = authorized.user.id === authorized.vacation.user_id
      ? `${editorName} 님이 본인의`
      : `관리자 ${editorName} 님이 ${authorized.vacation.username} 님의`;
    schedulePush(context, supabaseAdmin, env, {
      title: '휴무 일정 삭제',
      body: `${deleteDescription} ${authorized.vacation.date} ${authorized.vacation.leave_type} 일정을 삭제했습니다.`,
      type: 'vacation_delete'
    });
    return jsonResponse({ success: true, message: '휴무가 삭제되었습니다.' });
  } catch (error) {
    console.error('휴무 삭제 오류:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}
