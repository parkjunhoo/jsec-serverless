CREATE TABLE IF NOT EXISTS public.allowance_types (
  code text PRIMARY KEY,
  label text NOT NULL,
  unit_amount integer NOT NULL CHECK (unit_amount > 0),
  shift_options text[] NOT NULL DEFAULT ARRAY[]::text[],
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.allowance_types (code, label, unit_amount, shift_options, sort_order)
VALUES
  ('ball_pickup', '연습장 볼수거', 20000, ARRAY[]::text[], 1),
  ('caddie_shuttle', '캐디 셔틀', 30000, ARRAY['morning', 'afternoon']::text[], 2)
ON CONFLICT (code) DO UPDATE SET
  label = EXCLUDED.label,
  unit_amount = EXCLUDED.unit_amount,
  shift_options = EXCLUDED.shift_options,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

CREATE TABLE IF NOT EXISTS public.allowance_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  username text NOT NULL,
  type_code text NOT NULL REFERENCES public.allowance_types(code) ON DELETE RESTRICT,
  type_label text NOT NULL,
  work_date date NOT NULL,
  shift text CHECK (shift IS NULL OR shift IN ('morning', 'afternoon')),
  unit_amount integer NOT NULL CHECK (unit_amount > 0),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS allowance_entries_date_idx
  ON public.allowance_entries (work_date, type_code);
CREATE INDEX IF NOT EXISTS allowance_entries_user_date_idx
  ON public.allowance_entries (user_id, work_date);
CREATE UNIQUE INDEX IF NOT EXISTS allowance_entries_unique_shift_idx
  ON public.allowance_entries (user_id, work_date, type_code, shift)
  WHERE shift IS NOT NULL;

ALTER TABLE public.allowance_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.allowance_entries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.allowance_types, public.allowance_entries FROM anon, authenticated;
GRANT ALL ON TABLE public.allowance_types, public.allowance_entries TO service_role;
