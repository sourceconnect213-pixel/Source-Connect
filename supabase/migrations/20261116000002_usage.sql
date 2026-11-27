-- "Usage" page in the admin: how much of the Supabase Pro plan the shop uses, read straight from the database.
-- Only numbers the database can see are shown. Data transfer (egress) and the billed monthly-active-user count are
-- measured by Supabase outside the database, so the page links to the Supabase dashboard for those.
-- Main admin only (owner); others can be given it on request (usage.view is grantable).
INSERT INTO app.permissions (code, description) VALUES ('usage.view', 'See how much of the hosting plan is used (database, photos, users, connections)')
ON CONFLICT (code) DO NOTHING;
INSERT INTO app.role_permissions (role_id, permission)
SELECT r.id, 'usage.view' FROM app.roles r WHERE r.code = 'owner' ON CONFLICT DO NOTHING;

CREATE FUNCTION public.admin_usage() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_month timestamptz := date_trunc('month', now() AT TIME ZONE 'Asia/Colombo') AT TIME ZONE 'Asia/Colombo';
        v_today timestamptz := date_trunc('day', now() AT TIME ZONE 'Asia/Colombo') AT TIME ZONE 'Asia/Colombo';
BEGIN
  PERFORM app.require_perm('usage.view');
  RETURN jsonb_build_object(
    'measuredAt', now(),
    'databaseBytes', pg_database_size(current_database()),
    'storageBytes', coalesce((SELECT sum(coalesce((o.metadata ->> 'size')::bigint, 0)) FROM storage.objects o), 0),
    'storageFiles', (SELECT count(*) FROM storage.objects),
    'accounts', (SELECT count(*) FROM auth.users),
    'customers', (SELECT count(*) FROM app.customers),
    'staff', (SELECT count(*) FROM app.staff_users WHERE status = 'active'),
    'signedInThisMonth', (SELECT count(*) FROM auth.users WHERE last_sign_in_at >= v_month),
    'connections', (SELECT count(*) FROM pg_stat_activity),
    'maxConnections', current_setting('max_connections')::int,
    'products', (SELECT count(*) FROM app.products WHERE status = 'active'),
    'ordersToday', (SELECT count(*) FROM app.orders WHERE placed_at >= v_today),
    'ordersThisMonth', (SELECT count(*) FROM app.orders WHERE placed_at >= v_month),
    'ordersTotal', (SELECT count(*) FROM app.orders));
END $$;
REVOKE ALL ON FUNCTION public.admin_usage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_usage() TO authenticated;
