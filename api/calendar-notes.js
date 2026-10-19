import { authenticateRequest, jsonResponse } from './push.js';

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function requireAdmin(auth) {
  if (auth.error) return auth.error;
  if (auth.profile.role !== 'admin') {
    return jsonResponse({ error: '관리자만 달력 메모를 관리할 수 있습니다.' }, 403);
  }
  return null;
}

export async function handleListCalendarNotes(request, supabaseAdmin) {
  try {
    const auth = await authenticateRequest(request, supabaseAdmin);
    if (auth.error) return auth.error;

    const url = new URL(request.url);
    const start = url.searchParams.get('start');
    const end = url.searchParams.get('end');
    if (!start || !end || !isValidDate(start) || !isValidDate(end) || start > end) {
      return jsonResponse({ error: '조회할 날짜 범위가 올바르지 않습니다.' }, 400);
    }

    const { data, error } = await supabaseAdmin
      .from('calendar_notes')
      .select('date, emoji, content')
      .gte('date', start)
      .lte('date', end)
      .order('date', { ascending: true });
    if (error) throw error;
    return jsonResponse(data);
  } catch (error) {
    console.error('달력 메모 조회 오류:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}

export async function handleSaveCalendarNote(request, supabaseAdmin) {
  try {
    const auth = await authenticateRequest(request, supabaseAdmin);
    const denied = requireAdmin(auth);
    if (denied) return denied;

    const body = await request.json();
    const date = typeof body.date === 'string' ? body.date : '';
    const emoji = typeof body.emoji === 'string' ? body.emoji.trim() : '';
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!isValidDate(date)) return jsonResponse({ error: '메모 날짜가 올바르지 않습니다.' }, 400);
    if ([...emoji].length > 8) {
      return jsonResponse({ error: '이모지는 8자 이내로 입력해 주세요.' }, 400);
    }
    if (content.length > 500) {
      return jsonResponse({ error: '메모는 500자 이내로 입력해 주세요.' }, 400);
    }
    if (!emoji && !content) {
      return jsonResponse({ error: '메모 내용 또는 이모지를 입력해 주세요.' }, 400);
    }

    const { data, error } = await supabaseAdmin
      .from('calendar_notes')
      .upsert({
        date,
        emoji,
        content,
        updated_by: auth.user.id,
        updated_at: new Date().toISOString()
      }, { onConflict: 'date' })
      .select('date, emoji, content')
      .single();
    if (error) throw error;
    return jsonResponse({ success: true, note: data });
  } catch (error) {
    console.error('달력 메모 저장 오류:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}

export async function handleDeleteCalendarNote(request, supabaseAdmin, date) {
  try {
    const auth = await authenticateRequest(request, supabaseAdmin);
    const denied = requireAdmin(auth);
    if (denied) return denied;
    if (!isValidDate(date)) return jsonResponse({ error: '메모 날짜가 올바르지 않습니다.' }, 400);

    const { data, error } = await supabaseAdmin
      .from('calendar_notes')
      .delete()
      .eq('date', date)
      .select('date')
      .maybeSingle();
    if (error) throw error;
    if (!data) return jsonResponse({ error: '해당 날짜의 메모를 찾을 수 없습니다.' }, 404);
    return jsonResponse({ success: true });
  } catch (error) {
    console.error('달력 메모 삭제 오류:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}
