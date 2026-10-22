CREATE TABLE IF NOT EXISTS public.user_favorites (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  favorite_type text NOT NULL CHECK (favorite_type IN ('menu', 'contact')),
  favorite_key text NOT NULL CHECK (length(favorite_key) BETWEEN 1 AND 2048),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, favorite_type, favorite_key)
);

ALTER TABLE public.user_favorites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.user_favorites FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_favorites TO authenticated;

DROP POLICY IF EXISTS user_favorites_select_own ON public.user_favorites;
CREATE POLICY user_favorites_select_own
  ON public.user_favorites FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS user_favorites_insert_own ON public.user_favorites;
CREATE POLICY user_favorites_insert_own
  ON public.user_favorites FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS user_favorites_update_own ON public.user_favorites;
CREATE POLICY user_favorites_update_own
  ON public.user_favorites FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS user_favorites_delete_own ON public.user_favorites;
CREATE POLICY user_favorites_delete_own
  ON public.user_favorites FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

NOTIFY pgrst, 'reload schema';