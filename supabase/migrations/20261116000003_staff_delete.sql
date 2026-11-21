-- Main admin can delete a staff account (Staff & Roles -> Edit -> Delete account).
-- The database checks the rules with the caller's own token; the admin-staff Edge Function then removes the
-- Supabase Auth sign-in account. History is kept: every table that points at a staff member keeps its rows
-- (the link becomes empty, ON DELETE SET NULL) and the audit log keeps the name as text.
CREATE FUNCTION public.admin_staff_delete(p_staff_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE u app.staff_users; v_roles jsonb;
BEGIN
  PERFORM app.require_perm('staff.manage');
  SELECT * INTO u FROM app.staff_users WHERE id = p_staff_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM app.fail('not_found', 'That staff account does not exist.'); END IF;
  IF p_staff_id = auth.uid() THEN PERFORM app.fail('bad_request', 'You cannot delete your own account.'); END IF;
  SELECT coalesce(jsonb_agg(r.code ORDER BY r.code), '[]'::jsonb) INTO v_roles FROM app.staff_roles sr JOIN app.roles r ON r.id = sr.role_id WHERE sr.staff_id = p_staff_id;
  -- never leave the shop without an active main admin
  IF v_roles ? 'owner' AND u.status = 'active' AND NOT EXISTS (
       SELECT 1 FROM app.staff_users o JOIN app.staff_roles sr ON sr.staff_id = o.id JOIN app.roles r ON r.id = sr.role_id
        WHERE r.code = 'owner' AND o.status = 'active' AND o.id <> p_staff_id) THEN
    PERFORM app.fail('bad_request', 'At least one active owner account is required.');
  END IF;
  PERFORM app.audit('staff.delete', 'staff', p_staff_id::text,
    jsonb_build_object('username', u.username::text, 'displayName', u.display_name, 'roles', v_roles), NULL);
  DELETE FROM app.staff_users WHERE id = p_staff_id;
  RETURN jsonb_build_object('ok', true);
END $$;
REVOKE ALL ON FUNCTION public.admin_staff_delete(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_staff_delete(uuid) TO authenticated;
