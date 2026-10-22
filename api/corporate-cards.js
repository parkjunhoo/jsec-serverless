import { authenticateRequest, jsonResponse } from './push.js';

const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
const TABLE_FIELDS = 'id, spent_on, merchant, amount, category, cardholder, memo, receipt_content_type, receipt_size_bytes, created_by_name, created_at, updated_at';
const PRIVATE_FIELDS = `${TABLE_FIELDS}, receipt_object_key`;

function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isMonth(value) {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function isEntryId(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function readMultipartForm(request) {
  if (!request.body) {
    throw Object.assign(new Error('요청에 입력 내용이 없습니다.'), { status: 400 });
  }
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RECEIPT_BYTES + 64 * 1024) {
        await reader.cancel();
        throw Object.assign(new Error('영수증 사진은 5MB 이하로 올려 주세요.'), { status: 413 });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request.url, {
    method: 'POST',
    headers: { 'Content-Type': request.headers.get('Content-Type') || '' },
    body
  }).formData();
}

async function authorize(request, supabaseAdmin, write = false) {
  const auth = await authenticateRequest(request, supabaseAdmin);
  if (auth.error) return { response: auth.error };
  if (auth.profile.role !== 'admin' && auth.profile.role !== 'guest') {
    return { response: jsonResponse({ error: '법인카드 내역을 조회할 권한이 없습니다.' }, 403) };
  }
  if (write && auth.profile.role !== 'admin') {
    return { response: jsonResponse({ error: '관리자만 법인카드 내역을 관리할 수 있습니다.' }, 403) };
  }
  return { auth };
}

function publicEntry(entry) {
  const { receipt_object_key: objectKey, ...safeEntry } = entry;
  return safeEntry;
}

async function getEntry(supabaseAdmin, id) {
  const { data, error } = await supabaseAdmin
    .from('corporate_card_entries')
    .select(PRIVATE_FIELDS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function parseEntryBody(request, existing, auth) {
  let fields;
  let receipt = null;
  let removeReceipt = false;
  const contentType = (request.headers.get('Content-Type') || '').toLowerCase();

  if (contentType.startsWith('multipart/form-data')) {
    const declaredLength = Number(request.headers.get('Content-Length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RECEIPT_BYTES + 64 * 1024) {
      throw Object.assign(new Error('영수증 사진은 5MB 이하로 올려 주세요.'), { status: 413 });
    }
    const form = await readMultipartForm(request);
    fields = Object.fromEntries(
      ['spent_on', 'merchant', 'amount', 'category', 'cardholder', 'memo']
        .map(key => [key, form.get(key)])
    );
    removeReceipt = form.get('remove_receipt') === 'true';
    const file = form.get('receipt');
    if (file && typeof file === 'object' && typeof file.arrayBuffer === 'function' && file.size > 0) {
      if (file.size > MAX_RECEIPT_BYTES) {
        throw Object.assign(new Error('영수증 사진은 5MB 이하로 올려 주세요.'), { status: 413 });
      }
      receipt = new Uint8Array(await file.arrayBuffer());
      if (
        file.type !== 'image/jpeg' ||
        receipt.length < 4 ||
        receipt[0] !== 0xff || receipt[1] !== 0xd8 || receipt[2] !== 0xff ||
        receipt[receipt.length - 2] !== 0xff || receipt[receipt.length - 1] !== 0xd9
      ) {
        throw Object.assign(new Error('영수증은 JPEG 사진만 업로드할 수 있습니다.'), { status: 415 });
      }
    }
  } else {
    fields = await request.json();
  }

  const value = key => {
    const incoming = fields?.[key];
    return typeof incoming === 'string' ? incoming.trim() : incoming;
  };
  const spentOn = value('spent_on') ?? existing?.spent_on;
  const merchant = value('merchant') ?? existing?.merchant;
  const amountValue = value('amount') ?? existing?.amount;
  const amount = typeof amountValue === 'number' ? amountValue : Number(amountValue);
  const category = value('category') ?? existing?.category ?? '기타';
  const cardholder = value('cardholder') ?? existing?.cardholder ?? auth.profile.name ?? auth.profile.username;
  const memo = value('memo') ?? existing?.memo ?? '';

  if (!isDate(spentOn)) throw Object.assign(new Error('사용일을 올바르게 입력해 주세요.'), { status: 400 });
  if (typeof merchant !== 'string' || !merchant || merchant.length > 120) {
    throw Object.assign(new Error('가맹점은 1~120자로 입력해 주세요.'), { status: 400 });
  }
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1000000000) {
    throw Object.assign(new Error('사용 금액은 1원 이상 10억원 이하의 정수로 입력해 주세요.'), { status: 400 });
  }
  if (typeof category !== 'string' || !category || category.length > 40) {
    throw Object.assign(new Error('사용 항목을 1~40자로 입력해 주세요.'), { status: 400 });
  }
  if (typeof cardholder !== 'string' || !cardholder || cardholder.length > 60) {
    throw Object.assign(new Error('사용자는 1~60자로 입력해 주세요.'), { status: 400 });
  }
  if (typeof memo !== 'string' || memo.length > 1000) {
    throw Object.assign(new Error('비고는 1,000자 이내로 입력해 주세요.'), { status: 400 });
  }

  return {
    entry: { spent_on: spentOn, merchant, amount, category, cardholder, memo },
    receipt,
    removeReceipt
  };
}

function scheduleObjectDelete(bucket, objectKey, context) {
  if (!objectKey || !bucket) return;
  const deletion = bucket.delete(objectKey).catch(error => {
    console.error('법인카드 영수증 정리 오류:', error);
  });
  if (context?.waitUntil) context.waitUntil(deletion);
}

export async function handleListCorporateCards(request, supabaseAdmin) {
  try {
    const permission = await authorize(request, supabaseAdmin);
    if (permission.response) return permission.response;

    const url = new URL(request.url);
    const month = url.searchParams.get('month');
    if (month && !isMonth(month)) {
      return jsonResponse({ error: '조회할 월을 YYYY-MM 형식으로 입력해 주세요.' }, 400);
    }

    let query = supabaseAdmin
      .from('corporate_card_entries')
      .select(PRIVATE_FIELDS, { count: 'exact' })
      .order('spent_on', { ascending: false })
      .order('created_at', { ascending: false })
      .range(0, 999);
    if (month) {
      const [year, monthNumber] = month.split('-').map(Number);
      const start = `${month}-01`;
      const nextMonth = new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 10);
      query = query.gte('spent_on', start).lt('spent_on', nextMonth);
    }

    const { data, error, count } = await query;
    if (error) throw error;
    return jsonResponse({
      entries: (data || []).map(publicEntry),
      count: count || 0,
      hasMore: (count || 0) > 1000,
      role: permission.auth.profile.role
    });
  } catch (error) {
    console.error('법인카드 내역 조회 오류:', error);
    return jsonResponse({ error: error.message || '법인카드 내역을 불러오지 못했습니다.' }, 500);
  }
}

async function saveEntry(request, supabaseAdmin, env, context, id = '') {
  let uploadedObjectKey = '';
  try {
    const permission = await authorize(request, supabaseAdmin, true);
    if (permission.response) return permission.response;
    const { auth } = permission;
    if (id && !isEntryId(id)) return jsonResponse({ error: '법인카드 내역 ID가 올바르지 않습니다.' }, 400);
    const existing = id ? await getEntry(supabaseAdmin, id) : null;
    if (id && !existing) return jsonResponse({ error: '법인카드 내역을 찾을 수 없습니다.' }, 404);

    const parsed = await parseEntryBody(request, existing, auth);
    if (
      existing?.receipt_object_key &&
      (parsed.receipt || parsed.removeReceipt) &&
      !env.CORPCARD_RECEIPTS
    ) {
      return jsonResponse({ error: '영수증 사진 저장소가 설정되지 않았습니다.' }, 503);
    }
    let receiptObjectKey = existing?.receipt_object_key || null;
    let receiptContentType = existing?.receipt_content_type || null;
    let receiptSizeBytes = existing?.receipt_size_bytes || null;

    if (parsed.receipt) {
      if (!env.CORPCARD_RECEIPTS) {
        return jsonResponse({ error: '영수증 사진 저장소가 설정되지 않았습니다.' }, 503);
      }
      uploadedObjectKey = `corporate-card-receipts/${crypto.randomUUID()}.jpg`;
      await env.CORPCARD_RECEIPTS.put(uploadedObjectKey, parsed.receipt, {
        httpMetadata: { contentType: 'image/jpeg', cacheControl: 'private, no-store' }
      });
      receiptObjectKey = uploadedObjectKey;
      receiptContentType = 'image/jpeg';
      receiptSizeBytes = parsed.receipt.byteLength;
    } else if (parsed.removeReceipt) {
      receiptObjectKey = null;
      receiptContentType = null;
      receiptSizeBytes = null;
    }

    const values = {
      ...parsed.entry,
      receipt_object_key: receiptObjectKey,
      receipt_content_type: receiptContentType,
      receipt_size_bytes: receiptSizeBytes,
      updated_at: new Date().toISOString()
    };
    let query = supabaseAdmin.from('corporate_card_entries');
    query = id
      ? query.update(values).eq('id', id)
      : query.insert({
        ...values,
        created_by: auth.user.id,
        created_by_name: auth.profile.name || auth.profile.username || '관리자'
      });
    const { data, error } = await query.select(PRIVATE_FIELDS).single();
    if (error) throw error;

    if (existing?.receipt_object_key && existing.receipt_object_key !== receiptObjectKey) {
      scheduleObjectDelete(env.CORPCARD_RECEIPTS, existing.receipt_object_key, context);
    }
    uploadedObjectKey = '';
    return jsonResponse({ success: true, entry: publicEntry(data) }, id ? 200 : 201);
  } catch (error) {
    if (uploadedObjectKey) scheduleObjectDelete(env.CORPCARD_RECEIPTS, uploadedObjectKey, context);
    console.error('법인카드 내역 저장 오류:', error);
    return jsonResponse({ error: error.message || '법인카드 내역을 저장하지 못했습니다.' }, error.status || 500);
  }
}

export async function handleCreateCorporateCard(request, supabaseAdmin, env, context) {
  return saveEntry(request, supabaseAdmin, env, context);
}

export async function handleUpdateCorporateCard(request, supabaseAdmin, env, context, id) {
  return saveEntry(request, supabaseAdmin, env, context, id);
}

export async function handleDeleteCorporateCard(request, supabaseAdmin, env, context, id) {
  try {
    const permission = await authorize(request, supabaseAdmin, true);
    if (permission.response) return permission.response;
    if (!isEntryId(id)) return jsonResponse({ error: '법인카드 내역 ID가 올바르지 않습니다.' }, 400);

    const existing = await getEntry(supabaseAdmin, id);
    if (!existing) return jsonResponse({ error: '법인카드 내역을 찾을 수 없습니다.' }, 404);
    if (existing.receipt_object_key && !env.CORPCARD_RECEIPTS) {
      return jsonResponse({ error: '영수증 사진 저장소가 설정되지 않았습니다.' }, 503);
    }
    const { data, error } = await supabaseAdmin
      .from('corporate_card_entries')
      .delete()
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) return jsonResponse({ error: '법인카드 내역을 찾을 수 없습니다.' }, 404);
    scheduleObjectDelete(env.CORPCARD_RECEIPTS, existing.receipt_object_key, context);
    return jsonResponse({ success: true });
  } catch (error) {
    console.error('법인카드 내역 삭제 오류:', error);
    return jsonResponse({ error: error.message || '법인카드 내역을 삭제하지 못했습니다.' }, 500);
  }
}

export async function handleGetCorporateCardReceipt(request, supabaseAdmin, env, id) {
  try {
    const permission = await authorize(request, supabaseAdmin);
    if (permission.response) return permission.response;
    if (!isEntryId(id)) return jsonResponse({ error: '법인카드 내역 ID가 올바르지 않습니다.' }, 400);
    if (!env.CORPCARD_RECEIPTS) {
      return jsonResponse({ error: '영수증 사진 저장소가 설정되지 않았습니다.' }, 503);
    }
    const entry = await getEntry(supabaseAdmin, id);
    if (!entry) return jsonResponse({ error: '법인카드 내역을 찾을 수 없습니다.' }, 404);
    if (!entry.receipt_object_key) return jsonResponse({ error: '첨부된 영수증 사진이 없습니다.' }, 404);

    const object = await env.CORPCARD_RECEIPTS.get(entry.receipt_object_key);
    if (!object) return jsonResponse({ error: '영수증 사진 파일을 찾을 수 없습니다.' }, 404);
    return new Response(object.body, {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (error) {
    console.error('법인카드 영수증 조회 오류:', error);
    return jsonResponse({ error: error.message || '영수증 사진을 불러오지 못했습니다.' }, 500);
  }
}
