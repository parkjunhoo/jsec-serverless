CREATE TABLE IF NOT EXISTS public.calendar_notes (
  date date PRIMARY KEY,
  emoji text NOT NULL DEFAULT '📌',
  content text NOT NULL DEFAULT '',
  updated_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.calendar_notes
  ALTER COLUMN content SET DEFAULT '';

ALTER TABLE public.calendar_notes
  DROP CONSTRAINT IF EXISTS calendar_notes_content_check;

ALTER TABLE public.calendar_notes
  ADD CONSTRAINT calendar_notes_content_check
  CHECK (char_length(content) <= 500);

ALTER TABLE public.calendar_notes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.calendar_notes FROM anon, authenticated;
GRANT ALL ON TABLE public.calendar_notes TO service_role;

NOTIFY pgrst, 'reload schema';
