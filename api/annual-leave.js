import { authenticateRequest, jsonResponse } from './push.js';

const BASE_ANNUAL_DAYS = 12;
const MAX_SERVICE_YEAR = 10;

function getKoreaDate() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function anniversaryDate(hireDate, years) {
  const [year, month, day] = hireDate.split('-').map(Number);
  const targetYear = year + years;
  const lastDay = new Date(Date.UTC(targetYear, month, 0)).getUTCDate();
  return `${targetYear}-${String(month).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

function countWeekdays(startDate, endDate) {
  if (endDate < startDate) return 0;
  const date = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  let count = 0;
  for (; date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) count += 1;
  }
  return count;
}

function getServicePeriod(hireDate, today) {
  if (!hireDate || hireDate > today) return null;
  let serviceYear = Number(today.slice(0, 4)) - Number(hireDate.slice(0, 4)) + 1;
  while (serviceYear > 1 && anniversaryDate(hireDate, serviceYear - 1) > today) serviceYear -= 1;
  while (anniversaryDate(hireDate, serviceYear) <= today) serviceYear += 1;
  const startDate = anniversaryDate(hireDate, serviceYear - 1);
  const endDate = new Date(`${anniversaryDate(hireDate, serviceYear)}T00:00:00Z`);
  endDate.setUTCDate(endDate.getUTCDate() - 1);
  return {
    serviceYear,
    startDate,
    endDate: endDate.toISOString().slice(0, 10)
  };
}

function getUsedDays(entry) {
  if (entry.leave_type === '연차') return 1;
  if (entry.leave_type === '시간차') {
    const hours = Number(entry.hours_used);
    return Number.isFinite(hours) ? hours / 8 : 0;
  }
  return 0;
}

function countRequestedDays(request, startDate, endDate) {
  const first = request.start_date < startDate ? startDate : request.start_date;
  const last = request.end_date > endDate ? endDate : request.end_date;
  if (request.leave_type === '연차') return countWeekdays(first, last);
  if (request.leave_type === '시간차' && request.start_date >= startDate && request.start_date <= endDate) {
    return Number(request.hours_used || 0) / 8;
  }
  return 0;
}

async function loadSettings(supabaseAdmin) {
  const { data, error } = await supabaseAdmin
    .from('annual_leave_accrual_settings')
    .select('service_year, additional_days')
    .order('service_year', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function buildBalances(supabaseAdmin, members, settings) {
  const today = getKoreaDate();
  const eligibleMembers = members.filter(member => member.hire_date && member.hire_date <= today);
  if (!eligibleMembers.length) {
    return members.map(member => ({
      user_id: member.id,
      name: member.name || member.username || '이름 없음',
      department: member.work_location || '',
      hire_date: member.hire_date,
      service_year: null,
      cycle_start: null,
      cycle_end: null,
      base_days: BASE_ANNUAL_DAYS,
      additional_days: 0,
      entitled_days: null,
      used_days: 0,
      pending_days: 0,
      remaining_days: null,
      usage_rate: null
    }));
  }

  const periods = new Map(eligibleMembers.map(member => [
    member.id,
    getServicePeriod(member.hire_date, today)
  ]));
  const cycleStart = [...periods.values()].reduce((start, period) =>
    period.startDate < start ? period.startDate : start, [...periods.values()][0].startDate);
  const cycleEnd = [...periods.values()].reduce((end, period) =>
    period.endDate > end ? period.endDate : end, [...periods.values()][0].endDate);
  const userIds = eligibleMembers.map(member => member.id);
  const [vacationsResult, requestsResult] = await Promise.all([
    supabaseAdmin
      .from('vacations')
      .select('user_id, date, leave_type, hours_used')
      .in('user_id', userIds)
      .gte('date', cycleStart)
      .lte('date', cycleEnd),
    supabaseAdmin
      .from('annual_leave_requests')
      .select('user_id, leave_type, start_date, end_date, total_days, hours_used')
      .eq('status', 'pending')
      .in('user_id', userIds)
      .gte('end_date', cycleStart)
      .lte('start_date', cycleEnd)
  ]);
  if (vacationsResult.error) throw vacationsResult.error;
  if (requestsResult.error) throw requestsResult.error;

  const settingsByYear = new Map(settings.map(item => [Number(item.service_year), Number(item.additional_days)]));
  return members.map(member => {
    const period = periods.get(member.id);
    if (!period) {
      return {
        user_id: member.id,
        name: member.name || member.username || '이름 없음',
        department: member.work_location || '',
        hire_date: member.hire_date,
        service_year: null,
        cycle_start: null,
        cycle_end: null,
        base_days: BASE_ANNUAL_DAYS,
        additional_days: 0,
        entitled_days: null,
        used_days: 0,
        pending_days: 0,
        remaining_days: null,
        usage_rate: null
      };
    }
    const additionalDays = settingsByYear.get(Math.min(period.serviceYear, MAX_SERVICE_YEAR)) || 0;
    const entitledDays = BASE_ANNUAL_DAYS + additionalDays;
    const usedDays = (vacationsResult.data || [])
      .filter(item => item.user_id === member.id && item.date >= period.startDate && item.date <= period.endDate)
      .reduce((sum, item) => sum + getUsedDays(item), 0);
    const pendingDays = (requestsResult.data || [])
      .filter(item => item.user_id === member.id)
      .reduce((sum, item) => sum + countRequestedDays(item, period.startDate, period.endDate), 0);
    return {
      user_id: member.id,
      name: member.name || member.username || '이름 없음',
      department: member.work_location || '',
      hire_date: member.hire_date,
      service_year: period.serviceYear,
      cycle_start: period.startDate,
      cycle_end: period.endDate,
      base_days: BASE_ANNUAL_DAYS,
      additional_days: additionalDays,
      entitled_days: entitledDays,
      used_days: Number(usedDays.toFixed(2)),
      pending_days: Number(pendingDays.toFixed(2)),
      remaining_days: Number(Math.max(0, entitledDays - usedDays - pendingDays).toFixed(2)),
      usage_rate: entitledDays ? Number(Math.min(100, usedDays / entitledDays * 100).toFixed(1)) : 0
    };
  });
}

export async function handleGetAnnualLeave(request, supabaseAdmin) {
  try {
    const auth = await authenticateRequest(request, supabaseAdmin);
    if (auth.error) return auth.error;
    if (['guest', 'monitor'].includes(auth.profile.role)) {
      return jsonResponse({ error: '연차 현황을 조회할 권한이 없습니다.' }, 403);
    }

    const settings = await loadSettings(supabaseAdmin);
    let membersQuery = supabaseAdmin
      .from('users')
      .select('id, name, username, role, work_location, hire_date, status')
      .neq('role', 'guest')
      .neq('role', 'monitor')
      .or('status.is.null,status.neq.퇴직')
      .order('name', { ascending: true });
    if (auth.profile.role !== 'admin') membersQuery = membersQuery.eq('id', auth.user.id);
    const { data: members, error } = await membersQuery;
    if (error) throw error;

    const balances = await buildBalances(supabaseAdmin, members || [], settings);
    return jsonResponse({ balances, settings, isAdmin: auth.profile.role === 'admin' });
  } catch (error) {
    console.error('연차 현황 조회 오류:', error);
    return jsonResponse({ error: error.message || '연차 현황을 불러오지 못했습니다.' }, 500);
  }
}

export async function handleUpdateAnnualLeaveSettings(request, supabaseAdmin) {
  try {
    const auth = await authenticateRequest(request, supabaseAdmin);
    if (auth.error) return auth.error;
    if (auth.profile.role !== 'admin') {
      return jsonResponse({ error: '관리자만 가산연차를 설정할 수 있습니다.' }, 403);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: '설정 내용이 올바른 JSON이 아닙니다.' }, 400);
    }
    if (!Array.isArray(body?.settings) || body.settings.length !== MAX_SERVICE_YEAR) {
      return jsonResponse({ error: '1~10년차 가산연차 값을 모두 입력해 주세요.' }, 400);
    }
    const settings = body.settings.map((item, index) => ({
      service_year: index + 1,
      additional_days: Number(item?.additional_days)
    }));
    if (settings.some(item =>
      !Number.isInteger(item.additional_days) || item.additional_days < 0 || item.additional_days > 30
    )) {
      return jsonResponse({ error: '가산연차는 0~30일 사이의 정수로 입력해 주세요.' }, 400);
    }

    const { data, error } = await supabaseAdmin
      .from('annual_leave_accrual_settings')
      .upsert(settings, { onConflict: 'service_year' })
      .select('service_year, additional_days')
      .order('service_year', { ascending: true });
    if (error) throw error;
    return jsonResponse({ success: true, settings: data || [] });
  } catch (error) {
    console.error('가산연차 설정 저장 오류:', error);
    return jsonResponse({ error: error.message || '가산연차 설정을 저장하지 못했습니다.' }, 500);
  }
}
