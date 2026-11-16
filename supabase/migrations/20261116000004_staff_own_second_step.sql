-- Each staff member can have their own second sign-in step: 'pin' (admin PIN) or 'totp' (authenticator app).
-- NULL = use the shop default (security_settings.staff_second_step), so existing accounts keep working unchanged.
-- Every check that used the shop-wide setting now uses the signed-in person's own setting (app.second_step_for).

ALTER TABLE app.staff_users ADD COLUMN second_step text CHECK (second_step IN ('totp', 'pin'));

CREATE FUNCTION app.second_step_for(p_staff_id uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT u.second_step FROM app.staff_users u WHERE u.id = p_staff_id),
                  (SELECT s.staff_second_step FROM app.security_settings s WHERE s.id = 1))
$$;
REVOKE ALL ON FUNCTION app.second_step_for(uuid) FROM PUBLIC, anon, authenticated;


CREATE OR REPLACE FUNCTION app.second_step_ok() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT NOT s.require_staff_mfa
      OR app.current_aal() = 'aal2'
      OR (app.second_step_for(auth.uid()) = 'pin' AND EXISTS (
            SELECT 1 FROM app.staff_pin_sessions p
             WHERE p.session_id = app.jwt_session_id() AND p.staff_id = auth.uid() AND p.expires_at > now()))
    FROM app.security_settings s WHERE s.id = 1
$$;

CREATE OR REPLACE FUNCTION app.require_perm(p_perm text) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Please sign in.' USING ERRCODE = '28000'; END IF;
  IF app.current_staff_id() IS NULL THEN RAISE EXCEPTION 'You do not have permission to do this.' USING ERRCODE = '42501'; END IF;
  IF NOT app.has_perm(p_perm) THEN
    IF app.must_change_password() THEN
      RAISE EXCEPTION 'Please set your own password first.' USING ERRCODE = '42501', HINT = 'password_change_required';
    END IF;
    IF NOT app.second_step_ok() THEN
      IF app.second_step_for(auth.uid()) = 'pin' THEN
        RAISE EXCEPTION 'Enter your admin PIN first.' USING ERRCODE = '42501', HINT = 'pin_required';
      END IF;
      RAISE EXCEPTION 'Sign in with your authenticator app (two-step verification) first.' USING ERRCODE = '42501', HINT = 'mfa_required';
    END IF;
    RAISE EXCEPTION 'You do not have permission to do this.' USING ERRCODE = '42501';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.admin_me() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE u record; v_require boolean; v_mode text; v_ok boolean;
BEGIN
  SELECT * INTO u FROM app.staff_users WHERE id = auth.uid();
  IF NOT FOUND OR u.status <> 'active' THEN PERFORM app.fail('forbidden', 'This account is not a staff account.'); END IF;
  SELECT require_staff_mfa, app.second_step_for(u.id) INTO v_require, v_mode FROM app.security_settings WHERE id = 1;
  v_ok := app.second_step_ok();
  UPDATE app.staff_users SET last_login_at = now() WHERE id = u.id AND (last_login_at IS NULL OR last_login_at < now() - interval '5 minutes');
  RETURN jsonb_build_object('username', u.username::text, 'displayName', u.display_name,
    'roles', coalesce((SELECT jsonb_agg(r.code ORDER BY r.code) FROM app.staff_roles sr JOIN app.roles r ON r.id = sr.role_id WHERE sr.staff_id = u.id), '[]'::jsonb),
    'permissions', CASE WHEN NOT v_ok THEN '[]'::jsonb ELSE coalesce((SELECT jsonb_agg(DISTINCT p ORDER BY p) FROM (
        SELECT rp.permission AS p FROM app.staff_roles sr JOIN app.role_permissions rp ON rp.role_id = sr.role_id WHERE sr.staff_id = u.id
        UNION SELECT x.permission FROM app.staff_extra_permissions x WHERE x.staff_id = u.id) q), '[]'::jsonb) END,
    'shops', CASE WHEN EXISTS (SELECT 1 FROM app.staff_roles sr JOIN app.roles r ON r.id = sr.role_id WHERE sr.staff_id = u.id AND NOT r.shop_scoped) THEN NULL
                  ELSE coalesce((SELECT jsonb_agg(s.slug) FROM app.staff_shop_access a JOIN app.shops s ON s.id = a.shop_id WHERE a.staff_id = u.id), '[]'::jsonb) END,
    'mfaRequired', v_require, 'aal', app.current_aal(), 'mustChangePassword', app.must_change_password(),
    'secondStep', v_mode, 'secondStepOk', v_ok, 'hasPin', EXISTS (SELECT 1 FROM app.staff_pins p WHERE p.staff_id = u.id),
    'mainAdmin', EXISTS (SELECT 1 FROM app.staff_roles sr JOIN app.roles r ON r.id = sr.role_id WHERE sr.staff_id = u.id AND r.code = 'owner'),
    'extra', coalesce((SELECT jsonb_agg(x.permission ORDER BY x.permission) FROM app.staff_extra_permissions x WHERE x.staff_id = u.id), '[]'::jsonb));
END $$;

CREATE OR REPLACE FUNCTION public.staff_verify_pin(p_pin text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_staff uuid := app.current_staff_id(); v_sess uuid := app.jwt_session_id(); p app.staff_pins; v_left int;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Please sign in.' USING ERRCODE = '28000'; END IF;
  IF v_staff IS NULL THEN RAISE EXCEPTION 'You do not have permission to do this.' USING ERRCODE = '42501'; END IF;
  IF app.second_step_for(v_staff) <> 'pin' THEN
    PERFORM app.fail('bad_request', 'PIN sign-in is not switched on. Use your authenticator app.');
  END IF;
  IF v_sess IS NULL THEN PERFORM app.fail('bad_request', 'Sign in again, then enter your PIN.'); END IF;
  DELETE FROM app.staff_pin_sessions WHERE expires_at < now() - interval '1 day';
  SELECT * INTO p FROM app.staff_pins WHERE staff_id = v_staff FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'no_pin', 'message', 'No PIN has been set for you yet. Ask the owner to set one.'); END IF;
  IF p.locked_until > now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'locked', 'message',
      'Too many wrong PINs. Try again in ' || greatest(1, ceil(extract(epoch FROM p.locked_until - now()) / 60))::int || ' minute(s).');
  END IF;
  IF coalesce(p_pin, '') ~ '^[0-9]{4,8}$' AND extensions.crypt(p_pin, p.pin_hash) = p.pin_hash THEN
    UPDATE app.staff_pins SET failed = 0, locked_until = NULL WHERE staff_id = v_staff;
    INSERT INTO app.staff_pin_sessions (session_id, staff_id, expires_at) VALUES (v_sess, v_staff, now() + interval '12 hours')
    ON CONFLICT (session_id) DO UPDATE SET staff_id = EXCLUDED.staff_id, verified_at = now(), expires_at = EXCLUDED.expires_at;
    PERFORM app.audit('staff.pin_ok', 'staff', v_staff::text);
    RETURN jsonb_build_object('ok', true);
  END IF;
  IF p.failed + 1 >= 5 THEN
    UPDATE app.staff_pins SET failed = 0, locked_until = now() + interval '15 minutes' WHERE staff_id = v_staff;
    PERFORM app.audit('staff.pin_locked', 'staff', v_staff::text);
    RETURN jsonb_build_object('ok', false, 'error', 'locked', 'message', 'Too many wrong PINs. Try again in 15 minute(s).');
  END IF;
  UPDATE app.staff_pins SET failed = p.failed + 1 WHERE staff_id = v_staff;
  PERFORM app.audit('staff.pin_failed', 'staff', v_staff::text);
  v_left := 5 - (p.failed + 1);
  RETURN jsonb_build_object('ok', false, 'error', 'wrong_pin', 'attemptsLeft', v_left,
    'message', 'Wrong PIN. ' || v_left || ' tr' || CASE WHEN v_left = 1 THEN 'y' ELSE 'ies' END || ' left before a 15-minute lock.');
END $$;

CREATE OR REPLACE FUNCTION public.admin_set_staff_pin(p_staff_id uuid, p_pin text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user text;
BEGIN
  PERFORM app.require_perm('staff.manage');
  SELECT username::text INTO v_user FROM app.staff_users WHERE id = p_staff_id;
  IF NOT FOUND THEN PERFORM app.fail('not_found', 'Staff member not found.'); END IF;
  IF p_pin IS NULL OR p_pin = '' THEN
    IF p_staff_id = auth.uid() AND app.second_step_for(p_staff_id) = 'pin' THEN
      PERFORM app.fail('bad_request', 'Switch sign-in back to the authenticator app before removing your own PIN.');
    END IF;
    DELETE FROM app.staff_pins WHERE staff_id = p_staff_id;
    DELETE FROM app.staff_pin_sessions WHERE staff_id = p_staff_id;
    PERFORM app.audit('staff.pin_removed', 'staff', v_user);
    RETURN jsonb_build_object('ok', true, 'hasPin', false);
  END IF;
  IF p_pin !~ '^[0-9]{4,8}$' THEN PERFORM app.fail('bad_request', 'The PIN must be 4 to 8 digits.'); END IF;
  IF p_pin ~ '^(.)\1+$' OR position(p_pin IN '0123456789') > 0 OR position(p_pin IN '9876543210') > 0 THEN
    PERFORM app.fail('bad_request', 'That PIN is too easy to guess (same digit or 1234-style). Choose another.');
  END IF;
  INSERT INTO app.staff_pins (staff_id, pin_hash, set_by) VALUES (p_staff_id, extensions.crypt(p_pin, extensions.gen_salt('bf', 10)), app.staff_actor())
  ON CONFLICT (staff_id) DO UPDATE SET pin_hash = EXCLUDED.pin_hash, failed = 0, locked_until = NULL, updated_at = now(), set_by = EXCLUDED.set_by;
  -- a changed PIN must be entered again everywhere, except in the owner's own current session
  DELETE FROM app.staff_pin_sessions WHERE staff_id = p_staff_id AND session_id IS DISTINCT FROM CASE WHEN p_staff_id = auth.uid() THEN app.jwt_session_id() END;
  PERFORM app.audit('staff.pin_set', 'staff', v_user);
  RETURN jsonb_build_object('ok', true, 'hasPin', true);
END $$;

CREATE OR REPLACE FUNCTION public.admin_set_second_step(p_mode text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_old text;
BEGIN
  PERFORM app.require_perm('staff.manage');
  IF coalesce(p_mode, '') NOT IN ('totp', 'pin') THEN PERFORM app.fail('bad_request', 'Choose the authenticator app or a PIN.'); END IF;
  IF p_mode = 'pin' AND (SELECT second_step FROM app.staff_users WHERE id = auth.uid()) IS NULL AND NOT EXISTS (SELECT 1 FROM app.staff_pins WHERE staff_id = auth.uid()) THEN
    PERFORM app.fail('bad_request', 'Set your own PIN first, so you can still sign in.');
  END IF;
  SELECT staff_second_step INTO v_old FROM app.security_settings WHERE id = 1 FOR UPDATE;
  UPDATE app.security_settings SET staff_second_step = p_mode, updated_at = now() WHERE id = 1;
  -- the owner making the change stays signed in: their current session counts as verified in the new mode
  IF p_mode = 'pin' AND app.jwt_session_id() IS NOT NULL THEN
    INSERT INTO app.staff_pin_sessions (session_id, staff_id, expires_at) VALUES (app.jwt_session_id(), auth.uid(), now() + interval '12 hours')
    ON CONFLICT (session_id) DO NOTHING;
  END IF;
  PERFORM app.audit('security.second_step', 'settings', 'staff_second_step', jsonb_build_object('mode', v_old), jsonb_build_object('mode', p_mode));
  RETURN jsonb_build_object('ok', true, 'secondStep', p_mode);
END $$;

CREATE OR REPLACE FUNCTION public.admin_staff_list() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.require_perm('staff.manage');
  RETURN jsonb_build_object(
    'staff', coalesce((SELECT jsonb_agg(jsonb_build_object('id', u.id, 'username', u.username::text, 'email', u.email::text, 'display_name', u.display_name, 'status', u.status, 'second_step', u.second_step,
       'last_login_at', u.last_login_at, 'mfa', EXISTS (SELECT 1 FROM auth.mfa_factors f WHERE f.user_id = u.id AND f.status = 'verified'),
       'roles', coalesce((SELECT jsonb_agg(r.code ORDER BY r.code) FROM app.staff_roles sr JOIN app.roles r ON r.id = sr.role_id WHERE sr.staff_id = u.id), '[]'::jsonb),
       'shops', coalesce((SELECT jsonb_agg(s.slug ORDER BY s.slug) FROM app.staff_shop_access a JOIN app.shops s ON s.id = a.shop_id WHERE a.staff_id = u.id), '[]'::jsonb)) ORDER BY u.created_at) FROM app.staff_users u), '[]'::jsonb),
    'roles', coalesce((SELECT jsonb_agg(jsonb_build_object('code', r.code, 'name', r.name, 'description', r.description, 'shop_scoped', r.shop_scoped,
       'permissions', (SELECT jsonb_agg(rp.permission ORDER BY rp.permission) FROM app.role_permissions rp WHERE rp.role_id = r.id)) ORDER BY r.name) FROM app.roles r), '[]'::jsonb));
END $$;

CREATE OR REPLACE FUNCTION public.admin_staff_save(p_staff_id uuid, p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_roles text[]; v_shops text[]; n int; v_exists boolean; v_kind text; v_step text;
BEGIN
  PERFORM app.require_perm('staff.manage');
  SELECT raw_app_meta_data ->> 'kind' INTO v_kind FROM auth.users WHERE id = p_staff_id;
  IF NOT FOUND THEN PERFORM app.fail('not_found', 'That sign-in account does not exist.'); END IF;
  IF coalesce(v_kind, '') <> 'staff' THEN PERFORM app.fail('bad_request', 'Only accounts created as staff can be given staff roles.'); END IF;
  v_exists := EXISTS (SELECT 1 FROM app.staff_users WHERE id = p_staff_id);
  IF NOT v_exists THEN
    INSERT INTO app.staff_users (id, username, email, display_name)
    VALUES (p_staff_id, app.v_match(app.v_text(p_data, 'username', 40, 3), '^[A-Za-z0-9._-]{3,40}$', 'Username: 3 to 40 letters, numbers, . _ -'),
            nullif(app.v_text(p_data, 'email', 200), ''), app.v_text(p_data, 'displayName', 80, 1));
  ELSE
    IF p_data ? 'displayName' THEN UPDATE app.staff_users SET display_name = app.v_text(p_data, 'displayName', 80, 1) WHERE id = p_staff_id; END IF;
  END IF;
  IF p_data ? 'status' THEN
    IF p_data ->> 'status' NOT IN ('active', 'disabled') THEN PERFORM app.fail('bad_request', 'invalid status'); END IF;
    IF p_staff_id = auth.uid() AND p_data ->> 'status' = 'disabled' THEN PERFORM app.fail('bad_request', 'You cannot disable yourself.'); END IF;
    UPDATE app.staff_users SET status = p_data ->> 'status' WHERE id = p_staff_id;
  END IF;
  IF p_data ? 'roles' THEN
    v_roles := app.v_text_array(p_data, 'roles', 7, '^[a-z_]{2,40}$', 'invalid role');
    IF cardinality(v_roles) = 0 THEN PERFORM app.fail('bad_request', 'Give at least one role.'); END IF;
    SELECT count(*) INTO n FROM app.roles WHERE code = ANY (v_roles);
    IF n <> (SELECT count(DISTINCT x) FROM unnest(v_roles) x) THEN PERFORM app.fail('bad_request', 'Unknown role.'); END IF;
    DELETE FROM app.staff_roles WHERE staff_id = p_staff_id;
    INSERT INTO app.staff_roles (staff_id, role_id) SELECT p_staff_id, id FROM app.roles WHERE code = ANY (v_roles);
  END IF;
  IF p_data ? 'shops' THEN
    v_shops := app.v_text_array(p_data, 'shops', 20, '^[a-z0-9]+(-[a-z0-9]+)*$', 'invalid department');
    SELECT count(*) INTO n FROM app.shops WHERE slug = ANY (v_shops);
    IF n <> (SELECT count(DISTINCT x) FROM unnest(v_shops) x) THEN PERFORM app.fail('bad_request', 'Unknown department.'); END IF;
    DELETE FROM app.staff_shop_access WHERE staff_id = p_staff_id;
    INSERT INTO app.staff_shop_access (staff_id, shop_id) SELECT p_staff_id, id FROM app.shops WHERE slug = ANY (v_shops);
  END IF;
  IF p_data ? 'secondStep' THEN
    v_step := nullif(p_data ->> 'secondStep', '');
    IF v_step IS NOT NULL AND v_step NOT IN ('totp', 'pin') THEN PERFORM app.fail('bad_request', 'Choose PIN or authenticator app.'); END IF;
    IF p_staff_id = auth.uid() AND coalesce(v_step, (SELECT staff_second_step FROM app.security_settings WHERE id = 1)) IS DISTINCT FROM app.second_step_for(p_staff_id) THEN
      -- your own sign-in: never lock yourself out
      IF coalesce(v_step, (SELECT staff_second_step FROM app.security_settings WHERE id = 1)) = 'pin' THEN
        IF NOT EXISTS (SELECT 1 FROM app.staff_pins WHERE staff_id = p_staff_id) THEN PERFORM app.fail('bad_request', 'Set your own PIN first, so you can still sign in.'); END IF;
        IF app.jwt_session_id() IS NOT NULL THEN
          INSERT INTO app.staff_pin_sessions (session_id, staff_id, expires_at) VALUES (app.jwt_session_id(), p_staff_id, now() + interval '12 hours') ON CONFLICT (session_id) DO NOTHING;
        END IF;
      ELSIF app.current_aal() <> 'aal2' THEN
        PERFORM app.fail('bad_request', 'You did not sign in with an authenticator app this time, so switching your own account to it could lock you out. Keep PIN for your own account.');
      END IF;
    END IF;
    UPDATE app.staff_users SET second_step = v_step WHERE id = p_staff_id;
  END IF;
  -- never leave the shop without an active owner
  IF NOT EXISTS (SELECT 1 FROM app.staff_users u JOIN app.staff_roles sr ON sr.staff_id = u.id JOIN app.roles r ON r.id = sr.role_id WHERE r.code = 'owner' AND u.status = 'active') THEN
    PERFORM app.fail('bad_request', 'At least one active owner account is required.');
  END IF;
  PERFORM app.audit(CASE WHEN v_exists THEN 'staff.update' ELSE 'staff.create' END, 'staff', p_staff_id::text, NULL, p_data);
  RETURN jsonb_build_object('ok', true, 'id', p_staff_id);
END $$;
