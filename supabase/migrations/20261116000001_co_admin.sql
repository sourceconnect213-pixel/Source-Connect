-- Two kinds of admin.
--   Main admin  = role "owner": everything, and the only one who can give extra access.
--   Co-admin    = new role "co_admin": runs the store -> sales & profit, cost prices, products (clothes) with their
--                 photos and stock, banners, homepage, flash-sale offers and promo codes. Nothing else.
-- Anything more for a particular person is added only when the main admin approves it: either the person asks
-- ("Request access" in the admin) and the main admin approves, or the main admin ticks it on the person directly.
-- The database decides (has_perm), so hiding a menu item in the browser is never what protects anything.

-- ---------- promo codes: own permission ----------
INSERT INTO app.permissions (code, description) VALUES ('coupons.manage', 'Create, pause and see promo codes')
ON CONFLICT (code) DO NOTHING;
INSERT INTO app.role_permissions (role_id, permission)
SELECT r.id, 'coupons.manage' FROM app.roles r WHERE r.code IN ('owner', 'ops_manager') ON CONFLICT DO NOTHING;

-- ---------- co-admin role ----------
INSERT INTO app.roles (code, name, description, shop_scoped) VALUES
 ('co_admin', 'Co-Admin (store)', 'Sales & profit, products and photos, banners, offers and promo codes. More only when the main admin approves it.', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO app.role_permissions (role_id, permission)
SELECT r.id, p FROM app.roles r, unnest(ARRAY['dashboard.view', 'reports.view', 'costs.write', 'catalog.read', 'catalog.write',
  'inventory.adjust', 'content.write', 'coupons.manage']) p WHERE r.code = 'co_admin' ON CONFLICT DO NOTHING;

-- ---------- extra access, approved by the main admin ----------
CREATE TABLE app.staff_extra_permissions (
  staff_id    uuid NOT NULL REFERENCES app.staff_users(id) ON DELETE CASCADE,
  permission  text NOT NULL REFERENCES app.permissions(code) ON DELETE CASCADE,
  granted_by  uuid REFERENCES app.staff_users(id) ON DELETE SET NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (staff_id, permission),
  CHECK (permission <> 'staff.manage')          -- giving access to others stays with the main admin role
);
CREATE TABLE app.access_requests (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  staff_id      uuid NOT NULL REFERENCES app.staff_users(id) ON DELETE CASCADE,
  permission    text NOT NULL REFERENCES app.permissions(code) ON DELETE CASCADE,
  note          text NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_by    uuid REFERENCES app.staff_users(id) ON DELETE SET NULL,
  decided_at    timestamptz,
  decision_note text NOT NULL DEFAULT '' CHECK (length(decision_note) <= 300),
  CHECK (permission <> 'staff.manage')
);
CREATE UNIQUE INDEX access_requests_one_pending ON app.access_requests (staff_id, permission) WHERE status = 'pending';
CREATE INDEX access_requests_status ON app.access_requests (status, created_at DESC);
CREATE INDEX staff_extra_permissions_permission ON app.staff_extra_permissions (permission);
ALTER TABLE app.staff_extra_permissions ENABLE ROW LEVEL SECURITY; ALTER TABLE app.staff_extra_permissions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.access_requests ENABLE ROW LEVEL SECURITY;        ALTER TABLE app.access_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_all ON app.staff_extra_permissions TO postgres USING (true) WITH CHECK (true);
CREATE POLICY owner_all ON app.access_requests TO postgres USING (true) WITH CHECK (true);
REVOKE ALL ON app.staff_extra_permissions, app.access_requests FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION app.has_perm(p_perm text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.staff_users u
      JOIN app.staff_roles sr ON sr.staff_id = u.id
      JOIN app.role_permissions rp ON rp.role_id = sr.role_id
     WHERE u.id = auth.uid() AND u.status = 'active' AND rp.permission = p_perm
    UNION ALL
    SELECT 1 FROM app.staff_users u
      JOIN app.staff_extra_permissions x ON x.staff_id = u.id
     WHERE u.id = auth.uid() AND u.status = 'active' AND x.permission = p_perm)
  AND app.second_step_ok()
  AND NOT app.must_change_password()
$$;

CREATE OR REPLACE FUNCTION public.admin_me() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE u record; v_require boolean; v_mode text; v_ok boolean;
BEGIN
  SELECT * INTO u FROM app.staff_users WHERE id = auth.uid();
  IF NOT FOUND OR u.status <> 'active' THEN PERFORM app.fail('forbidden', 'This account is not a staff account.'); END IF;
  SELECT require_staff_mfa, staff_second_step INTO v_require, v_mode FROM app.security_settings WHERE id = 1;
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

CREATE OR REPLACE FUNCTION public.admin_coupons() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.require_perm('coupons.manage');
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'code', c.code::text, 'kind', c.kind, 'value', CASE WHEN c.kind = 'fixed' THEN app.rs(c.value) ELSE c.value END,
     'min_subtotal', app.rs(c.min_subtotal_cents), 'starts_at', c.starts_at, 'ends_at', c.ends_at, 'max_redemptions', c.max_redemptions, 'active', c.active,
     'used', (SELECT count(*) FROM app.coupon_redemptions r WHERE r.coupon_id = c.id)) ORDER BY c.created_at DESC) FROM app.coupons c), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.admin_create_coupon(p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_code text; v_kind text; v_value numeric; v_id uuid; v_min bigint; v_starts timestamptz; v_ends timestamptz; v_max int;
BEGIN
  PERFORM app.require_perm('coupons.manage');
  v_code := app.v_match(app.v_text(p_data, 'code', 30, 3), '^[A-Za-z0-9_-]{3,30}$', 'Codes use letters, numbers, - and _ (3 to 30).');
  v_kind := app.v_text(p_data, 'kind', 10, 1);
  IF v_kind NOT IN ('percent', 'fixed') THEN PERFORM app.fail('bad_request', 'kind must be percent or fixed'); END IF;
  IF jsonb_typeof(p_data -> 'value') <> 'number' OR (p_data ->> 'value')::numeric <= 0 THEN PERFORM app.fail('bad_request', 'value must be more than 0'); END IF;
  v_value := (p_data ->> 'value')::numeric;
  IF v_kind = 'percent' AND (v_value < 1 OR v_value > 90 OR v_value <> trunc(v_value)) THEN PERFORM app.fail('bad_request', 'Percent discounts must be a whole number from 1 to 90.'); END IF;
  v_min := app.v_money(p_data, 'minSubtotal', 0, false);
  BEGIN
    v_starts := nullif(p_data ->> 'startsAt', '')::timestamptz; v_ends := nullif(p_data ->> 'endsAt', '')::timestamptz;
  EXCEPTION WHEN others THEN PERFORM app.fail('bad_request', 'invalid date'); END;
  IF p_data ? 'maxRedemptions' AND p_data -> 'maxRedemptions' <> 'null'::jsonb THEN v_max := (p_data ->> 'maxRedemptions')::int; IF v_max < 1 THEN PERFORM app.fail('bad_request', 'max uses must be 1 or more'); END IF; END IF;
  INSERT INTO app.coupons (code, kind, value, min_subtotal_cents, starts_at, ends_at, max_redemptions, active)
  VALUES (v_code, v_kind, CASE WHEN v_kind = 'percent' THEN v_value::bigint ELSE round(v_value * 100)::bigint END, v_min, v_starts, v_ends, v_max, app.v_bool(p_data, 'active', true))
  RETURNING id INTO v_id;
  PERFORM app.audit('coupon.create', 'coupon', v_id::text, NULL, p_data);
  RETURN jsonb_build_object('id', v_id);
END $$;

CREATE OR REPLACE FUNCTION public.admin_set_coupon_active(p_id uuid, p_active boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.require_perm('coupons.manage');
  UPDATE app.coupons SET active = coalesce(p_active, false) WHERE id = p_id;
  PERFORM app.audit('coupon.update', 'coupon', p_id::text, NULL, jsonb_build_object('active', p_active));
  RETURN jsonb_build_object('ok', true);
END $$;

-- permissions that can be given on top of a role (never staff.manage)
CREATE FUNCTION app.grantable(p_perm text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p_perm <> 'staff.manage' AND EXISTS (SELECT 1 FROM app.permissions WHERE code = p_perm)
$$;
-- does this person have it through a role (extra access would change nothing)?
CREATE FUNCTION app.role_has(p_staff uuid, p_perm text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM app.staff_roles sr JOIN app.role_permissions rp ON rp.role_id = sr.role_id WHERE sr.staff_id = p_staff AND rp.permission = p_perm)
$$;

-- any signed-in staff member: ask the main admin for one more permission
CREATE FUNCTION public.admin_request_access(p_permission text, p_note text DEFAULT '') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_staff uuid := app.current_staff_id(); v_id bigint;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Please sign in.' USING ERRCODE = '28000'; END IF;
  IF v_staff IS NULL OR NOT EXISTS (SELECT 1 FROM app.staff_users WHERE id = v_staff AND status = 'active') THEN
    RAISE EXCEPTION 'You do not have permission to do this.' USING ERRCODE = '42501';
  END IF;
  PERFORM app.require_perm('dashboard.view');      -- also makes sure the second sign-in step was done
  IF NOT app.grantable(coalesce(p_permission, '')) THEN PERFORM app.fail('bad_request', 'That access cannot be requested.'); END IF;
  IF app.has_perm(p_permission) THEN PERFORM app.fail('bad_request', 'You already have this access.'); END IF;
  IF length(coalesce(p_note, '')) > 300 THEN PERFORM app.fail('bad_request', 'Keep the note under 300 characters.'); END IF;
  SELECT id INTO v_id FROM app.access_requests WHERE staff_id = v_staff AND permission = p_permission AND status = 'pending';
  IF v_id IS NULL THEN
    INSERT INTO app.access_requests (staff_id, permission, note) VALUES (v_staff, p_permission, coalesce(p_note, '')) RETURNING id INTO v_id;
    PERFORM app.audit('access.request', 'staff', v_staff::text, NULL, jsonb_build_object('permission', p_permission, 'note', coalesce(p_note, '')));
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

-- what I may do, and what I have asked for (any staff member, about themselves)
CREATE FUNCTION public.admin_my_access() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_staff uuid := app.current_staff_id();
BEGIN
  IF v_staff IS NULL THEN RAISE EXCEPTION 'You do not have permission to do this.' USING ERRCODE = '42501'; END IF;
  PERFORM app.require_perm('dashboard.view');
  RETURN jsonb_build_object(
    'permissions', (SELECT jsonb_agg(jsonb_build_object('code', p.code, 'description', p.description,
        'have', app.has_perm(p.code), 'viaRole', app.role_has(v_staff, p.code),
        'pending', EXISTS (SELECT 1 FROM app.access_requests r WHERE r.staff_id = v_staff AND r.permission = p.code AND r.status = 'pending')) ORDER BY p.code)
      FROM app.permissions p WHERE app.grantable(p.code)),
    'requests', coalesce((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'permission', r.permission, 'status', r.status, 'note', r.note,
        'createdAt', r.created_at, 'decidedAt', r.decided_at, 'decisionNote', r.decision_note) ORDER BY r.created_at DESC)
      FROM (SELECT * FROM app.access_requests WHERE staff_id = v_staff ORDER BY created_at DESC LIMIT 30) r), '[]'::jsonb));
END $$;

-- main admin: everything about extra access (requests, and what each person has on top of their roles)
CREATE FUNCTION public.admin_access_overview() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.require_perm('staff.manage');
  RETURN jsonb_build_object(
    'permissions', (SELECT jsonb_agg(jsonb_build_object('code', code, 'description', description) ORDER BY code) FROM app.permissions WHERE app.grantable(code)),
    'extra', coalesce((SELECT jsonb_object_agg(staff_id, perms) FROM (SELECT staff_id, jsonb_agg(permission ORDER BY permission) perms FROM app.staff_extra_permissions GROUP BY staff_id) x), '{}'::jsonb),
    'requests', coalesce((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'staffId', r.staff_id, 'username', u.username::text, 'name', u.display_name,
        'permission', r.permission, 'description', p.description, 'note', r.note, 'status', r.status, 'createdAt', r.created_at,
        'decidedAt', r.decided_at, 'decidedBy', d.username::text, 'decisionNote', r.decision_note) ORDER BY (r.status = 'pending') DESC, r.created_at DESC)
      FROM (SELECT * FROM app.access_requests ORDER BY (status = 'pending') DESC, created_at DESC LIMIT 100) r
      JOIN app.staff_users u ON u.id = r.staff_id JOIN app.permissions p ON p.code = r.permission
      LEFT JOIN app.staff_users d ON d.id = r.decided_by), '[]'::jsonb),
    'pending', (SELECT count(*) FROM app.access_requests WHERE status = 'pending'));
END $$;

-- main admin approves or rejects a request
CREATE FUNCTION public.admin_decide_access(p_id bigint, p_approve boolean, p_note text DEFAULT '') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r app.access_requests;
BEGIN
  PERFORM app.require_perm('staff.manage');
  SELECT * INTO r FROM app.access_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM app.fail('not_found', 'That request does not exist.'); END IF;
  IF r.status <> 'pending' THEN PERFORM app.fail('conflict', 'That request was already answered.'); END IF;
  IF length(coalesce(p_note, '')) > 300 THEN PERFORM app.fail('bad_request', 'Keep the note under 300 characters.'); END IF;
  UPDATE app.access_requests SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END, decided_by = app.current_staff_id(),
         decided_at = now(), decision_note = coalesce(p_note, '') WHERE id = p_id;
  IF p_approve THEN
    INSERT INTO app.staff_extra_permissions (staff_id, permission, granted_by) VALUES (r.staff_id, r.permission, app.current_staff_id())
    ON CONFLICT (staff_id, permission) DO NOTHING;
  END IF;
  PERFORM app.audit(CASE WHEN p_approve THEN 'access.approve' ELSE 'access.reject' END, 'staff', r.staff_id::text, NULL,
    jsonb_build_object('permission', r.permission, 'request', p_id, 'note', coalesce(p_note, '')));
  RETURN jsonb_build_object('ok', true);
END $$;

-- main admin sets a person's extra access directly (the full list: what is left out is taken away)
CREATE FUNCTION public.admin_set_extra_access(p_staff_id uuid, p_permissions text[]) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_before jsonb; v_bad text;
BEGIN
  PERFORM app.require_perm('staff.manage');
  IF NOT EXISTS (SELECT 1 FROM app.staff_users WHERE id = p_staff_id) THEN PERFORM app.fail('not_found', 'That staff account does not exist.'); END IF;
  IF cardinality(coalesce(p_permissions, '{}')) > 40 THEN PERFORM app.fail('bad_request', 'Too many.'); END IF;
  SELECT x INTO v_bad FROM unnest(coalesce(p_permissions, '{}')) x WHERE NOT app.grantable(x) LIMIT 1;
  IF v_bad IS NOT NULL THEN PERFORM app.fail('bad_request', 'This access cannot be given: ' || v_bad); END IF;
  SELECT coalesce(jsonb_agg(permission ORDER BY permission), '[]'::jsonb) INTO v_before FROM app.staff_extra_permissions WHERE staff_id = p_staff_id;
  DELETE FROM app.staff_extra_permissions WHERE staff_id = p_staff_id AND permission <> ALL (coalesce(p_permissions, '{}'));
  INSERT INTO app.staff_extra_permissions (staff_id, permission, granted_by)
  SELECT DISTINCT p_staff_id, x, app.current_staff_id() FROM unnest(coalesce(p_permissions, '{}')) x ON CONFLICT (staff_id, permission) DO NOTHING;
  -- open requests for something now given are answered
  UPDATE app.access_requests SET status = 'approved', decided_by = app.current_staff_id(), decided_at = now(), decision_note = 'given directly'
   WHERE staff_id = p_staff_id AND status = 'pending' AND permission = ANY (coalesce(p_permissions, '{}'));
  PERFORM app.audit('access.set', 'staff', p_staff_id::text, jsonb_build_object('extra', v_before),
    jsonb_build_object('extra', (SELECT coalesce(jsonb_agg(permission ORDER BY permission), '[]'::jsonb) FROM app.staff_extra_permissions WHERE staff_id = p_staff_id)));
  RETURN jsonb_build_object('ok', true);
END $$;

-- ---------- grants: browser roles may call only these ----------
REVOKE ALL ON FUNCTION app.grantable(text), app.role_has(uuid, text) FROM PUBLIC, anon, authenticated;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.admin_request_access(text, text)', 'public.admin_my_access()', 'public.admin_access_overview()',
                           'public.admin_decide_access(bigint, boolean, text)', 'public.admin_set_extra_access(uuid, text[])',
                           'public.admin_coupons()', 'public.admin_me()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END $$;
