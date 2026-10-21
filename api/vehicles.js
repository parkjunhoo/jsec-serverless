import { authenticateRequest, jsonResponse } from './push.js';

const VEHICLE_FIELDS = ['number', 'full_number', 'name', 'department', 'car_name', 'phone', 'notes'];

function validateVehicle(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: '차량 정보를 입력해 주세요.' };
  }

  const vehicle = {};
  for (const field of VEHICLE_FIELDS) {
    if (typeof body[field] !== 'string') {
      return { error: '차량 정보가 올바르지 않습니다.' };
    }
    vehicle[field] = body[field].trim();
  }
  if (vehicle.number.length !== 4) {
    return { error: '검색용 뒷자리 4자리를 정확히 입력해 주세요.' };
  }
  return { vehicle };
}

function applyVehicleId(query, vehicleId) {
  return /^\d+$/.test(vehicleId)
    ? query.eq('id', vehicleId)
    : query.eq('full_number', vehicleId);
}

async function authenticateVehicleWrite(request, supabaseAdmin) {
  const auth = await authenticateRequest(request, supabaseAdmin);
  if (auth.error) return { response: auth.error };
  if (auth.profile.role === 'guest' || auth.profile.role === 'monitor') {
    return { response: jsonResponse({ error: '게스트 계정은 차량 정보를 변경할 수 없습니다.' }, 403) };
  }
  return { auth };
}

export async function handleCreateVehicle(request, supabaseAdmin) {
  try {
    const authorized = await authenticateVehicleWrite(request, supabaseAdmin);
    if (authorized.response) return authorized.response;

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: '요청 내용이 올바른 JSON이 아닙니다.' }, 400);
    }
    const validation = validateVehicle(body);
    if (validation.error) return jsonResponse({ error: validation.error }, 400);

    const { error } = await supabaseAdmin
      .from('skicar_data')
      .insert(validation.vehicle);
    if (error) throw error;
    return jsonResponse({ success: true });
  } catch (error) {
    console.error('차량 등록 오류:', error);
    return jsonResponse({ error: error.message || '차량 정보를 등록하지 못했습니다.' }, 500);
  }
}

export async function handleUpdateVehicle(request, supabaseAdmin, vehicleId) {
  try {
    const authorized = await authenticateVehicleWrite(request, supabaseAdmin);
    if (authorized.response) return authorized.response;
    if (!vehicleId) return jsonResponse({ error: '수정할 차량 ID가 필요합니다.' }, 400);

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: '요청 내용이 올바른 JSON이 아닙니다.' }, 400);
    }
    const validation = validateVehicle(body);
    if (validation.error) return jsonResponse({ error: validation.error }, 400);

    const query = supabaseAdmin
      .from('skicar_data')
      .update(validation.vehicle);
    const { data, error } = await applyVehicleId(query, vehicleId)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) return jsonResponse({ error: '차량 정보를 찾을 수 없습니다.' }, 404);
    return jsonResponse({ success: true });
  } catch (error) {
    console.error('차량 정보 수정 오류:', error);
    return jsonResponse({ error: error.message || '차량 정보를 수정하지 못했습니다.' }, 500);
  }
}

export async function handleDeleteVehicle(request, supabaseAdmin, vehicleId) {
  try {
    const authorized = await authenticateVehicleWrite(request, supabaseAdmin);
    if (authorized.response) return authorized.response;
    if (!vehicleId) return jsonResponse({ error: '삭제할 차량 ID가 필요합니다.' }, 400);

    const query = supabaseAdmin
      .from('skicar_data')
      .delete();
    const { data, error } = await applyVehicleId(query, vehicleId)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) return jsonResponse({ error: '차량 정보를 찾을 수 없습니다.' }, 404);
    return jsonResponse({ success: true });
  } catch (error) {
    console.error('차량 정보 삭제 오류:', error);
    return jsonResponse({ error: error.message || '차량 정보를 삭제하지 못했습니다.' }, 500);
  }
}
