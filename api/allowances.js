import { authenticateRequest, jsonResponse } from './push.js';

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

async function getAllowanceType(supabaseAdmin, code) {
  const { data, error } = await supabaseAdmin
    .from('allowance_types')
    .select('code, label, unit_amount, shift_options, daily_limit')
    .eq('code', code)
    .eq('active', true)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getAuthorizedEntry(request, supabaseAdmin, entryId) {
  const auth = await authenticateRequest(request, supabaseAdmin);
  if (auth.error) return { response: auth.error };

  const { data: entry, error } = await supabaseAdmin
    .from('allowance_entries')
    .select('*')
    .eq('id', entryId)
    .maybeSingle();
  if (error) throw error;
  if (!entry) return { response: jsonResponse({ error: '수당 기록을 찾을 수 없습니다.' }, 404) };
  if (entry.user_id !== auth.user.id && auth.profile.role !== 'admin') {
    return { response: jsonResponse({ error: '수정 또는 삭제 권한이 없습니다.' }, 403) };
  }

  return { auth, entry };
}

function validateSelection(type, shift, slotNo) {
  const options = type.shift_options || [];
  if (options.length > 0) {
    if (!options.includes(shift)) return '수당 구분을 선택해 주세요.';
    if (slotNo !== null) return '셔틀 수당에 슬롯 번호를 지정할 수 없습니다.';
    return '';
  }
  if (shift) return '이 수당은 오전/오후 구분을 사용하지 않습니다.';
  if (type.daily_limit) {
    if (!Number.isInteger(slotNo) || slotNo < 1 || slotNo > type.daily_limit) {
      return '남아 있는 수당 슬롯을 선택해 주세요.';
    }
  } else if (slotNo !== null) {
    return '이 수당은 슬롯 번호를 사용하지 않습니다.';
  }
  return '';
}

export async function handleListAllowanceTypes(request, supabaseAdmin) {
  try {
    const auth = await authenticateRequest(request, supabaseAdmin);
    if (auth.error) return auth.error;

    const { data, error } = await supabaseAdmin
      .from('allowance_types')
      .select('code, label, unit_amount, shift_options, daily_limit')
      .eq('active', true)
      .order('sort_order', { ascending: true });
    if (error) throw error;
    return jsonResponse(data || []);
  } catch (error) {
    console.error('수당 종류 조회 오류:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}

export async function handleListAllowances(request, supabaseAdmin) {
  try {
    const auth = await authenticateRequest(request, supabaseAdmin);
    if (auth.error) return auth.error;

    const url = new URL(request.url);
    const start = url.searchParams.get('start') || '';
    const end = url.searchParams.get('end') || '';
    if (!isValidDate(start) || !isValidDate(end) || start > end) {
      return jsonResponse({ error: '조회할 날짜 범위가 올바르지 않습니다.' }, 400);
    }

        let query = supabaseAdmin
          .from('allowance_entries')
          .select('id, user_id, username, type_code, type_label, work_date, shift, slot_no, unit_amount, note, created_at, updated_at')
      .gte('work_date', start)
      .lte('work_date', end)
      .order('work_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(5000);

    const typeCode = url.searchParams.get('type');
    if (typeCode) query = query.eq('type_code', typeCode);

    if (auth.profile.role === 'admin') {
      const userId = url.searchParams.get('user_id');
      if (userId) query = query.eq('user_id', userId);
    } else {
      query = query.eq('user_id', auth.user.id);
    }

    const { data, error } = await query;
    if (error) throw error;
    return jsonResponse(data || []);
  } catch (error) {
    console.error('수당 일지 조회 오류:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}

export async function handleListAllowanceAvailability(request, supabaseAdmin) {
  try {
    const auth = await authenticateRequest(request, supabaseAdmin);
    if (auth.error) return auth.error;

    const url = new URL(request.url);
    const start = url.searchParams.get('start') || '';
    const end = url.searchParams.get('end') || '';
    if (!isValidDate(start) || !isValidDate(end) || start > end) {
      return jsonResponse({ error: '조회할 날짜 범위가 올바르지 않습니다.' }, 400);
    }

    const { data, error } = await supabaseAdmin
      .from('allowance_entries')
      .select('id, work_date, type_code, shift, slot_no, user_id')
      .gte('work_date', start)
      .lte('work_date', end);
    if (error) throw error;
    return jsonResponse(data || []);
  } catch (error) {
    console.error('수당 슬롯 조회 오류:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}

export async function handleCreateAllowance(request, supabaseAdmin) {
  try {
    const auth = await authenticateRequest(request, supabaseAdmin);
    if (auth.error) return auth.error;

    const body = await request.json();
    const typeCode = typeof body.type_code === 'string' ? body.type_code.trim() : '';
    const workDate = typeof body.work_date === 'string' ? body.work_date : '';
    const shift = typeof body.shift === 'string' && body.shift ? body.shift : null;
    const slotNo = body.slot_no === null || body.slot_no === undefined ? null : Number(body.slot_no);
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (!isValidDate(workDate)) return jsonResponse({ error: '수당 날짜가 올바르지 않습니다.' }, 400);
    if (note.length > 500) return jsonResponse({ error: '메모는 500자 이내로 입력해 주세요.' }, 400);

    const type = await getAllowanceType(supabaseAdmin, typeCode);
    if (!type) return jsonResponse({ error: '수당 종류를 찾을 수 없습니다.' }, 400);
    const selectionError = validateSelection(type, shift, slotNo);
    if (selectionError) return jsonResponse({ error: selectionError }, 400);

    let targetUserId = auth.user.id;
    let targetUsername = auth.profile.name || auth.profile.username || '회원';
    if (auth.profile.role === 'admin' && typeof body.user_id === 'string' && body.user_id) {
      const { data: targetUser, error: targetError } = await supabaseAdmin
        .from('users')
        .select('id, name, username')
        .eq('id', body.user_id)
        .maybeSingle();
      if (targetError) throw targetError;
      if (!targetUser) return jsonResponse({ error: '대상 직원을 찾을 수 없습니다.' }, 404);
      targetUserId = targetUser.id;
      targetUsername = targetUser.name || targetUser.username || '회원';
    }

    const { data, error } = await supabaseAdmin
      .from('allowance_entries')
      .insert({
        user_id: targetUserId,
        username: targetUsername,
        type_code: type.code,
        type_label: type.label,
        work_date: workDate,
        shift,
        slot_no: slotNo,
        unit_amount: type.unit_amount,
        note
      })
      .select('id, user_id, username, type_code, type_label, work_date, shift, slot_no, unit_amount, note, created_at, updated_at')
      .single();
    if (error) {
      if (error.code === '23505') {
        return jsonResponse({ error: type.shift_options?.length
          ? `해당 날짜 ${shift === 'morning' ? '오전' : '오후'} 셔틀은 이미 등록되어 있습니다.`
          : `볼수거 ${slotNo}번은 이미 등록되어 있습니다.` }, 409);
      }
      throw error;
    }

    return jsonResponse({ success: true, entry: data }, 201);
  } catch (error) {
    console.error('수당 등록 오류:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}

export async function handleUpdateAllowance(request, supabaseAdmin, entryId) {
  try {
    const authorized = await getAuthorizedEntry(request, supabaseAdmin, entryId);
    if (authorized.response) return authorized.response;

    const { auth, entry } = authorized;
    const body = await request.json();
    const typeCode = typeof body.type_code === 'string' ? body.type_code.trim() : entry.type_code;
    const workDate = typeof body.work_date === 'string' ? body.work_date : entry.work_date;
    const shift = body.shift === undefined ? entry.shift : (typeof body.shift === 'string' && body.shift ? body.shift : null);
    const slotNo = body.slot_no === undefined ? entry.slot_no : (body.slot_no === null ? null : Number(body.slot_no));
    const note = typeof body.note === 'string' ? body.note.trim() : entry.note;
    if (!isValidDate(workDate)) return jsonResponse({ error: '수당 날짜가 올바르지 않습니다.' }, 400);
    if (note.length > 500) return jsonResponse({ error: '메모는 500자 이내로 입력해 주세요.' }, 400);

    const type = await getAllowanceType(supabaseAdmin, typeCode);
    if (!type) return jsonResponse({ error: '수당 종류를 찾을 수 없습니다.' }, 400);
    const selectionError = validateSelection(type, shift, slotNo);
    if (selectionError) return jsonResponse({ error: selectionError }, 400);

    const { data, error } = await supabaseAdmin
      .from('allowance_entries')
      .update({
        type_code: type.code,
        type_label: type.label,
        work_date: workDate,
        shift,
        slot_no: slotNo,
        unit_amount: type.unit_amount,
        note,
        updated_at: new Date().toISOString()
      })
      .eq('id', entry.id)
      .eq('user_id', auth.profile.role === 'admin' ? entry.user_id : auth.user.id)
      .select('id, user_id, username, type_code, type_label, work_date, shift, slot_no, unit_amount, note, created_at, updated_at')
      .maybeSingle();
    if (error) {
      if (error.code === '23505') {
        return jsonResponse({ error: type.shift_options?.length
          ? `해당 날짜 ${shift === 'morning' ? '오전' : '오후'} 셔틀은 이미 등록되어 있습니다.`
          : `볼수거 ${slotNo}번은 이미 등록되어 있습니다.` }, 409);
      }
      throw error;
    }
    if (!data) return jsonResponse({ error: '수당 기록을 수정하지 못했습니다.' }, 409);

    return jsonResponse({ success: true, entry: data });
  } catch (error) {
    console.error('수당 수정 오류:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}

export async function handleDeleteAllowance(request, supabaseAdmin, entryId) {
  try {
    const authorized = await getAuthorizedEntry(request, supabaseAdmin, entryId);
    if (authorized.response) return authorized.response;

    const { auth, entry } = authorized;
    const { error } = await supabaseAdmin
      .from('allowance_entries')
      .delete()
      .eq('id', entry.id)
      .eq('user_id', auth.profile.role === 'admin' ? entry.user_id : auth.user.id);
    if (error) throw error;

    return jsonResponse({ success: true });
  } catch (error) {
    console.error('수당 삭제 오류:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}
