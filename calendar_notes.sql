CREATE TABLE IF NOT EXISTS public.calendar_notes (
  date date PRIMARY KEY,
  emoji text NOT NULL DEFAULT '📌',
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 500),
  updated_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.calendar_notes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.calendar_notes FROM anon, authenticated;
GRANT ALL ON TABLE public.calendar_notes TO service_role;

NOTIFY pgrst, 'reload schema';
