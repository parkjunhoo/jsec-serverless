import { authenticateRequest, jsonResponse } from './push.js';

const SITE_FIELDS = 'id, site_number, name, latitude, longitude, radius_m, enabled, updated_at';
const RECORD_FIELDS = 'id, user_id, username, location_id, location_name, work_date, check_in_at, check_in_accuracy_m, check_in_distance_m, check_out_at, check_out_accuracy_m, check_out_distance_m, note, created_at, updated_at';
const MAX_LOCATION_ACCURACY_M = 100;

function isAdmin(auth) {
  return auth.profile.role === 'admin';
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function getKoreaDate() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function parseBody(request) {
  return request.json().catch(() => null);
}

function distanceInMeters(latitude1, longitude1, latitude2, longitude2) {
  const radians = degrees => degrees * Math.PI / 180;
  const latitudeDelta = radians(latitude2 - latitude1);
  const longitudeDelta = radians(longitude2 - longitude1);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(latitude1)) * Math.cos(radians(latitude2))
    * Math.sin(longitudeDelta / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function validCoordinate(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

async function requireEmployee(request, supabaseAdmin) {
  const auth = await authenticateRequest(request, supabaseAdmin);
  if (auth.error) return { response: auth.error };
  if (['guest', 'monitor'].includes(auth.profile.role)) {
    return { response: jsonResponse({ error: '이 계정은 근태 기능을 사용할 수 없습니다.' }, 403) };
  }
  return { auth };
}

export async function handleListAttendanceSites(request, supabaseAdmin) {
  try {
    const auth = await requireEmployee(request, supabaseAdmin);
    if (auth.response) return auth.response;

    const { data, error } = await supabaseAdmin
      .from('attendance_sites')
      .select(SITE_FIELDS)
      .order('site_number', { ascending: true });
    if (error) throw error;

    const sites = data || [];
    return jsonResponse(isAdmin(auth.auth)
      ? sites
      : sites.map(({ id, site_number, name, radius_m, enabled, latitude }) => ({
        id, site_number, name, radius_m, enabled,
        configured: latitude !== null
      })));
  } catch (error) {
    console.error('출근지 조회 오류:', error);
    return jsonResponse({ error: error.message || '출근지 설정을 불러오지 못했습니다.' }, 500);
  }
}

export async function handleSaveAttendanceSites(request, supabaseAdmin) {
  try {
    const auth = await authenticateRequest(request, supabaseAdmin);
    if (auth.error) return auth.error;
    if (!isAdmin(auth)) return jsonResponse({ error: '관리자만 출근지를 설정할 수 있습니다.' }, 403);

    const body = await parseBody(request);
    if (!body || !Array.isArray(body.sites) || body.sites.length !== 3) {
      return jsonResponse({ error: '출근지 3곳의 설정을 모두 입력해 주세요.' }, 400);
    }

    const siteNumbers = new Set();
    const sites = [];
    for (const site of body.sites) {
      if (!site || typeof site !== 'object' || Array.isArray(site)) {
        return jsonResponse({ error: '출근지 설정 형식이 올바르지 않습니다.' }, 400);
      }
      const siteNumber = Number(site.site_number);
      const name = typeof site.name === 'string' ? site.name.trim() : '';
      const radius = Number(site.radius_m);
      const latitude = site.latitude === null || site.latitude === '' ? null : Number(site.latitude);
      const longitude = site.longitude === null || site.longitude === '' ? null : Number(site.longitude);
      const enabled = site.enabled === true;
      if (![1, 2, 3].includes(siteNumber) || siteNumbers.has(siteNumber)) {
        return jsonResponse({ error: '출근지 번호가 중복되거나 올바르지 않습니다.' }, 400);
      }
      siteNumbers.add(siteNumber);
      if (!name || name.length > 80) {
        return jsonResponse({ error: '출근지 이름을 1~80자로 입력해 주세요.' }, 400);
      }
      if (!Number.isInteger(radius) || radius < 20 || radius > 1000) {
        return jsonResponse({ error: '반경은 20~1000m 사이의 정수로 입력해 주세요.' }, 400);
      }
      const hasLatitude = latitude !== null;
      const hasLongitude = longitude !== null;
      if (hasLatitude !== hasLongitude
        || (hasLatitude && (!validCoordinate(latitude, -90, 90) || !validCoordinate(longitude, -180, 180)))) {
        return jsonResponse({ error: '위도와 경도를 올바르게 함께 입력해 주세요.' }, 400);
      }
      sites.push({
        site_number: siteNumber,
        name,
        latitude,
        longitude,
        radius_m: radius,
        enabled
      });
    }
    if (siteNumbers.size !== 3) return jsonResponse({ error: '출근지 1~3 설정이 모두 필요합니다.' }, 400);

    const { data, error } = await supabaseAdmin.rpc('save_attendance_sites', {
      p_sites: sites,
      p_admin_id: auth.user.id
    });
    if (error) throw error;
    return jsonResponse(data || []);
  } catch (error) {
    console.error('출근지 저장 오류:', error);
    return jsonResponse({ error: error.message || '출근지 설정을 저장하지 못했습니다.' }, 500);
  }
}

export async function handleListAttendanceRecords(request, supabaseAdmin) {
  try {
    const employee = await requireEmployee(request, supabaseAdmin);
    if (employee.response) return employee.response;
    const auth = employee.auth;
    const url = new URL(request.url);
    const start = url.searchParams.get('start') || '';
    const end = url.searchParams.get('end') || '';
    if (!isValidDate(start) || !isValidDate(end) || start > end
      || new Date(`${end}T00:00:00Z`) - new Date(`${start}T00:00:00Z`) > 93 * 24 * 60 * 60 * 1000) {
      return jsonResponse({ error: '조회 기간은 1~93일 사이로 입력해 주세요.' }, 400);
    }

    let query = supabaseAdmin
      .from('attendance_records')
      .select(RECORD_FIELDS)
      .gte('work_date', start)
      .lte('work_date', end)
      .order('work_date', { ascending: false })
      .order('check_in_at', { ascending: false })
      .limit(5000);
    if (!isAdmin(auth)) {
      query = query.eq('user_id', auth.user.id);
    } else {
      const userId = url.searchParams.get('user_id');
      if (userId) query = query.eq('user_id', userId);
    }
    const { data, error } = await query;
    if (error) throw error;
    return jsonResponse({ records: data || [], isAdmin: isAdmin(auth) });
  } catch (error) {
    console.error('근태 기록 조회 오류:', error);
    return jsonResponse({ error: error.message || '근태 기록을 불러오지 못했습니다.' }, 500);
  }
}

export async function handleAttendancePunch(request, supabaseAdmin, action) {
  try {
    const employee = await requireEmployee(request, supabaseAdmin);
    if (employee.response) return employee.response;
    if (!['check-in', 'check-out'].includes(action)) {
      return jsonResponse({ error: '출퇴근 동작이 올바르지 않습니다.' }, 400);
    }

    const body = await parseBody(request);
    if (!body || typeof body.location_id !== 'string'
      || !validCoordinate(body.latitude, -90, 90)
      || !validCoordinate(body.longitude, -180, 180)
      || typeof body.accuracy_m !== 'number'
      || !Number.isFinite(body.accuracy_m)
      || body.accuracy_m <= 0
      || body.accuracy_m > MAX_LOCATION_ACCURACY_M) {
      return jsonResponse({ error: '위치 정보가 부정확합니다. 위치 정확도가 100m 이내일 때 다시 시도해 주세요.' }, 400);
    }
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (note.length > 500) return jsonResponse({ error: '메모는 500자 이내로 입력해 주세요.' }, 400);

    const { data: site, error: siteError } = await supabaseAdmin
      .from('attendance_sites')
      .select(SITE_FIELDS)
      .eq('id', body.location_id)
      .maybeSingle();
    if (siteError) throw siteError;
    if (!site || !site.enabled || site.latitude === null || site.longitude === null) {
      return jsonResponse({ error: '사용할 수 있도록 설정된 출근지가 아닙니다.' }, 400);
    }
    const distance = distanceInMeters(body.latitude, body.longitude, site.latitude, site.longitude);
    if (distance > site.radius_m) {
      return jsonResponse({
        error: `${site.name} 출근지 반경 밖입니다. 현재 약 ${Math.round(distance)}m, 허용 반경 ${site.radius_m}m입니다.`
      }, 403);
    }

    const now = new Date().toISOString();
    const workDate = getKoreaDate();
    const common = {
      user_id: employee.auth.user.id,
      username: employee.auth.profile.name || employee.auth.profile.username || '회원',
      location_id: site.id,
      location_name: site.name,
      work_date: workDate
    };
    if (action === 'check-in') {
      const { data, error } = await supabaseAdmin
        .from('attendance_records')
        .insert({
          ...common,
          check_in_at: now,
          check_in_accuracy_m: body.accuracy_m,
          check_in_distance_m: Math.round(distance),
          note
        })
        .select(RECORD_FIELDS)
        .single();
      if (error?.code === '23505') {
        return jsonResponse({ error: '오늘 출근 기록이 이미 있습니다.' }, 409);
      }
      if (error) throw error;
      return jsonResponse({ record: data });
    }

    const { data: existing, error: lookupError } = await supabaseAdmin
      .from('attendance_records')
      .select('id, location_id, check_out_at')
      .eq('user_id', employee.auth.user.id)
      .eq('work_date', workDate)
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (!existing) return jsonResponse({ error: '오늘 출근 기록이 없습니다. 먼저 출근해 주세요.' }, 409);
    if (existing.check_out_at) return jsonResponse({ error: '오늘 퇴근 기록이 이미 있습니다.' }, 409);
    if (existing.location_id !== site.id) {
      return jsonResponse({ error: '퇴근은 출근 시 선택한 동일한 지점에서 등록해 주세요.' }, 400);
    }

    const { data, error } = await supabaseAdmin
      .from('attendance_records')
      .update({
        check_out_at: now,
        check_out_accuracy_m: body.accuracy_m,
        check_out_distance_m: Math.round(distance),
        note: note || undefined,
        updated_at: now
      })
      .eq('id', existing.id)
      .eq('user_id', employee.auth.user.id)
      .is('check_out_at', null)
      .select(RECORD_FIELDS)
      .maybeSingle();
    if (error) throw error;
    if (!data) return jsonResponse({ error: '퇴근 기록이 이미 처리되었습니다. 새로고침해 주세요.' }, 409);
    return jsonResponse({ record: data });
  } catch (error) {
    console.error('출퇴근 기록 등록 오류:', error);
    return jsonResponse({ error: error.message || '출퇴근 기록을 등록하지 못했습니다.' }, 500);
  }
}

export async function handleCorrectAttendanceRecord(request, supabaseAdmin, recordId) {
  try {
    const auth = await authenticateRequest(request, supabaseAdmin);
    if (auth.error) return auth.error;
    if (!isAdmin(auth)) return jsonResponse({ error: '관리자만 근태 기록을 수정할 수 있습니다.' }, 403);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(recordId || '')) {
      return jsonResponse({ error: '근태 기록 ID가 올바르지 않습니다.' }, 400);
    }
    const body = await parseBody(request);
    if (!body || typeof body.location_id !== 'string'
      || typeof body.check_in_at !== 'string'
      || (body.check_out_at !== null && typeof body.check_out_at !== 'string')
      || typeof body.reason !== 'string') {
      return jsonResponse({ error: '수정할 근태 정보와 사유를 입력해 주세요.' }, 400);
    }

    const parseLocalDateTime = value => {
      const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
      if (!match) return null;
      const [, year, month, day, hour, minute] = match;
      const calendarDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
      if (calendarDate.toISOString().slice(0, 10) !== `${year}-${month}-${day}`
        || Number(hour) > 23 || Number(minute) > 59) return null;
      const date = new Date(`${value}:00+09:00`);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    };
    const checkInAt = parseLocalDateTime(body.check_in_at);
    const checkOutAt = body.check_out_at === null ? null : parseLocalDateTime(body.check_out_at);
    if (!checkInAt || (body.check_out_at !== null && !checkOutAt)
      || (checkOutAt && checkOutAt < checkInAt)) {
      return jsonResponse({ error: '출퇴근 시각을 올바르게 입력해 주세요.' }, 400);
    }
    const reason = body.reason.trim();
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (!reason || reason.length > 500 || note.length > 1000) {
      return jsonResponse({ error: '수정 사유는 1~500자, 메모는 1000자 이내로 입력해 주세요.' }, 400);
    }

    const { data, error } = await supabaseAdmin.rpc('correct_attendance_record', {
      p_record_id: recordId,
      p_location_id: body.location_id,
      p_check_in_at: checkInAt,
      p_check_out_at: checkOutAt,
      p_note: note,
      p_reason: reason,
      p_admin_id: auth.user.id
    });
    if (error) throw error;
    return jsonResponse(data);
  } catch (error) {
    console.error('근태 기록 수정 오류:', error);
    return jsonResponse({ error: error.message || '근태 기록을 수정하지 못했습니다.' }, 500);
  }
}
