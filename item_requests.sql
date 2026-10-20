CREATE TABLE IF NOT EXISTS public.item_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  username text NOT NULL,
  item_name text NOT NULL CHECK (char_length(item_name) BETWEEN 1 AND 100),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 9999),
  specification text NOT NULL DEFAULT '' CHECK (char_length(specification) <= 500),
  reason text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 1000),
  example_url text NOT NULL DEFAULT '' CHECK (char_length(example_url) <= 2048),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  review_note text NOT NULL DEFAULT '' CHECK (char_length(review_note) <= 1000),
  reviewed_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'pending' AND reviewed_at IS NULL)
    OR (status IN ('approved', 'rejected') AND reviewed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS item_requests_user_created_idx
  ON public.item_requests (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS item_requests_status_created_idx
  ON public.item_requests (status, created_at DESC);

ALTER TABLE public.item_requests ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.item_requests FROM anon, authenticated;
GRANT ALL ON TABLE public.item_requests TO service_role;
