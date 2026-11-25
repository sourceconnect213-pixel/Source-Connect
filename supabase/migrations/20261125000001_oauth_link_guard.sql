-- Google (and any other OAuth) sign-in: never attach it to an account that already exists.
-- Customer sign-ups are not email-verified, so an email+password account is no proof that its maker owns that email.
-- Supabase Auth links a new OAuth sign-in to an existing account with the same email automatically; that would let
-- someone register a stranger's email first and later read that person's orders. Refusing the link closes that hole:
-- the person keeps signing in with email + password. Staff accounts never take an OAuth sign-in either.
CREATE OR REPLACE FUNCTION app.guard_identity_link() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.provider <> 'email' AND (
       EXISTS (SELECT 1 FROM auth.identities i WHERE i.user_id = NEW.user_id AND i.provider = 'email')
    OR EXISTS (SELECT 1 FROM auth.users u WHERE u.id = NEW.user_id AND coalesce(u.raw_app_meta_data ->> 'kind', '') = 'staff')) THEN
    RAISE EXCEPTION 'account_exists_use_password' USING ERRCODE = 'P0001', HINT = 'account_exists';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_identity_link() FROM PUBLIC;
DROP TRIGGER IF EXISTS guard_identity_link ON auth.identities;
CREATE TRIGGER guard_identity_link BEFORE INSERT ON auth.identities FOR EACH ROW EXECUTE FUNCTION app.guard_identity_link();
