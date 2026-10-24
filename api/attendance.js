import { authenticateRequest, jsonResponse } from './push.js';

const SITE_FIELDS = 'id, site_number, name, latitude, longitude, radius_m, enabled, updated_at';
const RECORD_FIELDS = 'id, user_id, username, location_id, location_name, work_date, check_in_at, check_in_accuracy_m, check_in_distance_m, check_in_latitude, check_in_longitude, check_in_device, check_out_at, check_out_accuracy_m, check_out_distance_m, check_out_latitude, check_out_longitude, check_out_device, note, created_at, updated_at';
const MAX_LOCATION_ACCURACY_M = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function omitGpsCoordinates(record) {
  const {
    check_in_latitude,
    check_in_longitude,
    check_in_device,
    check_out_latitude,
    check_out_longitude,
    check_out_device,
    ...visibleRecord
  } = record;
  return visibleRecord;
}

function normalizeDeviceInfo(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fields = ['manufacturer', 'model', 'android_version', 'app_version'];
  const device = Object.fromEntries(fields.map(field => [
    field,
    typeof value[field] === 'string' ? value[field].trim().slice(0, 120) : ''
  ]));
  return device.model ? device : null;
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
      : sites.filter(site => site.enabled).map(({ id, site_number, name, radius_m, latitude }) => ({
        id, site_number, name, radius_m, enabled: true,
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
    if (!body || !Array.isArray(body.sites)) {
      return jsonResponse({ error: '출근지 설정 형식이 올바르지 않습니다.' }, 400);
    }

    const siteIds = new Set();
    const sites = [];
    for (const site of body.sites) {
      if (!site || typeof site !== 'object' || Array.isArray(site)) {
        return jsonResponse({ error: '출근지 설정 형식이 올바르지 않습니다.' }, 400);
      }
      const id = site.id === null || site.id === '' || site.id === undefined ? null : site.id;
      const name = typeof site.name === 'string' ? site.name.trim() : '';
      const radius = Number(site.radius_m);
      const latitude = site.latitude === null || site.latitude === '' ? null : Number(site.latitude);
      const longitude = site.longitude === null || site.longitude === '' ? null : Number(site.longitude);
      const enabled = site.enabled === true;
      if (id !== null && (typeof id !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
        || siteIds.has(id))) {
        return jsonResponse({ error: '출근지 식별자가 중복되거나 올바르지 않습니다.' }, 400);
      }
      if (id !== null) siteIds.add(id);
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
        id,
        name,
        latitude,
        longitude,
        radius_m: radius,
        enabled
      });
    }

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
      .is('deleted_at', null)
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
    return jsonResponse({
      records: isAdmin(auth) ? data || [] : (data || []).map(omitGpsCoordinates),
      isAdmin: isAdmin(auth)
    });
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
    if (!body || !validCoordinate(body.latitude, -90, 90)
      || !validCoordinate(body.longitude, -180, 180)
      || typeof body.accuracy_m !== 'number'
      || !Number.isFinite(body.accuracy_m)
      || body.accuracy_m <= 0
      || body.accuracy_m > MAX_LOCATION_ACCURACY_M) {
      return jsonResponse({ error: '위치 정보가 부정확합니다. 위치 정확도가 100m 이내일 때 다시 시도해 주세요.' }, 400);
    }
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (note.length > 500) return jsonResponse({ error: '메모는 500자 이내로 입력해 주세요.' }, 400);
    const device = normalizeDeviceInfo(body.device);
    if (!device) {
      return jsonResponse({ error: '앱 기기 정보를 확인할 수 없습니다. 최신 Android 앱에서 다시 시도해 주세요.' }, 400);
    }

    const { data: openRecords, error: lookupError } = await supabaseAdmin
      .from('attendance_records')
      .select('id, location_id, work_date, check_in_at')
      .eq('user_id', employee.auth.user.id)
      .is('check_out_at', null)
      .is('deleted_at', null)
      .order('check_in_at', { ascending: false })
      .limit(2);
    if (lookupError) throw lookupError;
    const activeRecords = openRecords || [];
    const existing = activeRecords[0] || null;
    if (action === 'check-in' && existing) {
      return jsonResponse({
        error: `퇴근하지 않은 근무 기록(${existing.work_date})이 있습니다. 먼저 해당 근무를 마치거나 관리자에게 기록 정정을 요청해 주세요.`
      }, 409);
    }
    if (action === 'check-out' && !existing) {
      return jsonResponse({ error: '퇴근할 출근 기록이 없습니다. 먼저 출근해 주세요.' }, 409);
    }
    if (action === 'check-out' && activeRecords.length > 1) {
      return jsonResponse({
        error: '퇴근하지 않은 근무 기록이 여러 건 있습니다. 관리자에게 기록 확인을 요청해 주세요.'
      }, 409);
    }

    let siteQuery = supabaseAdmin
      .from('attendance_sites')
      .select(SITE_FIELDS)
      .eq('enabled', true)
      .not('latitude', 'is', null)
      .not('longitude', 'is', null)
      .order('site_number', { ascending: true });
    if (action === 'check-out') siteQuery = siteQuery.eq('id', existing.location_id);
    const { data: configuredSites, error: siteError } = await siteQuery;
    if (siteError) throw siteError;

    const matchingSites = (configuredSites || [])
      .map(site => ({
        site,
        distance: distanceInMeters(body.latitude, body.longitude, site.latitude, site.longitude)
      }))
      .filter(({ site, distance }) => distance <= site.radius_m)
      .sort((first, second) => first.distance - second.distance);
    const match = matchingSites[0];
    if (!match) {
      return jsonResponse({
        error: action === 'check-out'
          ? '퇴근은 출근을 등록한 출근지 반경 안에서 해 주세요.'
          : '등록된 출근지 반경 안에서만 출근할 수 있습니다.'
      }, 403);
    }
    const { site, distance } = match;

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
          check_in_latitude: body.latitude,
          check_in_longitude: body.longitude,
          check_in_device: device,
          note
        })
        .select(RECORD_FIELDS)
        .single();
      if (error?.code === '23505') return jsonResponse({ error: '출근 기록을 저장하지 못했습니다. 새로고침 후 다시 시도해 주세요.' }, 409);
      if (error) throw error;
      return jsonResponse({ record: omitGpsCoordinates(data) });
    }

    const { data, error } = await supabaseAdmin
      .from('attendance_records')
      .update({
        check_out_at: now,
        check_out_accuracy_m: body.accuracy_m,
        check_out_distance_m: Math.round(distance),
        check_out_latitude: body.latitude,
        check_out_longitude: body.longitude,
        check_out_device: device,
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
    return jsonResponse({ record: omitGpsCoordinates(data) });
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
    if (!UUID_PATTERN.test(recordId || '')) {
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

export async function handleDeleteAttendanceRecord(request, supabaseAdmin, recordId) {
  try {
    const auth = await authenticateRequest(request, supabaseAdmin);
    if (auth.error) return auth.error;
    if (!isAdmin(auth)) return jsonResponse({ error: '관리자만 근태 기록을 삭제할 수 있습니다.' }, 403);
    if (!UUID_PATTERN.test(recordId || '')) {
      return jsonResponse({ error: '근태 기록 ID가 올바르지 않습니다.' }, 400);
    }

    const body = await parseBody(request);
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if (!reason || reason.length > 500) {
      return jsonResponse({ error: '삭제 사유를 1~500자로 입력해 주세요.' }, 400);
    }

    const { data, error } = await supabaseAdmin.rpc('delete_attendance_record', {
      p_record_id: recordId,
      p_reason: reason,
      p_admin_id: auth.user.id
    });
    if (error) throw error;
    return jsonResponse({ success: true, record: data });
  } catch (error) {
    console.error('근태 기록 삭제 오류:', error);
    return jsonResponse({ error: error.message || '근태 기록을 삭제하지 못했습니다.' }, 500);
  }
}

function parseKoreaDateTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value || '');
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const calendarDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (calendarDate.toISOString().slice(0, 10) !== `${year}-${month}-${day}`
    || Number(hour) > 23 || Number(minute) > 59) return null;
  const date = new Date(`${value}:00+09:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function handleCreateManualAttendanceRecord(request, supabaseAdmin) {
  try {
    const auth = await authenticateRequest(request, supabaseAdmin);
    if (auth.error) return auth.error;
    if (!isAdmin(auth)) return jsonResponse({ error: '관리자만 근태 기록을 추가할 수 있습니다.' }, 403);

    const body = await parseBody(request);
    if (!body || !UUID_PATTERN.test(body.user_id || '') || !UUID_PATTERN.test(body.location_id || '')
      || typeof body.check_in_at !== 'string'
      || (body.check_out_at != null && body.check_out_at !== '' && typeof body.check_out_at !== 'string')
      || typeof body.reason !== 'string') {
      return jsonResponse({ error: '직원, 출근지, 출퇴근 시각과 추가 사유를 확인해 주세요.' }, 400);
    }

    const checkInAt = parseKoreaDateTime(body.check_in_at);
    const hasCheckOut = typeof body.check_out_at === 'string' && body.check_out_at !== '';
    const checkOutAt = hasCheckOut ? parseKoreaDateTime(body.check_out_at) : null;
    const reason = body.reason.trim();
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (!checkInAt || (hasCheckOut && !checkOutAt)
      || (checkOutAt && checkOutAt < checkInAt)) {
      return jsonResponse({ error: '출퇴근 시각을 올바르게 입력해 주세요.' }, 400);
    }
    if (!reason || reason.length > 500 || note.length > 1000) {
      return jsonResponse({ error: '추가 사유는 1~500자, 메모는 1000자 이내로 입력해 주세요.' }, 400);
    }

    const [{ data: user, error: userError }, { data: site, error: siteError }] = await Promise.all([
      supabaseAdmin.from('users')
        .select('id, name, username, role, status')
        .eq('id', body.user_id)
        .maybeSingle(),
      supabaseAdmin.from('attendance_sites')
        .select('id, name')
        .eq('id', body.location_id)
        .maybeSingle()
    ]);
    if (userError) throw userError;
    if (siteError) throw siteError;
    if (!user || ['guest', 'monitor'].includes(user.role) || user.status === '퇴직') {
      return jsonResponse({ error: '근태 기록을 추가할 수 있는 재직 직원을 선택해 주세요.' }, 400);
    }
    if (!site) return jsonResponse({ error: '선택한 출근지를 찾을 수 없습니다.' }, 400);

    const { data, error } = await supabaseAdmin.rpc('create_manual_attendance_record', {
      p_user_id: user.id,
      p_username: user.name || user.username || '회원',
      p_location_id: site.id,
      p_check_in_at: checkInAt,
      p_check_out_at: checkOutAt,
      p_note: note,
      p_reason: reason,
      p_admin_id: auth.user.id
    });
    if (error) throw error;
    return jsonResponse({ record: data });
  } catch (error) {
    console.error('관리자 근태 기록 추가 오류:', error);
    return jsonResponse({ error: error.message || '근태 기록을 추가하지 못했습니다.' }, 500);
  }
}
