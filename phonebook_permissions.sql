CREATE OR REPLACE FUNCTION public.is_phonebook_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.users
    WHERE id = auth.uid()
      AND role = 'admin'
  );
$$;

REVOKE ALL ON FUNCTION public.is_phonebook_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_phonebook_admin() TO authenticated;

ALTER TABLE public.phonebook ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  existing_policy record;
BEGIN
  FOR existing_policy IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'phonebook'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.phonebook', existing_policy.policyname);
  END LOOP;
END;
$$;

REVOKE ALL ON TABLE public.phonebook FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.phonebook TO authenticated;

DO $$
DECLARE
  id_sequence regclass;
BEGIN
  id_sequence := pg_get_serial_sequence('public.phonebook', 'id')::regclass;
  IF id_sequence IS NOT NULL THEN
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO authenticated', id_sequence);
  END IF;
END;
$$;

CREATE POLICY phonebook_read_authenticated
  ON public.phonebook FOR SELECT TO authenticated
  USING (true);

CREATE POLICY phonebook_insert_admin
  ON public.phonebook FOR INSERT TO authenticated
  WITH CHECK (public.is_phonebook_admin());

CREATE POLICY phonebook_update_admin
  ON public.phonebook FOR UPDATE TO authenticated
  USING (public.is_phonebook_admin())
  WITH CHECK (public.is_phonebook_admin());

CREATE POLICY phonebook_delete_admin
  ON public.phonebook FOR DELETE TO authenticated
  USING (public.is_phonebook_admin());

NOTIFY pgrst, 'reload schema';
