const FIELD_VALIDATORS = {
  name(value) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) {
      return { error: '이름은 1~100자 이내로 입력해 주세요.' };
    }
    return { value: value.trim() };
  },
  role(value) {
    if (!['user', 'admin', 'guest'].includes(value)) {
      return { error: '사용자 권한 값이 올바르지 않습니다.' };
    }
    return { value };
  },
  job_title(value) {
    if (!['소장', '부소장', '사원'].includes(value)) {
      return { error: '직책 값이 올바르지 않습니다.' };
    }
    return { value };
  },
  contract_type(value) {
    if (!['정규직', '계약직', '아르바이트'].includes(value)) {
      return { error: '계약 형태 값이 올바르지 않습니다.' };
    }
    return { value };
  },
  status(value) {
    if (!['재직', '퇴직'].includes(value)) {
      return { error: '재직 상태 값이 올바르지 않습니다.' };
    }
    return { value };
  },
  resignation_reason(value) {
    if (value === null || value === '') return { value: null };
    if (typeof value !== 'string' || value.trim().length > 500) {
      return { error: '퇴사 사유는 500자 이내로 입력해 주세요.' };
    }
    return { value: value.trim() };
  },
  work_location(value) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) {
      return { error: '근무지는 1~100자 이내로 입력해 주세요.' };
    }
    return { value: value.trim() };
  },
  hire_date: validateDateField('hire_date', '입사일'),
  annual_base_date: validateDateField('annual_base_date', '연차 기준일'),
  phone(value) {
    if (typeof value !== 'string' || value.length > 40) {
      return { error: '연락처는 40자 이내로 입력해 주세요.' };
    }
    return { value: value.trim() };
  },
  color(value) {
    if (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value)) {
      return { error: '사용자 색상 값이 올바르지 않습니다.' };
    }
    return { value };
  }
};

function isValidDate(value) {
  if (value === null || value === '') return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateDateField(field, label) {
  return value => {
    if (!isValidDate(value)) return { error: `${label}이 올바르지 않습니다.` };
    return { value: value || null };
  };
}

export function validateUserFields(fields) {
  const values = {};
  for (const [field, value] of Object.entries(fields)) {
    const validator = FIELD_VALIDATORS[field];
    if (!validator) return { error: '수정할 수 없는 회원 정보가 포함되어 있습니다.' };
    const result = validator(value);
    if (result.error) return result;
    values[field] = result.value;
  }
  return { values };
}

export async function hasLoginIdentifierConflict(supabaseAdmin, identifier, excludeUserId = null) {
  for (const field of ['username', 'name', 'email']) {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq(field, identifier)
      .limit(2);
    if (error) throw error;
    if ((data || []).some(profile => profile.id !== excludeUserId)) return true;
  }
  return false;
}
