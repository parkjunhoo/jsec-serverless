CREATE TABLE IF NOT EXISTS public.attendance_sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_number integer NOT NULL UNIQUE CHECK (site_number > 0),
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

ALTER TABLE public.attendance_sites
  DROP CONSTRAINT IF EXISTS attendance_sites_site_number_check;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.attendance_sites'::regclass
      AND conname = 'attendance_sites_site_number_positive'
  ) THEN
    ALTER TABLE public.attendance_sites
      ADD CONSTRAINT attendance_sites_site_number_positive CHECK (site_number > 0);
  END IF;
END;
$$;

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
  check_in_latitude double precision,
  check_in_longitude double precision,
  check_in_device jsonb,
  check_out_at timestamptz,
  check_out_accuracy_m double precision CHECK (check_out_accuracy_m BETWEEN 0 AND 100),
  check_out_distance_m double precision CHECK (check_out_distance_m >= 0),
  check_out_latitude double precision,
  check_out_longitude double precision,
  check_out_device jsonb,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, work_date),
  CHECK (check_out_at IS NULL OR check_out_at >= check_in_at)
);

ALTER TABLE public.attendance_records
  ADD COLUMN IF NOT EXISTS check_in_latitude double precision,
  ADD COLUMN IF NOT EXISTS check_in_longitude double precision,
  ADD COLUMN IF NOT EXISTS check_in_device jsonb,
  ADD COLUMN IF NOT EXISTS check_out_latitude double precision,
  ADD COLUMN IF NOT EXISTS check_out_longitude double precision,
  ADD COLUMN IF NOT EXISTS check_out_device jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.attendance_records'::regclass
      AND conname = 'attendance_records_check_in_coordinates_valid'
  ) THEN
    ALTER TABLE public.attendance_records
      ADD CONSTRAINT attendance_records_check_in_coordinates_valid CHECK (
        (check_in_latitude IS NULL AND check_in_longitude IS NULL)
        OR (
          check_in_latitude IS NOT NULL AND check_in_longitude IS NOT NULL
          AND check_in_latitude BETWEEN -90 AND 90
          AND check_in_longitude BETWEEN -180 AND 180
        )
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.attendance_records'::regclass
      AND conname = 'attendance_records_check_out_coordinates_valid'
  ) THEN
    ALTER TABLE public.attendance_records
      ADD CONSTRAINT attendance_records_check_out_coordinates_valid CHECK (
        (check_out_latitude IS NULL AND check_out_longitude IS NULL)
        OR (
          check_out_latitude IS NOT NULL AND check_out_longitude IS NOT NULL
          AND check_out_latitude BETWEEN -90 AND 90
          AND check_out_longitude BETWEEN -180 AND 180
        )
      );
  END IF;
END;
$$;

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
  site_id uuid;
  next_site_no integer;
  included_site_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF p_sites IS NULL OR jsonb_typeof(p_sites) <> 'array' THEN
    RAISE EXCEPTION '출근지 설정 형식이 올바르지 않습니다.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('attendance-sites'));
  FOR site_item IN SELECT value FROM jsonb_array_elements(p_sites)
  LOOP
    site_id := NULLIF(site_item->>'id', '')::uuid;
    IF site_id IS NULL THEN
      SELECT COALESCE(MAX(site_number), 0) + 1 INTO next_site_no
      FROM public.attendance_sites;
      INSERT INTO public.attendance_sites (
        site_number, name, latitude, longitude, radius_m, enabled, updated_by, updated_at
      )
      VALUES (
        next_site_no,
        site_item->>'name',
        NULLIF(site_item->>'latitude', '')::double precision,
        NULLIF(site_item->>'longitude', '')::double precision,
        (site_item->>'radius_m')::integer,
        (site_item->>'enabled')::boolean,
        p_admin_id,
        now()
      )
      RETURNING * INTO new_site;
      INSERT INTO public.attendance_site_audit (site_id, changed_by, before_value, after_value)
      VALUES (new_site.id, p_admin_id, '{}'::jsonb, to_jsonb(new_site));
    ELSE
      SELECT * INTO old_site
      FROM public.attendance_sites
      WHERE id = site_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION '출근지 설정을 찾을 수 없습니다.';
      END IF;
      IF old_site.enabled
        AND NOT (site_item->>'enabled')::boolean
        AND EXISTS (
          SELECT 1 FROM public.attendance_records
          WHERE location_id = old_site.id AND check_out_at IS NULL
        ) THEN
        RAISE EXCEPTION '퇴근 기록이 없는 근무가 있어 출근지를 보관할 수 없습니다.';
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
    END IF;
    included_site_ids := array_append(included_site_ids, new_site.id);
    RETURN NEXT new_site;
  END LOOP;

  FOR old_site IN
    SELECT * FROM public.attendance_sites
    WHERE enabled AND NOT (id = ANY(included_site_ids))
    FOR UPDATE
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.attendance_records
      WHERE location_id = old_site.id AND check_out_at IS NULL
    ) THEN
      RAISE EXCEPTION '퇴근 기록이 없는 근무가 있어 출근지를 보관할 수 없습니다.';
    END IF;
    UPDATE public.attendance_sites
    SET enabled = false, updated_by = p_admin_id, updated_at = now()
    WHERE id = old_site.id
    RETURNING * INTO new_site;
    INSERT INTO public.attendance_site_audit (site_id, changed_by, before_value, after_value)
    VALUES (new_site.id, p_admin_id, to_jsonb(old_site), to_jsonb(new_site));
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
