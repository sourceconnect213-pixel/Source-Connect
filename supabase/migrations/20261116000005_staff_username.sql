-- The main admin (staff.manage) can change any staff member's username, their own included.
-- Usernames stay unique (case ignored). The sign-in address of username-only accounts
-- (<username>@staff.invalid) is updated by the admin-staff Edge Function right after this succeeds.

CREATE OR REPLACE FUNCTION public.admin_staff_save(p_staff_id uuid, p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_roles text[]; v_shops text[]; n int; v_exists boolean; v_kind text; v_step text; v_user text;
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
    IF p_data ? 'username' THEN
      v_user := app.v_match(app.v_text(p_data, 'username', 40, 3), '^[A-Za-z0-9._-]{3,40}$', 'Username: 3 to 40 letters, numbers, . _ -');
      IF EXISTS (SELECT 1 FROM app.staff_users WHERE lower(username::text) = lower(v_user) AND id <> p_staff_id) THEN
        PERFORM app.fail('conflict', 'That username is already used by another staff member.');
      END IF;
      UPDATE app.staff_users SET username = v_user WHERE id = p_staff_id;
    END IF;
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
