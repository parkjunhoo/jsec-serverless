CREATE TABLE IF NOT EXISTS public.corporate_card_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  spent_on date NOT NULL,
  merchant text NOT NULL CHECK (char_length(merchant) BETWEEN 1 AND 120),
  amount bigint NOT NULL CHECK (amount BETWEEN 1 AND 1000000000),
  category text NOT NULL DEFAULT '기타' CHECK (char_length(category) BETWEEN 1 AND 40),
  cardholder text NOT NULL CHECK (char_length(cardholder) BETWEEN 1 AND 60),
  memo text NOT NULL DEFAULT '' CHECK (char_length(memo) <= 1000),
  receipt_object_key text UNIQUE,
  receipt_content_type text,
  receipt_size_bytes integer CHECK (receipt_size_bytes BETWEEN 1 AND 5242880),
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_by_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (receipt_object_key IS NULL AND receipt_content_type IS NULL AND receipt_size_bytes IS NULL)
    OR (
      receipt_object_key IS NOT NULL
      AND receipt_content_type = 'image/jpeg'
      AND receipt_size_bytes IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS corporate_card_entries_spent_on_idx
  ON public.corporate_card_entries (spent_on DESC, created_at DESC);

ALTER TABLE public.corporate_card_entries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.corporate_card_entries FROM anon, authenticated;
GRANT ALL ON TABLE public.corporate_card_entries TO service_role;
