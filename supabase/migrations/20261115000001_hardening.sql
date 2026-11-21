-- Hardening found by the Supabase security advisor.
--
-- `public.rls_auto_enable()` is the hosted platform's own event-trigger helper (it switches RLS on for new tables in
-- `public`). Like every function in `public` it was executable by visitors through the REST API. It cannot do anything
-- when called that way (event-trigger functions only run from their trigger), but nothing should be open that is not
-- part of the shop, so close it. The event trigger itself keeps working: firing a trigger needs no EXECUTE privilege.
-- A local stack has no such function, so this is a no-op there.
DO $$
BEGIN
  IF to_regprocedure('public.rls_auto_enable()') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated';
  END IF;
END $$;
