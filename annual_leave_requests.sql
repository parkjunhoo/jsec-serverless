CREATE TABLE IF NOT EXISTS public.annual_leave_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  username text NOT NULL,
  department text NOT NULL DEFAULT '',
  start_date date NOT NULL,
  start_time time NOT NULL,
  end_date date NOT NULL,
  end_time time NOT NULL,
  total_days numeric(5, 2) NOT NULL CHECK (total_days BETWEEN 1 AND 31),
  details text NOT NULL DEFAULT '' CHECK (char_length(details) <= 2000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  review_note text NOT NULL DEFAULT '' CHECK (char_length(review_note) <= 1000),
  reviewed_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    end_date > start_date
    OR (end_date = start_date AND end_time > start_time)
  ),
  CHECK (
    (status = 'pending' AND reviewed_at IS NULL)
    OR (status IN ('approved', 'rejected') AND reviewed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS annual_leave_requests_user_created_idx
  ON public.annual_leave_requests (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS annual_leave_requests_status_created_idx
  ON public.annual_leave_requests (status, created_at DESC);

ALTER TABLE public.annual_leave_requests ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.annual_leave_requests FROM anon, authenticated;
GRANT ALL ON TABLE public.annual_leave_requests TO service_role;

CREATE OR REPLACE FUNCTION public.review_annual_leave_request(
  p_request_id uuid,
  p_reviewed_by uuid,
  p_status text,
  p_review_note text
)
RETURNS SETOF public.annual_leave_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  leave_request public.annual_leave_requests%ROWTYPE;
BEGIN
  IF p_status NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION '승인 또는 반려 상태를 선택해 주세요.';
  END IF;

  SELECT *
  INTO leave_request
  FROM public.annual_leave_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND OR leave_request.status <> 'pending' THEN
    RAISE EXCEPTION '대기 중인 연차 신청을 찾을 수 없습니다. 이미 처리되었는지 새로고침해 주세요.';
  END IF;

  IF p_status = 'approved' THEN
    IF leave_request.start_time <> time '09:00'
      OR leave_request.end_time <> time '18:00'
      OR leave_request.total_days <> (
        SELECT count(*)::numeric
        FROM generate_series(leave_request.start_date, leave_request.end_date, interval '1 day') AS requested_days(day)
        WHERE EXTRACT(ISODOW FROM requested_days.day) BETWEEN 1 AND 5
      ) THEN
      RAISE EXCEPTION '연차 신청 기간 또는 일수가 올바르지 않습니다.';
    END IF;

    PERFORM 1
    FROM public.users
    WHERE id = leave_request.user_id
    FOR UPDATE;

    IF EXISTS (
      SELECT 1
      FROM public.vacations existing
      JOIN generate_series(leave_request.start_date, leave_request.end_date, interval '1 day') AS requested_days(day)
        ON existing.date = requested_days.day::date
      WHERE existing.user_id = leave_request.user_id
        AND EXTRACT(ISODOW FROM requested_days.day) BETWEEN 1 AND 5
    ) THEN
      RAISE EXCEPTION '신청 기간에 이미 등록된 일정이 있습니다. 기존 일정을 확인해 주세요.';
    END IF;

    INSERT INTO public.vacations (user_id, username, date, leave_type, time_detail, hours_used, memo)
    SELECT
      leave_request.user_id,
      leave_request.username,
      requested_days.day::date,
      '연차',
      '종일',
      NULL,
      leave_request.details
    FROM generate_series(leave_request.start_date, leave_request.end_date, interval '1 day') AS requested_days(day)
    WHERE EXTRACT(ISODOW FROM requested_days.day) BETWEEN 1 AND 5;
  END IF;

  UPDATE public.annual_leave_requests
  SET
    status = p_status,
    review_note = COALESCE(p_review_note, ''),
    reviewed_by = p_reviewed_by,
    reviewed_at = now(),
    updated_at = now()
  WHERE id = p_request_id
  RETURNING * INTO leave_request;

  RETURN NEXT leave_request;
END;
$$;

REVOKE ALL ON FUNCTION public.review_annual_leave_request(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_annual_leave_request(uuid, uuid, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';
