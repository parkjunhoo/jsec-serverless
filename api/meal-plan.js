import { authenticateRequest, jsonResponse } from './push.js';

const MAX_IMAGE_BYTES = 1024 * 1024;
const MEAL_PLAN_FIELDS = 'week_start, venue, size_bytes, uploaded_by_name, uploaded_at';
const MEAL_PLAN_VENUES = new Set(['golf', 'ski']);

function isMondayDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value &&
    date.getUTCDay() === 1;
}

function getVenue(request) {
  const venue = new URL(request.url).searchParams.get('venue') || 'golf';
  return MEAL_PLAN_VENUES.has(venue) ? venue : null;
}

async function readImageBody(request) {
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
    throw Object.assign(new Error('압축된 사진은 1MB 이하로 올려 주세요.'), { status: 413 });
  }
  if (!request.body) {
    throw Object.assign(new Error('업로드할 사진이 없습니다.'), { status: 400 });
  }

  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw Object.assign(new Error('압축된 사진은 1MB 이하로 올려 주세요.'), { status: 413 });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const image = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    image.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return image;
}

function scheduleObjectDelete(bucket, objectKey, context) {
  if (!objectKey) return;
  const deletion = bucket.delete(objectKey).catch(error => {
    console.error('식단표 사진 정리 오류:', error);
  });
  if (context?.waitUntil) context.waitUntil(deletion);
}

export async function handleGetMealPlan(request, supabaseAdmin) {
  try {
    const auth = await authenticateRequest(request, supabaseAdmin);
    if (auth.error) return auth.error;

    const weekStart = new URL(request.url).searchParams.get('week');
    if (!isMondayDate(weekStart)) {
      return jsonResponse({ error: '조회할 주의 월요일 날짜가 올바르지 않습니다.' }, 400);
    }
    const venue = getVenue(request);
    if (!venue) return jsonResponse({ error: '식단표 구분이 올바르지 않습니다.' }, 400);

    const { data, error } = await supabaseAdmin
      .from('meal_plans')
      .select(MEAL_PLAN_FIELDS)
      .eq('week_start', weekStart)
      .eq('venue', venue)
      .maybeSingle();
    if (error) throw error;
    if (!data) return jsonResponse({ mealPlan: null });

    return jsonResponse({ mealPlan: data });
  } catch (error) {
    console.error('식단표 조회 오류:', error);
    return jsonResponse({ error: error.message || '식단표를 불러오지 못했습니다.' }, 500);
  }
}

export async function handleGetMealPlanImage(request, supabaseAdmin, env) {
  try {
    const auth = await authenticateRequest(request, supabaseAdmin);
    if (auth.error) return auth.error;
    if (!env.MEAL_PLAN_IMAGES) {
      return jsonResponse({ error: '식단표 이미지 저장소가 설정되지 않았습니다.' }, 503);
    }

    const weekStart = new URL(request.url).searchParams.get('week');
    if (!isMondayDate(weekStart)) {
      return jsonResponse({ error: '조회할 주의 월요일 날짜가 올바르지 않습니다.' }, 400);
    }
    const venue = getVenue(request);
    if (!venue) return jsonResponse({ error: '식단표 구분이 올바르지 않습니다.' }, 400);

    const { data, error } = await supabaseAdmin
      .from('meal_plans')
      .select('object_key')
      .eq('week_start', weekStart)
      .eq('venue', venue)
      .maybeSingle();
    if (error) throw error;
    if (!data) return jsonResponse({ error: '해당 주의 식단표 사진이 없습니다.' }, 404);

    const object = await env.MEAL_PLAN_IMAGES.get(data.object_key);
    if (!object) return jsonResponse({ error: '식단표 사진 파일을 찾을 수 없습니다.' }, 404);
    return new Response(object.body, {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (error) {
    console.error('식단표 사진 조회 오류:', error);
    return jsonResponse({ error: error.message || '식단표 사진을 불러오지 못했습니다.' }, 500);
  }
}

export async function handleSaveMealPlan(request, supabaseAdmin, env, context) {
  try {
    const auth = await authenticateRequest(request, supabaseAdmin);
    if (auth.error) return auth.error;
    if (!env.MEAL_PLAN_IMAGES) {
      return jsonResponse({ error: '식단표 이미지 저장소가 설정되지 않았습니다.' }, 503);
    }

    const weekStart = new URL(request.url).searchParams.get('week');
    if (!isMondayDate(weekStart)) {
      return jsonResponse({ error: '업로드할 주의 월요일 날짜가 올바르지 않습니다.' }, 400);
    }
    const venue = getVenue(request);
    if (!venue) return jsonResponse({ error: '식단표 구분이 올바르지 않습니다.' }, 400);
    if ((request.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase() !== 'image/jpeg') {
      return jsonResponse({ error: '압축된 JPEG 사진만 업로드할 수 있습니다.' }, 415);
    }

    const image = await readImageBody(request);
    if (
      image.byteLength < 3 ||
      image[0] !== 0xff ||
      image[1] !== 0xd8 ||
      image[2] !== 0xff ||
      image[image.byteLength - 2] !== 0xff ||
      image[image.byteLength - 1] !== 0xd9
    ) {
      return jsonResponse({ error: '올바른 JPEG 사진 파일이 아닙니다.' }, 415);
    }

    const { data: existing, error: lookupError } = await supabaseAdmin
      .from('meal_plans')
      .select('object_key')
      .eq('week_start', weekStart)
      .eq('venue', venue)
      .maybeSingle();
    if (lookupError) throw lookupError;

    const objectKey = `meal-plans/${venue}/${weekStart}/${crypto.randomUUID()}.jpg`;
    await env.MEAL_PLAN_IMAGES.put(objectKey, image, {
      httpMetadata: {
        contentType: 'image/jpeg',
        cacheControl: 'private, no-store'
      }
    });

    let saved;
    try {
      const { data, error } = await supabaseAdmin
        .from('meal_plans')
        .upsert({
          week_start: weekStart,
          venue,
          object_key: objectKey,
          size_bytes: image.byteLength,
          uploaded_by: auth.user.id,
          uploaded_by_name: auth.profile.name || auth.profile.username || '회원',
          uploaded_at: new Date().toISOString()
        }, { onConflict: 'week_start,venue' })
        .select(MEAL_PLAN_FIELDS)
        .single();
      if (error) throw error;
      saved = data;
    } catch (error) {
      scheduleObjectDelete(env.MEAL_PLAN_IMAGES, objectKey, context);
      throw error;
    }

    if (existing?.object_key) {
      scheduleObjectDelete(env.MEAL_PLAN_IMAGES, existing.object_key, context);
    }
    return jsonResponse({ success: true, mealPlan: saved });
  } catch (error) {
    console.error('식단표 사진 업로드 오류:', error);
    return jsonResponse(
      { error: error.message || '식단표 사진을 업로드하지 못했습니다.' },
      error.status || 500
    );
  }
}
