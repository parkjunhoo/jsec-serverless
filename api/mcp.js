import { authenticateRequest, jsonResponse } from './push.js';
import { handleBulkCreateVacations } from './vacations.js';
import { handleGetAnnualLeave } from './annual-leave.js';

const MCP_PROTOCOL_VERSION = '2025-03-26';
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-03-26', '2025-06-18', '2025-11-25']);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_OFF_TOOL = 'create_my_days_off';

const MCP_TOOLS = [
  {
    name: DAY_OFF_TOOL,
    title: '내 휴무 등록',
    description: '로그인한 본인의 휴무를 같은 달에 여러 날짜 등록합니다. 날짜는 YYYY-MM-DD 형식의 확정된 미래 날짜만 전달하세요. 날짜가 모호하면 먼저 사용자에게 월과 연도를 확인하세요.',
    inputSchema: {
      type: 'object',
      properties: {
        dates: {
          type: 'array',
          items: { type: 'string', description: '휴무 날짜 (YYYY-MM-DD)' },
          minItems: 1,
          maxItems: 31
        }
      },
      required: ['dates'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  },
  {
    name: 'list_my_days_off',
    title: '내 휴무 조회',
    description: '로그인한 본인의 휴무 일정을 조회합니다. 기간은 최대 93일입니다.',
    inputSchema: {
      type: 'object',
      properties: {
        start: { type: 'string', description: '조회 시작일 (YYYY-MM-DD)' },
        end: { type: 'string', description: '조회 종료일 (YYYY-MM-DD)' }
      },
      required: ['start', 'end'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
  },
  {
    name: 'get_my_attendance',
    title: '내 근태 기록 조회',
    description: '로그인한 본인의 출퇴근 기록을 조회합니다. GPS 좌표와 기기 정보는 반환하지 않으며 기간은 최대 93일입니다.',
    inputSchema: {
      type: 'object',
      properties: {
        start: { type: 'string', description: '조회 시작일 (YYYY-MM-DD)' },
        end: { type: 'string', description: '조회 종료일 (YYYY-MM-DD)' }
      },
      required: ['start', 'end'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
  },
  {
    name: 'get_my_annual_leave_balance',
    title: '내 연차 잔여 일수 조회',
    description: '로그인한 본인의 연차 잔여 일수와 산정 기간을 조회합니다.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false }
  }
];

function isValidDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function jsonRpcResponse(id, result, status = 200) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

function jsonRpcError(id, code, message, status = 200) {
  return new Response(JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code, message }
  }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

function toolResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    isError
  };
}

function validateDateRange(start, end) {
  if (!isValidDate(start) || !isValidDate(end) || start > end
    || new Date(`${end}T00:00:00Z`) - new Date(`${start}T00:00:00Z`) > 93 * 24 * 60 * 60 * 1000) {
    throw new Error('조회 기간은 올바른 날짜로 1~93일 이내로 입력해 주세요.');
  }
}

async function readMyDaysOff(supabaseAdmin, userId, args) {
  validateDateRange(args.start, args.end);
  const { data, error } = await supabaseAdmin
    .from('vacations')
    .select('date, leave_type, time_detail, hours_used, memo')
    .eq('user_id', userId)
    .gte('date', args.start)
    .lte('date', args.end)
    .order('date', { ascending: true })
    .limit(100);
  if (error) throw error;
  return data || [];
}

async function readMyAttendance(supabaseAdmin, userId, args) {
  validateDateRange(args.start, args.end);
  const { data, error } = await supabaseAdmin
    .from('attendance_records')
    .select('work_date, location_name, check_in_at, check_out_at, note')
    .eq('user_id', userId)
    .gte('work_date', args.start)
    .lte('work_date', args.end)
    .is('deleted_at', null)
    .order('work_date', { ascending: false })
    .limit(100);
  if (error) throw error;
  return data || [];
}

async function readMyAnnualLeave(request, supabaseAdmin, userId) {
  const response = await handleGetAnnualLeave(request, supabaseAdmin);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '연차 현황을 불러오지 못했습니다.');
  return {
    asOfDate: result.asOfDate,
    balance: (result.balances || []).find(item => item.user_id === userId) || null
  };
}

async function callTool(request, supabaseAdmin, env, context, auth, name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('도구 입력값 형식이 올바르지 않습니다.');
  }
  if (['guest', 'monitor'].includes(auth.profile.role)) {
    throw new Error('이 계정은 AI 업무 도구를 사용할 수 없습니다.');
  }

  switch (name) {
    case DAY_OFF_TOOL: {
      const dates = args.dates;
      if (!Array.isArray(dates) || dates.length < 1 || dates.length > 31
        || dates.some(date => !isValidDate(date))
        || new Set(dates).size !== dates.length
        || new Set(dates.map(date => date.slice(0, 7))).size !== 1) {
        throw new Error('같은 달의 서로 다른 날짜를 1~31개 선택해 주세요.');
      }
      const todayKst = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
      if (dates.some(date => date < todayKst)) {
        throw new Error('지난 날짜에는 휴무를 등록할 수 없습니다.');
      }
      const bulkRequest = new Request(new URL('/api/vacations/bulk', request.url), {
        method: 'POST',
        headers: {
          Authorization: request.headers.get('Authorization') || '',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ dates })
      });
      const response = await handleBulkCreateVacations(bulkRequest, supabaseAdmin, env, context);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '휴무를 등록하지 못했습니다.');
      return { message: `${result.count}일 휴무를 등록했습니다.`, dates };
    }
    case 'list_my_days_off':
      return await readMyDaysOff(supabaseAdmin, auth.user.id, args);
    case 'get_my_attendance':
      return await readMyAttendance(supabaseAdmin, auth.user.id, args);
    case 'get_my_annual_leave_balance':
      return await readMyAnnualLeave(request, supabaseAdmin, auth.user.id);
    default:
      throw Object.assign(new Error(`알 수 없는 도구입니다: ${name}`), { code: -32602 });
  }
}

export async function handleMcpRequest(request, supabaseAdmin, env, context) {
  const auth = await authenticateRequest(request, supabaseAdmin);
  if (auth.error) return auth.error;

  const clientVersion = request.headers.get('MCP-Protocol-Version');
  if (clientVersion && !SUPPORTED_PROTOCOL_VERSIONS.has(clientVersion)) {
    return jsonRpcError(null, -32600, '지원하지 않는 MCP 프로토콜 버전입니다.', 400);
  }

  let message;
  try {
    message = await request.json();
  } catch {
    return jsonRpcError(null, -32700, 'JSON-RPC 요청을 읽을 수 없습니다.', 400);
  }
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return jsonRpcError(message?.id ?? null, -32600, '유효하지 않은 JSON-RPC 요청입니다.', 400);
  }
  if (!Object.hasOwn(message, 'id')) {
    if (message.method.startsWith('notifications/')) {
      return new Response(null, {
        status: 202,
        headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
      });
    }
    return jsonRpcError(null, -32600, '응답이 필요한 MCP 요청만 지원합니다.', 400);
  }

  if (message.method === 'initialize') {
    const requestedVersion = message.params?.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
      ? requestedVersion
      : MCP_PROTOCOL_VERSION;
    return jsonRpcResponse(message.id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'jsec-work-assistant', version: '1.0.0' },
      instructions: '이 서버는 로그인 사용자 본인의 근무 관련 데이터만 조회합니다. 휴무 등록은 사용자가 확인한 날짜만 실행하세요.'
    });
  }
  if (message.method === 'ping') return jsonRpcResponse(message.id, {});
  if (message.method === 'tools/list') return jsonRpcResponse(message.id, { tools: MCP_TOOLS });
  if (message.method !== 'tools/call') {
    return jsonRpcError(message.id, -32601, '지원하지 않는 MCP 메서드입니다.');
  }

  const name = message.params?.name;
  const args = message.params?.arguments || {};
  try {
    const value = await callTool(request, supabaseAdmin, env, context, auth, name, args);
    return jsonRpcResponse(message.id, toolResult(value));
  } catch (error) {
    if (error.code === -32602) return jsonRpcError(message.id, error.code, error.message);
    return jsonRpcResponse(message.id, toolResult(error.message || '도구 실행에 실패했습니다.', true));
  }
}
