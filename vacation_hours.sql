ALTER TABLE public.vacations
  ADD COLUMN IF NOT EXISTS hours_used numeric(5, 2);

UPDATE public.vacations
SET hours_used = 4
WHERE leave_type = '시간차'
  AND time_detail IN ('오전반차', '오후반차')
  AND hours_used IS NULL;

NOTIFY pgrst, 'reload schema';
