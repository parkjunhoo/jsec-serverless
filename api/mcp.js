import { authenticateRequest, jsonResponse } from './push.js';
import {
  handleBulkCreateVacations,
  handleCreateVacation,
  handleDeleteVacation,
  handleUpdateVacation
} from './vacations.js';
import { handleGetAnnualLeave } from './annual-leave.js';
import { handleGetWeather } from './weather.js';

const MCP_PROTOCOL_VERSION = '2025-03-26';
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-03-26', '2025-06-18', '2025-11-25']);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY_OFF_TOOL = 'create_my_days_off';
const ADMIN_ONLY_TOOLS = new Set([
  'list_employees',
  'search_employees',
  'get_employee_attendance',
  'list_employee_days_off',
  'create_employee_days_off',
  'update_employee_day_off',
  'delete_employee_day_off'
]);
const MCP_TOOLS = [
  {
    name: DAY_OFF_TOOL,
    title: '내 휴무 등록',
    description: '로그인한 본인의 휴무를 같은 달에 여러 날짜 등록합니다. 사용자가 "12월 5일" 또는 "5일, 6일, 8일"처럼 자연어로 말한 날짜를 해석해 YYYY-MM-DD 배열로 전달하세요. 형식을 사용자에게 되묻지 마세요. 월이 빠졌으면 현재 서울 날짜 기준으로 가장 가까운 미래의 해당 날짜를 사용하고, 해석이 불가능할 때만 월을 질문하세요. 등록 전 확인은 화면의 확인 버튼으로 한 번만 받습니다.',
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
    name: 'suggest_my_days_off',
    title: '조건에 맞는 휴무 날짜 추천',
    description: '사용자가 골프장 야간 근무자 및 지정 직원의 휴무일과 겹치지 않도록 무작위 휴무를 요청하면 호출합니다. 본인, 골프장 야간 근무자, exclude_name 직원의 해당 월 기존 휴무를 확인해 조건에 맞는 날짜를 추천합니다. 이 도구는 조회만 합니다. 사용자가 휴무 등록도 요청했다면 반환된 날짜를 create_my_days_off에 전달해 확인 버튼을 받으세요.',
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'integer', description: '요청한 연도' },
        month: { type: 'integer', description: '요청한 월 (1~12)' },
        count: { type: 'integer', description: '추천할 날짜 개수 (1~31)' },
        exclude_name: { type: 'string', description: '휴무일이 겹치지 않게 할 직원 이름' }
      },
      required: ['year', 'month', 'count', 'exclude_name'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
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
    name: 'list_team_days_off',
    title: '팀 휴무자 조회',
    description: '로그인한 일반 사용자도 사용할 수 있습니다. 지정한 날짜/기간의 휴무자 이름과 휴무 종류를 조회합니다. "내일 휴무자 누구야?"는 서울 기준 내일 하루를 조회하고, 최대 31일만 조회하세요. 업무에 필요한 이름·날짜·휴무종류만 반환합니다.',
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
  },
  {
    name: 'update_my_day_off',
    title: '내 휴무 수정',
    description: '휴무 목록에서 확인한 vacation_id의 본인 일정을 수정합니다. 실행 전 화면 확인 버튼이 한 번 표시됩니다.',
    inputSchema: {
      type: 'object',
      properties: {
        vacation_id: { type: 'string', format: 'uuid', description: '내 휴무 조회 결과의 UUID id' },
        old_date: { type: 'string', description: '수정할 일정의 현재 날짜 (YYYY-MM-DD)' },
        date: { type: 'string', description: '변경할 날짜 (YYYY-MM-DD)' },
        leave_type: { type: 'string', enum: ['휴무', '시간차', '공가'] },
        time_detail: { type: 'string', enum: ['종일', '시간지정'] },
        hours_used: { type: 'number', description: '시간차 시간 지정 시 사용 시간' },
        memo: { type: 'string', description: '비고 (없으면 빈 문자열)' }
      },
      required: ['vacation_id', 'old_date', 'date', 'leave_type', 'time_detail', 'memo'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  },
  {
    name: 'delete_my_days_off',
    title: '내 월간 휴무 일괄 삭제',
    description: '로그인한 본인의 지정 월에 등록된 일반 휴무를 한 번에 삭제하는 유일한 휴무 삭제 도구입니다. "내 12월 휴무 다 지워줘"처럼 요청하면 현재 한국시간 기준 연도와 요청한 월을 year/month로 지정해 이 도구를 정확히 한 번 호출하세요. 삭제할 날짜를 각각 호출하지 말고 vacation_id도 전달하지 마세요. 승인 연차는 유지하고 제외 건수를 안내합니다. 화면 확인 버튼을 누르기 전에는 실제 삭제되지 않습니다.',
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'integer', description: '삭제할 연도 (현재 한국시간 기준)' },
        month: { type: 'integer', description: '삭제할 월 (1~12)' }
      },
      required: ['year', 'month'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  },
  {
    name: 'get_resort_weather',
    title: '리조트 날씨 조회',
    description: '기상청 API로 지산리조트 또는 지정 위치의 현재 날씨와 시간별 예보를 조회합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        latitude: { type: 'number', description: '선택 위치 위도 (선택)' },
        longitude: { type: 'number', description: '선택 위치 경도 (선택)' },
        location_name: { type: 'string', description: '위치 이름 (선택)' }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
  },
  {
    name: 'search_vehicles',
    title: '차량 조회',
    description: '차량 번호, 이름, 부서 또는 차량명으로 등록 차량을 조회합니다. 검색어를 한 가지 입력하세요.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 1, maxLength: 80 } },
      required: ['query'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
  },
  {
    name: 'get_weekly_meal_plan',
    title: '주간 식단표 읽기',
    description: '골프장 또는 스키장의 지정 날짜가 포함된 주간 식단표 이미지를 읽습니다. 반환된 이미지를 보고 질문한 날짜의 메뉴를 안내하세요. date를 생략하면 오늘 기준입니다.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '식단을 확인할 날짜 (YYYY-MM-DD, 기본 오늘)' },
        venue: { type: 'string', enum: ['golf', 'ski'], description: '시설 구분 (기본 golf)' }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
  },
  {
    name: 'search_phonebook',
    title: '지산 연락망 검색',
    description: '부서명, 직원 이름, 직책 또는 세부 부서로 지산 연락망을 검색해 이름과 업무용 전화번호를 안내합니다.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 1, maxLength: 80 } },
      required: ['query'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
  },
  {
    name: 'list_employees',
    title: '회사 직원 목록 (관리자)',
    description: '관리자 전용. 재직 중인 회사 직원 목록을 이름, 권한, 직책, 근무지, 업무 연락처로 조회합니다. 로그인 계정·비밀번호 정보는 반환하지 않습니다. "회사원 목록", "직원 전체 명단" 요청에 사용하세요.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
  },
  {
    name: 'search_employees',
    title: '직원 정보 검색 (관리자)',
    description: '관리자 전용. 직원 이름으로 기본 업무 정보를 조회합니다. 재직 상태, 부서/근무지, 직책, 업무 연락처만 검색하며 로그인 계정·비밀번호 관련 정보는 조회하지 않습니다.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', minLength: 1, maxLength: 80 } },
      required: ['name'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
  },
  {
    name: 'get_employee_attendance',
    title: '직원 근태 조회 (관리자)',
    description: '관리자 전용. 직원의 정확한 이름과 기간을 지정해 업무용 출퇴근 기록을 조회합니다. 기간은 최대 93일이며 GPS 좌표와 기기 정보는 반환하지 않습니다.',
    inputSchema: {
      type: 'object',
      properties: {
        employee_name: { type: 'string', minLength: 1, maxLength: 80 },
        start: { type: 'string', description: '조회 시작일 (YYYY-MM-DD)' },
        end: { type: 'string', description: '조회 종료일 (YYYY-MM-DD)' }
      },
      required: ['employee_name', 'start', 'end'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
  },
  {
    name: 'list_employee_days_off',
    title: '직원 휴무 조회 (관리자)',
    description: '관리자 전용. 직원의 정확한 이름과 기간을 지정해 휴무 일정을 조회합니다. 기간은 최대 93일입니다.',
    inputSchema: {
      type: 'object',
      properties: {
        employee_name: { type: 'string', minLength: 1, maxLength: 80 },
        start: { type: 'string', description: '조회 시작일 (YYYY-MM-DD)' },
        end: { type: 'string', description: '조회 종료일 (YYYY-MM-DD)' }
      },
      required: ['employee_name', 'start', 'end'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
  },
  {
    name: 'create_employee_days_off',
    title: '직원 휴무 등록 (관리자)',
    description: '관리자 전용. 정확한 직원 이름의 휴무를 같은 달의 미래 날짜로 등록합니다. 등록 전 화면 확인 버튼을 한 번 누릅니다.',
    inputSchema: {
      type: 'object',
      properties: {
        employee_name: { type: 'string', minLength: 1, maxLength: 80 },
        dates: {
          type: 'array',
          items: { type: 'string', description: '휴무 날짜 (YYYY-MM-DD)' },
          minItems: 1,
          maxItems: 31
        },
        memo: { type: 'string', maxLength: 500 }
      },
      required: ['employee_name', 'dates'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  },
  {
    name: 'update_employee_day_off',
    title: '직원 휴무 수정 (관리자)',
    description: '관리자 전용. 직원 이름과 기존 날짜로 일정을 찾아 수정합니다. 같은 직원의 같은 날짜 일정이 여러 건이면 실행하지 않고 상세 조건을 묻습니다. 실행 전 화면 확인 버튼을 한 번 누릅니다.',
    inputSchema: {
      type: 'object',
      properties: {
        employee_name: { type: 'string', minLength: 1, maxLength: 80 },
        old_date: { type: 'string', description: '수정 전 날짜 (YYYY-MM-DD)' },
        old_leave_type: { type: 'string', enum: ['휴무', '시간차', '공가'], description: '같은 날짜 일정이 여러 건인 경우 수정할 기존 일정 종류' },
        date: { type: 'string', description: '수정 후 날짜 (YYYY-MM-DD)' },
        leave_type: { type: 'string', enum: ['휴무', '시간차', '공가'] },
        time_detail: { type: 'string', enum: ['종일', '시간지정'] },
        hours_used: { type: 'number', description: '시간차 시간 지정 시 사용 시간' },
        memo: { type: 'string' }
      },
      required: ['employee_name', 'old_date', 'date', 'leave_type', 'time_detail', 'memo'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  },
  {
    name: 'delete_employee_day_off',
    title: '직원 휴무 삭제 (관리자)',
    description: '관리자 전용. 직원 이름과 날짜로 일정을 찾아 삭제합니다. 같은 날짜 일정이 여러 건이면 실행하지 않고 상세 조건을 묻습니다. 실행 전 화면 확인 버튼을 한 번 누릅니다.',
    inputSchema: {
      type: 'object',
      properties: {
        employee_name: { type: 'string', minLength: 1, maxLength: 80 },
        date: { type: 'string', description: '삭제할 날짜 (YYYY-MM-DD)' },
        leave_type: { type: 'string', enum: ['휴무', '시간차', '공가'], description: '같은 날짜 일정이 여러 건인 경우 삭제할 일정 종류' }
      },
      required: ['employee_name', 'date'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
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
    .select('id, date, leave_type, time_detail, hours_used, memo')
    .eq('user_id', userId)
    .gte('date', args.start)
    .lte('date', args.end)
    .order('date', { ascending: true })
    .limit(100);
  if (error) throw error;
  return data || [];
}

async function readTeamDaysOff(supabaseAdmin, args) {
  validateDateRange(args.start, args.end);
  if (new Date(`${args.end}T00:00:00Z`) - new Date(`${args.start}T00:00:00Z`) > 30 * 24 * 60 * 60 * 1000) {
    throw new Error('팀 휴무자 조회는 한 번에 최대 31일까지만 가능합니다.');
  }
  const { data, error } = await supabaseAdmin
    .from('vacations')
    .select('date, username, leave_type, time_detail, hours_used')
    .gte('date', args.start)
    .lte('date', args.end)
    .order('date', { ascending: true })
    .order('username', { ascending: true })
    .limit(500);
  if (error) throw error;
  return (data || []).map(item => ({
    name: item.username || '이름 미등록',
    date: item.date,
    leave_type: item.leave_type,
    time_detail: item.time_detail,
    ...(item.hours_used === null || item.hours_used === undefined ? {} : { hours_used: item.hours_used })
  }));
}

async function suggestMyDaysOff(supabaseAdmin, userId, args) {
  if (!Number.isInteger(args.year) || args.year < 2000 || args.year > 2100
    || !Number.isInteger(args.month) || args.month < 1 || args.month > 12
    || !Number.isInteger(args.count) || args.count < 1 || args.count > 31) {
    throw new Error('연도, 월 또는 휴무 개수가 올바르지 않습니다.');
  }
  const excludeName = requireSearchTerm(args.exclude_name, '제외할 직원 이름');
  const start = `${args.year}-${String(args.month).padStart(2, '0')}-01`;
  const endDate = new Date(Date.UTC(args.year, args.month, 0));
  const end = `${args.year}-${String(args.month).padStart(2, '0')}-${String(endDate.getUTCDate()).padStart(2, '0')}`;
  const today = koreaDateString();
  if (end < today) throw new Error('지난 달에는 휴무를 등록할 수 없습니다.');

  const { data: golfEmployees, error: golfEmployeesError } = await supabaseAdmin
    .from('users')
    .select('id, name, work_location, status')
    .ilike('work_location', '%골프장%')
    .limit(1001);
  if (golfEmployeesError) throw golfEmployeesError;
  if ((golfEmployees || []).length > 1000) {
    throw new Error('골프장 직원 정보가 너무 많아 조건을 확인할 수 없습니다.');
  }
  const activeGolfNightEmployees = (golfEmployees || []).filter(employee =>
    employee.status !== '퇴직' && (employee.work_location || '').includes('야간')
  );
  if (!activeGolfNightEmployees.length) {
    throw new Error('골프장 야간 근무 직원 정보를 찾지 못해 조건을 적용할 수 없습니다.');
  }
  const excludedEmployee = await findEmployeeByName(supabaseAdmin, excludeName);
  const excludedUserIds = new Set([
    userId,
    excludedEmployee.id,
    ...activeGolfNightEmployees.map(employee => employee.id)
  ]);
  const { data: vacations, error: vacationsError } = await supabaseAdmin
    .from('vacations')
    .select('user_id, date')
    .in('user_id', [...excludedUserIds])
    .gte('date', start)
    .lte('date', end)
    .limit(2001);
  if (vacationsError) throw vacationsError;
  if ((vacations || []).length > 2000) {
    throw new Error('해당 월 휴무 기록이 너무 많아 후보 날짜를 안전하게 계산할 수 없습니다.');
  }

  const excludedDates = new Set((vacations || []).map(vacation => vacation.date));
  const candidates = [];
  for (let date = new Date(`${start}T00:00:00Z`); date <= endDate; date.setUTCDate(date.getUTCDate() + 1)) {
    const value = date.toISOString().slice(0, 10);
    if (value >= today && !excludedDates.has(value)) candidates.push(value);
  }
  if (candidates.length < args.count) {
    throw new Error(`조건에 맞는 날짜가 ${candidates.length}일뿐이라 ${args.count}일을 선택할 수 없습니다.`);
  }

  for (let index = candidates.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [candidates[index], candidates[swapIndex]] = [candidates[swapIndex], candidates[index]];
  }
  const dates = candidates.slice(0, args.count).sort();
  return {
    dates,
    month: start.slice(0, 7),
    excludedDatesCount: excludedDates.size,
    golfNightEmployeeCount: activeGolfNightEmployees.length,
    requestedCount: args.count
  };
}

function getInternalRequest(request, pathname, method = 'GET', body) {
  return new Request(new URL(pathname, request.url), {
    method,
    headers: {
      Authorization: request.headers.get('Authorization') || '',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

function assertAdmin(auth) {
  if (auth.profile.role !== 'admin') {
    throw new Error('이 도구는 관리자 계정만 사용할 수 있습니다.');
  }
}

function requireSearchTerm(value, label = '검색어') {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 80 || !/^[\p{L}\p{N}\s.-]+$/u.test(text)) {
    throw new Error(`${label}는 한글·영문·숫자·공백·마침표·하이픈으로 1~80자 이내 입력해 주세요.`);
  }
  return text;
}

async function findEmployeeByName(supabaseAdmin, name) {
  const employeeName = requireSearchTerm(name, '직원 이름');
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, name, username, role, status')
    .eq('name', employeeName)
    .limit(20);
  if (error) throw error;
  const activeEmployees = (data || []).filter(item => item.status !== '퇴직');
  if (!activeEmployees.length) throw new Error(`재직 중인 "${employeeName}" 직원을 찾을 수 없습니다.`);
  if (activeEmployees.length > 1) throw new Error(`"${employeeName}" 이름의 직원이 여러 명입니다. 고유한 직원 이름을 확인해 주세요.`);
  return activeEmployees[0];
}

async function findEmployeeVacation(supabaseAdmin, employeeId, date, leaveType) {
  if (!isValidDate(date)) throw new Error('휴무 날짜는 YYYY-MM-DD 형식으로 입력해 주세요.');
  let query = supabaseAdmin
    .from('vacations')
    .select('id, date, leave_type, time_detail, hours_used, memo, user_id, username')
    .eq('user_id', employeeId)
    .eq('date', date);
  if (leaveType) query = query.eq('leave_type', leaveType);
  const { data, error } = await query.limit(2);
  if (error) throw error;
  if (!data?.length) throw new Error(`${date} 날짜의 지정한 휴무 일정을 찾을 수 없습니다.`);
  if (data.length > 1) throw new Error(`${date} 날짜에 일정이 여러 건 있습니다. 기존 일정 종류를 지정해 주세요.`);
  return data[0];
}

function toBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function koreaDateString(date = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function formatKoreaDateTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('근태 기록의 시간이 올바르지 않습니다.');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} KST`;
}

function getMonday(value) {
  if (!isValidDate(value)) throw new Error('식단표 날짜가 올바르지 않습니다.');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}

async function readMealPlanImage(supabaseAdmin, env, args) {
  if (!env.MEAL_PLAN_IMAGES) throw new Error('식단표 이미지 저장소가 설정되지 않았습니다.');
  const venue = args.venue || 'golf';
  if (!['golf', 'ski'].includes(venue)) throw new Error('시설 구분은 golf 또는 ski로 지정해 주세요.');
  const weekStart = getMonday(args.date || koreaDateString());
  const { data: plan, error } = await supabaseAdmin
    .from('meal_plans')
    .select('object_key, week_start, venue')
    .eq('week_start', weekStart)
    .eq('venue', venue)
    .maybeSingle();
  if (error) throw error;
  if (!plan) return { found: false, weekStart, venue };
  const object = await env.MEAL_PLAN_IMAGES.get(plan.object_key);
  if (!object) throw new Error('식단표 이미지 파일을 찾을 수 없습니다.');
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (!bytes.length || bytes.length > 1024 * 1024) {
    throw new Error('식단표 이미지 크기가 챗봇 분석 한도(1MB)를 초과합니다.');
  }
  return {
    found: true,
    weekStart,
    venue,
    mimeType: object.httpMetadata?.contentType || 'image/jpeg',
    imageBase64: toBase64(bytes)
  };
}

async function readWeather(request, supabaseAdmin, env, context, args) {
  const hasLatitude = args.latitude !== undefined;
  const hasLongitude = args.longitude !== undefined;
  if (hasLatitude !== hasLongitude) throw new Error('위도와 경도를 함께 지정해 주세요.');
  const url = new URL('/api/weather', request.url);
  if (hasLatitude) {
    url.searchParams.set('lat', String(args.latitude));
    url.searchParams.set('lon', String(args.longitude));
    if (typeof args.location_name === 'string') url.searchParams.set('name', args.location_name);
  } else if (args.location_name) {
    throw new Error('위치 이름을 지정할 때는 위도와 경도도 함께 지정해 주세요.');
  }
  const response = await handleGetWeather(
    new Request(url, { headers: { Authorization: request.headers.get('Authorization') || '' } }),
    supabaseAdmin,
    env,
    context
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '날씨 정보를 가져오지 못했습니다.');
  return {
    location: result.location,
    provider: result.provider,
    observedAt: result.observedAt,
    current: result.current,
    hourly: result.hourly || []
  };
}

async function searchVehicles(supabaseAdmin, args) {
  const query = requireSearchTerm(args.query);
  const pattern = `%${query}%`;
  const fields = 'id, number, full_number, name, department, car_name, phone, notes';
  const results = await Promise.all(['number', 'full_number', 'name', 'department', 'car_name'].map(field =>
    supabaseAdmin.from('skicar_data')
      .select(fields)
      .ilike(field, pattern)
      .order('number', { ascending: true })
      .limit(20)
  ));
  const firstError = results.find(result => result.error)?.error;
  if (firstError) throw firstError;
  const vehicles = new Map();
  results.forEach(result => (result.data || []).forEach(item => vehicles.set(item.id, item)));
  return [...vehicles.values()].slice(0, 30);
}

async function searchPhonebook(supabaseAdmin, args) {
  const query = requireSearchTerm(args.query);
  const pattern = `%${query}%`;
  const fields = 'department, sub_department, position, name, phone_number';
  const results = await Promise.all(['department', 'sub_department', 'position', 'name'].map(field =>
    supabaseAdmin.from('phonebook')
      .select(fields)
      .ilike(field, pattern)
      .order('department')
      .order('name')
      .limit(30)
  ));
  const firstError = results.find(result => result.error)?.error;
  if (firstError) throw firstError;
  const contacts = new Map();
  results.forEach(result => (result.data || []).forEach(contact =>
    contacts.set(`${contact.department}|${contact.name}|${contact.phone_number}`, contact)
  ));
  return [...contacts.values()].slice(0, 40);
}

async function searchEmployees(supabaseAdmin, args) {
  const name = requireSearchTerm(args.name, '직원 이름');
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('name, role, job_title, work_location, phone, status')
    .ilike('name', `%${name}%`)
    .order('name')
    .limit(20);
  if (error) throw error;
  return (data || []).filter(employee => employee.status !== '퇴직');
}

async function listEmployees(supabaseAdmin) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('name, role, job_title, work_location, phone, status')
    .order('name')
    .limit(200);
  if (error) throw error;
  return (data || []).filter(employee => employee.status !== '퇴직');
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
  return (data || []).map(record => ({
    ...record,
    check_in_at: formatKoreaDateTime(record.check_in_at),
    check_out_at: formatKoreaDateTime(record.check_out_at)
  }));
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
  if (ADMIN_ONLY_TOOLS.has(name)) assertAdmin(auth);

  switch (name) {
    case 'list_employees':
      return await listEmployees(supabaseAdmin);
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
      const bulkRequest = getInternalRequest(request, '/api/vacations/bulk', 'POST', { dates });
      const response = await handleBulkCreateVacations(bulkRequest, supabaseAdmin, env, context);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '휴무를 등록하지 못했습니다.');
      return { message: `${result.count}일 휴무를 등록했습니다.`, dates };
    }
    case 'update_my_day_off': {
      const vacationId = args.vacation_id;
      if (typeof vacationId !== 'string' || !UUID_PATTERN.test(vacationId)
        || !isValidDate(args.old_date)
        || !isValidDate(args.date)
        || !['휴무', '시간차', '공가'].includes(args.leave_type)
        || !['종일', '시간지정'].includes(args.time_detail)
        || typeof args.memo !== 'string' || args.memo.length > 500) {
        throw new Error('수정할 휴무 정보가 올바르지 않습니다.');
      }
      const { data: existingVacation, error: lookupError } = await supabaseAdmin
        .from('vacations')
        .select('leave_type')
        .eq('id', vacationId)
        .eq('user_id', auth.user.id)
        .eq('date', args.old_date)
        .maybeSingle();
      if (lookupError) throw lookupError;
      if (!existingVacation) throw new Error('해당 날짜의 본인 휴무 일정을 찾을 수 없습니다.');
      if (existingVacation.leave_type === '연차') throw new Error('연차 일정은 연차 신청 메뉴에서만 수정할 수 있습니다.');
      const body = {
        date: args.date,
        leave_type: args.leave_type,
        time_detail: args.time_detail,
        hours_used: args.hours_used,
        memo: args.memo
      };
      const response = await handleUpdateVacation(
        getInternalRequest(request, `/api/vacations/${vacationId}`, 'PATCH', body),
        supabaseAdmin, env, context, String(vacationId)
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '휴무를 수정하지 못했습니다.');
      return { message: '본인 휴무를 수정했습니다.', vacation: result.vacation };
    }
    case 'delete_my_days_off': {
      if (!Number.isInteger(args.year) || args.year < 2000 || args.year > 2100
        || !Number.isInteger(args.month) || args.month < 1 || args.month > 12) {
        throw new Error('삭제할 연도와 월이 올바르지 않습니다.');
      }
      const start = `${args.year}-${String(args.month).padStart(2, '0')}-01`;
      const endDate = new Date(Date.UTC(args.year, args.month, 0));
      const end = `${args.year}-${String(args.month).padStart(2, '0')}-${String(endDate.getUTCDate()).padStart(2, '0')}`;
      const { data: vacations, error: lookupError } = await supabaseAdmin
        .from('vacations')
        .select('id, date, leave_type')
        .eq('user_id', auth.user.id)
        .gte('date', start)
        .lte('date', end)
        .order('date', { ascending: true })
        .limit(101);
      if (lookupError) throw lookupError;
      if ((vacations || []).length > 100) {
        throw new Error('한 번에 최대 100건까지만 삭제할 수 있습니다. 기간을 나누어 요청해 주세요.');
      }
      const deletable = (vacations || []).filter(vacation => vacation.leave_type !== '연차');
      const annualLeaveCount = (vacations || []).length - deletable.length;
      let deletedCount = 0;
      for (const vacation of deletable) {
        const response = await handleDeleteVacation(
          getInternalRequest(request, `/api/vacations/${vacation.id}`, 'DELETE'),
          supabaseAdmin, env, context, vacation.id
        );
        const result = await response.json();
        if (!response.ok) {
          throw new Error(`${deletedCount}건 삭제 후 중단되었습니다. ${result.error || '휴무를 삭제하지 못했습니다.'}`);
        }
        deletedCount += 1;
      }
      return {
        message: `${deletedCount}건의 휴무를 삭제했습니다.${annualLeaveCount ? ` 승인 연차 ${annualLeaveCount}건은 삭제하지 않았습니다.` : ''}`,
        deletedCount,
        skippedAnnualLeaveCount: annualLeaveCount
      };
    }
    case 'list_my_days_off':
      return await readMyDaysOff(supabaseAdmin, auth.user.id, args);
    case 'list_team_days_off':
      return await readTeamDaysOff(supabaseAdmin, args);
    case 'suggest_my_days_off':
      return await suggestMyDaysOff(supabaseAdmin, auth.user.id, args);
    case 'get_my_attendance':
      return await readMyAttendance(supabaseAdmin, auth.user.id, args);
    case 'get_my_annual_leave_balance':
      return await readMyAnnualLeave(request, supabaseAdmin, auth.user.id);
    case 'get_resort_weather':
      return await readWeather(request, supabaseAdmin, env, context, args);
    case 'search_vehicles':
      return await searchVehicles(supabaseAdmin, args);
    case 'search_phonebook':
      return await searchPhonebook(supabaseAdmin, args);
    case 'get_weekly_meal_plan':
      return await readMealPlanImage(supabaseAdmin, env, args);
    case 'search_employees':
      return await searchEmployees(supabaseAdmin, args);
    case 'get_employee_attendance': {
      const employee = await findEmployeeByName(supabaseAdmin, args.employee_name);
      validateDateRange(args.start, args.end);
      const { data, error } = await supabaseAdmin
        .from('attendance_records')
        .select('work_date, location_name, check_in_at, check_out_at, note')
        .eq('user_id', employee.id)
        .gte('work_date', args.start)
        .lte('work_date', args.end)
        .is('deleted_at', null)
        .order('work_date', { ascending: false })
        .limit(100);
      if (error) throw error;
      return { employee: employee.name || employee.username, attendance: data || [] };
    }
    case 'list_employee_days_off': {
      const employee = await findEmployeeByName(supabaseAdmin, args.employee_name);
      validateDateRange(args.start, args.end);
      const { data, error } = await supabaseAdmin
        .from('vacations')
        .select('id, date, leave_type, time_detail, hours_used, memo')
        .eq('user_id', employee.id)
        .gte('date', args.start)
        .lte('date', args.end)
        .order('date', { ascending: true })
        .limit(100);
      if (error) throw error;
      return { employee: employee.name || employee.username, vacations: data || [] };
    }
    case 'create_employee_days_off': {
      const employee = await findEmployeeByName(supabaseAdmin, args.employee_name);
      const dates = args.dates;
      if (!Array.isArray(dates) || dates.length < 1 || dates.length > 31
        || dates.some(date => !isValidDate(date))
        || new Set(dates).size !== dates.length
        || new Set(dates.map(date => date.slice(0, 7))).size !== 1) {
        throw new Error('같은 달의 서로 다른 날짜를 1~31개 선택해 주세요.');
      }
      const todayKst = koreaDateString();
      if (dates.some(date => date < todayKst)) throw new Error('지난 날짜에는 휴무를 등록할 수 없습니다.');
      const response = await handleBulkCreateVacations(
        getInternalRequest(request, '/api/vacations/bulk', 'POST', {
          dates,
          user_id: employee.id,
          memo: typeof args.memo === 'string' ? args.memo : ''
        }),
        supabaseAdmin, env, context
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '직원 휴무를 등록하지 못했습니다.');
      return { message: `${employee.name || employee.username} 직원의 휴무 ${result.count}건을 등록했습니다.`, dates };
    }
    case 'update_employee_day_off': {
      const employee = await findEmployeeByName(supabaseAdmin, args.employee_name);
      const vacation = await findEmployeeVacation(supabaseAdmin, employee.id, args.old_date, args.old_leave_type);
      if (vacation.leave_type === '연차') throw new Error('연차 일정은 연차 신청 메뉴에서만 수정할 수 있습니다.');
      if (!isValidDate(args.date)
        || !['휴무', '시간차', '공가'].includes(args.leave_type)
        || !['종일', '시간지정'].includes(args.time_detail)
        || typeof args.memo !== 'string' || args.memo.length > 500) {
        throw new Error('수정할 휴무 정보가 올바르지 않습니다.');
      }
      const body = {
        date: args.date,
        leave_type: args.leave_type,
        time_detail: args.time_detail,
        hours_used: args.hours_used,
        memo: args.memo,
        user_id: employee.id
      };
      const response = await handleUpdateVacation(
        getInternalRequest(request, `/api/vacations/${vacation.id}`, 'PATCH', body),
        supabaseAdmin, env, context, String(vacation.id)
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '직원 휴무를 수정하지 못했습니다.');
      return { message: `${employee.name || employee.username} 직원의 휴무를 수정했습니다.`, vacation: result.vacation };
    }
    case 'delete_employee_day_off': {
      const employee = await findEmployeeByName(supabaseAdmin, args.employee_name);
      const vacation = await findEmployeeVacation(supabaseAdmin, employee.id, args.date, args.leave_type);
      if (vacation.leave_type === '연차') throw new Error('승인된 연차 일정은 연차 신청 메뉴에서 취소해야 합니다.');
      const response = await handleDeleteVacation(
        getInternalRequest(request, `/api/vacations/${vacation.id}`, 'DELETE'),
        supabaseAdmin, env, context, String(vacation.id)
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '직원 휴무를 삭제하지 못했습니다.');
      return { message: `${employee.name || employee.username} 직원의 ${args.date} 휴무를 삭제했습니다.` };
    }
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
      instructions: '요청에 맞는 API는 사용 가능한 도구 중에서 선택합니다. 일반 사용자는 본인 휴무·근태·연차를 조회하고 본인 휴무를 관리할 수 있으며, 팀 휴무자 이름·날짜·종류도 조회할 수 있습니다. 관리자는 회사 직원 목록과 직원 기본 정보·근태·휴무를 조회하고 직원 휴무를 등록·수정·삭제할 수 있습니다. 관리자 도구는 서버에서 관리자 권한을 검증합니다. 날씨·차량·식단 이미지·지산 연락망 조회도 지원합니다. 무작위 휴무 추천은 조건 확인 도구를 호출한 뒤, 등록 요청이 있으면 제안된 날짜로 등록 도구를 호출합니다. 모든 변경 작업은 클라이언트 확인 버튼을 통과해야 합니다.'
    });
  }
  if (message.method === 'ping') return jsonRpcResponse(message.id, {});
  if (message.method === 'tools/list') {
    const tools = ['guest', 'monitor'].includes(auth.profile.role)
      ? []
      : auth.profile.role === 'admin'
        ? MCP_TOOLS
        : MCP_TOOLS.filter(tool => !ADMIN_ONLY_TOOLS.has(tool.name));
    return jsonRpcResponse(message.id, { tools });
  }
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
