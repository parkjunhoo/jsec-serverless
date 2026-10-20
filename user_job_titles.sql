ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS job_title text NOT NULL DEFAULT '사원';

UPDATE public.users
SET job_title = CASE name
  WHEN '지은석' THEN '소장'
  WHEN '김동석' THEN '부소장'
END
WHERE name IN ('지은석', '김동석');

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_job_title_check;

ALTER TABLE public.users
  ADD CONSTRAINT users_job_title_check
  CHECK (job_title IN ('소장', '부소장', '사원'));
