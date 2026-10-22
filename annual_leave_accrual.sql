CREATE TABLE IF NOT EXISTS public.annual_leave_accrual_settings (
  service_year integer PRIMARY KEY CHECK (service_year BETWEEN 1 AND 10),
  additional_days integer NOT NULL DEFAULT 0 CHECK (additional_days BETWEEN 0 AND 30),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.annual_leave_employee_deductions (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  service_year integer NOT NULL CHECK (service_year BETWEEN 1 AND 10),
  deduction_days integer NOT NULL DEFAULT 0 CHECK (deduction_days BETWEEN 0 AND 12),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, service_year)
);

INSERT INTO public.annual_leave_accrual_settings (service_year, additional_days)
SELECT service_year, CASE WHEN service_year = 1 THEN 0 ELSE service_year + 1 END
FROM generate_series(1, 10) AS years(service_year)
ON CONFLICT (service_year) DO NOTHING;

ALTER TABLE public.annual_leave_accrual_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.annual_leave_accrual_settings FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.annual_leave_accrual_settings TO service_role;
ALTER TABLE public.annual_leave_employee_deductions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.annual_leave_employee_deductions FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.annual_leave_employee_deductions TO service_role;

CREATE OR REPLACE FUNCTION public.create_annual_leave_request_with_balance(
  p_user_id uuid,
  p_username text,
  p_department text,
  p_leave_type text,
  p_start_date date,
  p_start_time time,
  p_end_date date,
  p_end_time time,
  p_total_days numeric,
  p_hours_used numeric,
  p_details text
)
RETURNS SETOF public.annual_leave_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  member_annual_base_date date;
  member_work_location text;
  v_hours_per_day integer;
  v_today date := timezone('Asia/Seoul', now())::date;
  v_service_year integer;
  base_deduction_days integer;
  cycle_start date;
  cycle_end date;
  entitled_days numeric;
  used_days numeric;
  pending_days numeric;
  requested_days numeric;
  created_request public.annual_leave_requests%ROWTYPE;
BEGIN
  SELECT annual_base_date, work_location
  INTO member_annual_base_date, member_work_location
  FROM public.users
  WHERE id = p_user_id
    AND COALESCE(status, '재직') <> '퇴직'
  FOR UPDATE;

  IF NOT FOUND OR member_annual_base_date IS NULL OR member_annual_base_date > v_today THEN
    RAISE EXCEPTION '연차 잔여 일수를 계산할 연차 기준일이 등록되어 있지 않습니다. 관리자에게 연차 기준일 등록을 요청해 주세요.';
  END IF;
  v_hours_per_day := CASE
    WHEN COALESCE(member_work_location, '') ILIKE '%골프장%'
      OR COALESCE(member_work_location, '') ILIKE '%스키장%' THEN 12
    ELSE 8
  END;

  v_service_year := GREATEST(1, EXTRACT(YEAR FROM age(v_today, member_annual_base_date))::integer + 1);
  cycle_start := member_annual_base_date + make_interval(years => v_service_year - 1);
  cycle_end := member_annual_base_date + make_interval(years => v_service_year) - 1;

  IF p_start_date < cycle_start OR p_end_date > cycle_end THEN
    RAISE EXCEPTION '연차 기준 기간(% ~ %) 안에서 신청해 주세요.', cycle_start, cycle_end;
  END IF;

  SELECT COALESCE((
    SELECT deduction_days
    FROM public.annual_leave_employee_deductions
    WHERE user_id = p_user_id
      AND service_year = LEAST(v_service_year, 10)
  ), 0)
  INTO base_deduction_days;

  SELECT GREATEST(0, 12 + COALESCE((
    SELECT additional_days
    FROM public.annual_leave_accrual_settings
    WHERE annual_leave_accrual_settings.service_year = LEAST(v_service_year, 10)
  ), 0) - base_deduction_days)
  INTO entitled_days;

  SELECT COALESCE(SUM(
    CASE
      WHEN leave_type = '연차' THEN 1
      WHEN leave_type = '시간차' THEN COALESCE(hours_used, 0) / v_hours_per_day
      ELSE 0
    END
  ), 0)
  INTO used_days
  FROM public.vacations
  WHERE user_id = p_user_id
    AND date BETWEEN cycle_start AND cycle_end;

  SELECT COALESCE(SUM(
    CASE
      WHEN leave_type = '연차' THEN total_days
      WHEN leave_type = '시간차' THEN COALESCE(hours_used, 0) / v_hours_per_day
      ELSE 0
    END
  ), 0)
  INTO pending_days
  FROM public.annual_leave_requests
  WHERE user_id = p_user_id
    AND status = 'pending'
    AND start_date >= cycle_start
    AND end_date <= cycle_end;

  requested_days := CASE
    WHEN p_leave_type = '연차' THEN p_total_days
    ELSE COALESCE(p_hours_used, 0) / v_hours_per_day
  END;

  IF used_days + pending_days + requested_days > entitled_days THEN
    RAISE EXCEPTION '잔여 연차가 부족합니다. 보유 %일, 사용 %일, 신청 대기 %일입니다.',
      entitled_days, used_days, pending_days;
  END IF;

  INSERT INTO public.annual_leave_requests (
    user_id, username, department, leave_type, start_date, start_time,
    end_date, end_time, total_days, hours_used, details
  )
  VALUES (
    p_user_id, p_username, p_department, p_leave_type, p_start_date, p_start_time,
    p_end_date, p_end_time, p_total_days, p_hours_used, COALESCE(p_details, '')
  )
  RETURNING * INTO created_request;

  RETURN NEXT created_request;
END;
$$;

REVOKE ALL ON FUNCTION public.create_annual_leave_request_with_balance(
  uuid, text, text, text, date, time, date, time, numeric, numeric, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_annual_leave_request_with_balance(
  uuid, text, text, text, date, time, date, time, numeric, numeric, text
) TO service_role;

NOTIFY pgrst, 'reload schema';
