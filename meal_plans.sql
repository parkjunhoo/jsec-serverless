CREATE TABLE IF NOT EXISTS public.meal_plans (
  week_start date NOT NULL,
  venue text NOT NULL DEFAULT 'golf',
  object_key text NOT NULL UNIQUE,
  size_bytes integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 1048576),
  uploaded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  uploaded_by_name text NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meal_plans_week_start_monday
    CHECK (EXTRACT(ISODOW FROM week_start) = 1),
  CONSTRAINT meal_plans_venue_valid
    CHECK (venue IN ('golf', 'ski')),
  CONSTRAINT meal_plans_pkey
    PRIMARY KEY (week_start, venue)
);

ALTER TABLE public.meal_plans
  ADD COLUMN IF NOT EXISTS venue text NOT NULL DEFAULT 'golf';
ALTER TABLE public.meal_plans
  DROP CONSTRAINT IF EXISTS meal_plans_pkey;
ALTER TABLE public.meal_plans
  ADD CONSTRAINT meal_plans_pkey PRIMARY KEY (week_start, venue);
ALTER TABLE public.meal_plans
  DROP CONSTRAINT IF EXISTS meal_plans_venue_valid;
ALTER TABLE public.meal_plans
  ADD CONSTRAINT meal_plans_venue_valid CHECK (venue IN ('golf', 'ski'));

ALTER TABLE public.meal_plans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.meal_plans FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.meal_plans TO service_role;
