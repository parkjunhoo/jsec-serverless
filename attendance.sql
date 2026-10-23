CREATE TABLE IF NOT EXISTS public.attendance_sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_number integer NOT NULL UNIQUE CHECK (site_number BETWEEN 1 AND 3),
  name text NOT NULL DEFAULT '',
  latitude double precision,
  longitude double precision,
  radius_m integer NOT NULL DEFAULT 100 CHECK (radius_m BETWEEN 20 AND 1000),
  enabled boolean NOT NULL DEFAULT true,
  updated_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (latitude IS NULL AND longitude IS NULL)
    OR (
      latitude IS NOT NULL AND longitude IS NOT NULL
      AND latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180
    )
  )
);

INSERT INTO public.attendance_sites (site_number, name)
VALUES (1, '출근지 1'), (2, '출근지 2'), (3, '출근지 3')
ON CONFLICT (site_number) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.attendance_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  username text NOT NULL,
  location_id uuid NOT NULL REFERENCES public.attendance_sites(id) ON DELETE RESTRICT,
  location_name text NOT NULL,
  work_date date NOT NULL,
  check_in_at timestamptz NOT NULL,
  check_in_accuracy_m double precision NOT NULL CHECK (check_in_accuracy_m BETWEEN 0 AND 100),
  check_in_distance_m double precision NOT NULL CHECK (check_in_distance_m >= 0),
  check_out_at timestamptz,
  check_out_accuracy_m double precision CHECK (check_out_accuracy_m BETWEEN 0 AND 100),
  check_out_distance_m double precision CHECK (check_out_distance_m >= 0),
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, work_date),
  CHECK (check_out_at IS NULL OR check_out_at >= check_in_at)
);

CREATE INDEX IF NOT EXISTS attendance_records_work_date_idx
  ON public.attendance_records (work_date DESC);
CREATE INDEX IF NOT EXISTS attendance_records_user_work_date_idx
  ON public.attendance_records (user_id, work_date DESC);

CREATE TABLE IF NOT EXISTS public.attendance_site_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id uuid NOT NULL REFERENCES public.attendance_sites(id) ON DELETE RESTRICT,
  changed_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  changed_at timestamptz NOT NULL DEFAULT now(),
  before_value jsonb NOT NULL,
  after_value jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS public.attendance_record_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  record_id uuid NOT NULL REFERENCES public.attendance_records(id) ON DELETE RESTRICT,
  changed_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  changed_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  before_value jsonb NOT NULL,
  after_value jsonb NOT NULL
);

ALTER TABLE public.attendance_sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_site_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_record_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.attendance_sites, public.attendance_records,
  public.attendance_site_audit, public.attendance_record_audit FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.attendance_sites,
  public.attendance_records, public.attendance_site_audit,
  public.attendance_record_audit TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.attendance_site_audit_id_seq,
  public.attendance_record_audit_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.save_attendance_sites(p_sites jsonb, p_admin_id uuid)
RETURNS SETOF public.attendance_sites
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  site_item jsonb;
  old_site public.attendance_sites%ROWTYPE;
  new_site public.attendance_sites%ROWTYPE;
  site_no integer;
BEGIN
  IF jsonb_typeof(p_sites) <> 'array' OR jsonb_array_length(p_sites) <> 3 THEN
    RAISE EXCEPTION '출근지는 정확히 3곳을 설정해야 합니다.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('attendance-sites'));
  FOR site_item IN SELECT value FROM jsonb_array_elements(p_sites)
  LOOP
    site_no := (site_item->>'site_number')::integer;
    SELECT * INTO old_site
    FROM public.attendance_sites
    WHERE site_number = site_no
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION '출근지 설정을 찾을 수 없습니다.';
    END IF;

    UPDATE public.attendance_sites
    SET name = site_item->>'name',
        latitude = NULLIF(site_item->>'latitude', '')::double precision,
        longitude = NULLIF(site_item->>'longitude', '')::double precision,
        radius_m = (site_item->>'radius_m')::integer,
        enabled = (site_item->>'enabled')::boolean,
        updated_by = p_admin_id,
        updated_at = now()
    WHERE id = old_site.id
    RETURNING * INTO new_site;

    IF to_jsonb(old_site) - 'updated_at' - 'updated_by'
      IS DISTINCT FROM to_jsonb(new_site) - 'updated_at' - 'updated_by' THEN
      INSERT INTO public.attendance_site_audit (site_id, changed_by, before_value, after_value)
      VALUES (new_site.id, p_admin_id, to_jsonb(old_site), to_jsonb(new_site));
    END IF;
    RETURN NEXT new_site;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.correct_attendance_record(
  p_record_id uuid,
  p_location_id uuid,
  p_check_in_at timestamptz,
  p_check_out_at timestamptz,
  p_note text,
  p_reason text,
  p_admin_id uuid
)
RETURNS public.attendance_records
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  old_record public.attendance_records%ROWTYPE;
  new_record public.attendance_records%ROWTYPE;
  selected_site public.attendance_sites%ROWTYPE;
BEGIN
  IF length(trim(COALESCE(p_reason, ''))) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION '수정 사유를 1~500자로 입력해 주세요.';
  END IF;
  IF length(COALESCE(p_note, '')) > 1000 THEN
    RAISE EXCEPTION '메모는 1000자 이내로 입력해 주세요.';
  END IF;
  IF p_check_in_at IS NULL OR (p_check_out_at IS NOT NULL AND p_check_out_at < p_check_in_at) THEN
    RAISE EXCEPTION '출퇴근 시각을 올바르게 입력해 주세요.';
  END IF;

  SELECT * INTO old_record
  FROM public.attendance_records
  WHERE id = p_record_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '근태 기록을 찾을 수 없습니다.';
  END IF;

  SELECT * INTO selected_site
  FROM public.attendance_sites
  WHERE id = p_location_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '출근지를 찾을 수 없습니다.';
  END IF;

  UPDATE public.attendance_records
  SET location_id = selected_site.id,
      location_name = selected_site.name,
      work_date = (p_check_in_at AT TIME ZONE 'Asia/Seoul')::date,
      check_in_at = p_check_in_at,
      check_out_at = p_check_out_at,
      note = COALESCE(p_note, ''),
      updated_at = now()
  WHERE id = p_record_id
  RETURNING * INTO new_record;

  INSERT INTO public.attendance_record_audit (
    record_id, changed_by, reason, before_value, after_value
  )
  VALUES (
    new_record.id, p_admin_id, trim(p_reason), to_jsonb(old_record), to_jsonb(new_record)
  );
  RETURN new_record;
END;
$$;

REVOKE ALL ON FUNCTION public.save_attendance_sites(jsonb, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_attendance_sites(jsonb, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.correct_attendance_record(
  uuid, uuid, timestamptz, timestamptz, text, text, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.correct_attendance_record(
  uuid, uuid, timestamptz, timestamptz, text, text, uuid
) TO service_role;

NOTIFY pgrst, 'reload schema';
