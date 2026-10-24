CREATE TABLE IF NOT EXISTS public.push_tokens (
  token text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  platform text NOT NULL DEFAULT 'android',
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.push_tokens
  ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;

ALTER TABLE public.push_tokens
  ALTER COLUMN enabled SET DEFAULT false;

ALTER TABLE public.push_tokens ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.push_tokens FROM anon, authenticated;
GRANT ALL ON TABLE public.push_tokens TO service_role;
