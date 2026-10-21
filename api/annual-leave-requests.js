import { authenticateRequest, jsonResponse, schedulePushToUsers } from './push.js';

const REQUEST_FIELDS = 'id, user_id, username, department, leave_type, start_date, start_time, end_date, end_time, total_days, hours_used, details, status, review_note, reviewed_by, reviewed_at, created_at, updated_at';
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{2}:\d{2}$/;

function isValidDate(value) {
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function countWeekdays(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  let count = 0;
  for (let date = start; date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6) count += 1;
  }
  return count;
}

async function notifyUsers(supabaseAdmin, userIds, title, body, type) {
  if (userIds.length === 0) return null;
  const { error } = await supabaseAdmin
    .from('notifications')
    .insert(userIds.map(userId => ({ user_id: userId, title, body, type })));
  return error;
}

export async function handleListAnnualLeaveRequests(request, supabaseAdmin) {
  try {
    const auth = await authenticateRequest(request, supabaseAdmin);
    if (auth.error) return auth.error;
    if (auth.profile.role === 'guest' || auth.profile.role === 'monitor') {
      return jsonResponse({ error: '연차 신청 내역을 조회할 권한이 없습니다.' }, 403);
    }

    let query = supabaseAdmin
      .from('annual_leave_requests')
      .select(REQUEST_FIELDS)
      .order('created_at', { ascending: false })
      .limit(500);
    if (auth.profile.role !== 'admin') {
      query = query.eq('user_id', auth.user.id);
    }

    const { data, error } = await query;
    if (error) throw error;
    return jsonResponse(data || []);
  } catch (error) {
    console.error('연차 신청 목록 조회 오류:', error);
    return jsonResponse({ error: error.message || '연차 신청 목록을 불러오지 못했습니다.' }, 500);
  }
}

export async function handleCreateAnnualLeaveRequest(request, supabaseAdmin, env, context) {
  try {
    const auth = await authenticateRequest(request, supabaseAdmin);
    if (auth.error) return auth.error;
    if (auth.profile.role === 'guest' || auth.profile.role === 'monitor') {
      return jsonResponse({ error: '게스트 계정은 연차를 신청할 수 없습니다.' }, 403);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: '신청 내용이 올바른 JSON이 아닙니다.' }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return jsonResponse({ error: '연차 신청 내용을 입력해 주세요.' }, 400);
    }

    const startDate = typeof body.start_date === 'string' ? body.start_date : '';
    const endDate = typeof body.end_date === 'string' ? body.end_date : '';
    const startTime = typeof body.start_time === 'string' ? body.start_time : '';
    const endTime = typeof body.end_time === 'string' ? body.end_time : '';
    const leaveType = body.leave_type;
    const totalDays = Number(body.total_days);
    const details = typeof body.details === 'string' ? body.details.trim() : '';

    if (!['연차', '시간차'].includes(leaveType)) {
      return jsonResponse({ error: '연차 또는 시간차를 선택해 주세요.' }, 400);
    }
    if (!isValidDate(startDate) || !isValidDate(endDate) || endDate < startDate) {
      return jsonResponse({ error: '신청 기간을 올바르게 입력해 주세요.' }, 400);
    }
    if (new Date(`${endDate}T00:00:00Z`) - new Date(`${startDate}T00:00:00Z`) > 366 * 24 * 60 * 60 * 1000) {
      return jsonResponse({ error: '연차 신청 기간은 1년 이내로 입력해 주세요.' }, 400);
    }
    if (!TIME_PATTERN.test(startTime) || !TIME_PATTERN.test(endTime)
      || Number(startTime.slice(0, 2)) > 23 || Number(startTime.slice(3, 5)) > 59
      || Number(endTime.slice(0, 2)) > 23 || Number(endTime.slice(3, 5)) > 59
      || (leaveType === '시간차' && endTime <= startTime)) {
      return jsonResponse({ error: '신청 시작·종료 시간을 올바르게 입력해 주세요.' }, 400);
    }
    let hoursUsed = null;
    if (leaveType === '연차') {
      const weekdays = countWeekdays(startDate, endDate);
      if (startTime !== '00:00' || endTime !== '00:00') {
        return jsonResponse({ error: '종일 연차의 시작·종료 시간은 00:00이어야 합니다.' }, 400);
      }
      if (!Number.isInteger(totalDays) || totalDays < 1 || totalDays > 31 || totalDays !== weekdays) {
        return jsonResponse({ error: '연차 일수는 신청 기간 내 주말 제외 평일 수와 같아야 합니다.' }, 400);
      }
    } else {
      if (startDate !== endDate) {
        return jsonResponse({ error: '시간차는 시작일과 종료일이 같아야 합니다.' }, 400);
      }
      const [startHour, startMinute] = startTime.split(':').map(Number);
      const [endHour, endMinute] = endTime.split(':').map(Number);
      const durationMinutes = (endHour * 60 + endMinute) - (startHour * 60 + startMinute);
      if (durationMinutes < 15 || durationMinutes > 24 * 60 || durationMinutes % 15 !== 0) {
        return jsonResponse({ error: '시간차는 15분 단위로 0.25~24시간을 신청해 주세요.' }, 400);
      }
      if (totalDays !== 1) {
        return jsonResponse({ error: '시간차의 총 연차 일수 값이 올바르지 않습니다.' }, 400);
      }
      hoursUsed = durationMinutes / 60;
    }
    if (details.length > 2000) return jsonResponse({ error: '세부 사항은 2000자 이내로 입력해 주세요.' }, 400);

    const { data: member, error: memberError } = await supabaseAdmin
      .from('users')
      .select('work_location')
      .eq('id', auth.user.id)
      .maybeSingle();
    if (memberError) throw memberError;

    const { data, error } = await supabaseAdmin
      .from('annual_leave_requests')
      .insert({
        user_id: auth.user.id,
        username: auth.profile.name || auth.profile.username || '회원',
        department: member?.work_location || '',
        leave_type: leaveType,
        start_date: startDate,
        start_time: startTime,
        end_date: endDate,
        end_time: endTime,
        total_days: totalDays,
        hours_used: hoursUsed,
        details
      })
      .select(REQUEST_FIELDS)
      .single();
    if (error) throw error;

    let notificationWarning = '';
    let adminUserIds = [];
    try {
      const { data: admins, error: adminsError } = await supabaseAdmin
        .from('users')
        .select('id')
        .eq('role', 'admin');
      if (adminsError) throw adminsError;
      adminUserIds = (admins || []).map(admin => admin.id);
      const notificationError = await notifyUsers(
        supabaseAdmin,
        adminUserIds,
        '새 연차 신청',
        `${data.username} 님이 ${data.start_date}~${data.end_date} ${data.leave_type === '시간차' ? `시간차 ${data.hours_used}시간` : `연차 ${data.total_days}일`}을 신청했습니다.`,
        'annual_leave_request'
      );
      if (notificationError) throw notificationError;
    } catch (notificationError) {
      console.error('연차 신청 등록 후 관리자 알림 전송 오류:', notificationError);
      notificationWarning = '신청은 등록됐지만 관리자 알림 전송에 실패했습니다.';
    }

    if (adminUserIds.length > 0) {
      schedulePushToUsers(context, supabaseAdmin, env, adminUserIds, {
        title: '새 연차 신청',
        body: `${data.username} 님이 ${data.start_date}~${data.end_date} ${data.leave_type === '시간차' ? `시간차 ${data.hours_used}시간` : `연차 ${data.total_days}일`}을 신청했습니다.`,
        type: 'annual_leave_request'
      });
    }

    return jsonResponse({ success: true, request: data, notificationWarning }, 201);
  } catch (error) {
    console.error('연차 신청 등록 오류:', error);
    return jsonResponse({ error: error.message || '연차 신청을 등록하지 못했습니다.' }, 500);
  }
}

export async function handleReviewAnnualLeaveRequest(request, supabaseAdmin, env, context, requestId) {
  try {
    const auth = await authenticateRequest(request, supabaseAdmin);
    if (auth.error) return auth.error;
    if (auth.profile.role !== 'admin') {
      return jsonResponse({ error: '관리자만 연차 신청을 승인 또는 반려할 수 있습니다.' }, 403);
    }
    if (!REQUEST_ID_PATTERN.test(requestId || '')) {
      return jsonResponse({ error: '연차 신청 ID가 올바르지 않습니다.' }, 400);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: '검토 내용이 올바른 JSON이 아닙니다.' }, 400);
    }
    const status = body?.status;
    const reviewNote = typeof body?.review_note === 'string' ? body.review_note.trim() : '';
    if (!['approved', 'rejected'].includes(status)) {
      return jsonResponse({ error: '승인 또는 반려 상태를 선택해 주세요.' }, 400);
    }
    if (reviewNote.length > 1000) return jsonResponse({ error: '관리자 메모는 1000자 이내로 입력해 주세요.' }, 400);

    const { data, error } = await supabaseAdmin.rpc('review_annual_leave_request', {
      p_request_id: requestId,
      p_reviewed_by: auth.user.id,
      p_status: status,
      p_review_note: reviewNote
    });
    if (error) {
      if (error.message.includes('대기 중인 연차 신청')) return jsonResponse({ error: error.message }, 409);
      if (error.message.includes('이미 등록된 일정')) return jsonResponse({ error: error.message }, 409);
      throw error;
    }
    const reviewedRequest = Array.isArray(data) ? data[0] : data;
    if (!reviewedRequest) return jsonResponse({ error: '연차 신청 처리 결과를 확인할 수 없습니다.' }, 500);

    let notificationWarning = '';
    const reviewerName = auth.profile.name || auth.profile.username || '관리자';
    const title = status === 'approved' ? '연차 신청 승인' : '연차 신청 반려';
    const requestTypeLabel = reviewedRequest.leave_type === '시간차'
      ? `시간차 ${reviewedRequest.hours_used}시간`
      : `연차 ${reviewedRequest.total_days}일`;
    const notificationBody = `${reviewedRequest.start_date}~${reviewedRequest.end_date} ${requestTypeLabel} 신청이 ${status === 'approved' ? '승인' : '반려'}되었습니다.${reviewNote ? ` 메모: ${reviewNote}` : ''} (${reviewerName})`;
    try {
      const notificationError = await notifyUsers(
        supabaseAdmin,
        [reviewedRequest.user_id],
        title,
        notificationBody,
        'annual_leave_review'
      );
      if (notificationError) throw notificationError;
    } catch (notificationError) {
      console.error('연차 신청 처리 후 신청자 알림 전송 오류:', notificationError);
      notificationWarning = '신청 처리는 완료됐지만 신청자 알림 전송에 실패했습니다.';
    }

    schedulePushToUsers(context, supabaseAdmin, env, [reviewedRequest.user_id], {
      title,
      body: notificationBody,
      type: 'annual_leave_review'
    });

    return jsonResponse({ success: true, request: reviewedRequest, notificationWarning });
  } catch (error) {
    console.error('연차 신청 검토 오류:', error);
    return jsonResponse({ error: error.message || '연차 신청을 처리하지 못했습니다.' }, 500);
  }
}
