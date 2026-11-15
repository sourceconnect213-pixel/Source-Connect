-- Customer emails need an email provider (SMTP) connected in Supabase Auth (and in the VPS worker for order emails).
--
-- Supabase's built-in sender only delivers to members of the project's own organization (documented Auth error
-- `email_address_not_authorized`). Until a provider is connected, a real customer therefore cannot create an account or
-- reset a password; ordering as a guest is not affected.
--
-- The database cannot see that dashboard setting, so the fact is recorded here once the provider is connected:
--     UPDATE app.ops_settings SET email_configured = true;
-- Until then the admin's "Before you go live" list shows it as open.
ALTER TABLE app.ops_settings ADD COLUMN IF NOT EXISTS email_configured boolean NOT NULL DEFAULT false;

-- The dashboard function, unchanged except for the new `email` key (CREATE OR REPLACE keeps its grants).
CREATE OR REPLACE FUNCTION public.admin_dashboard() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r jsonb;
BEGIN
  PERFORM app.require_perm('dashboard.view');
  WITH o AS (SELECT * FROM app.orders x WHERE app.staff_sees_order(x.id))
  SELECT jsonb_build_object(
    'received', app.rs(coalesce((SELECT sum(total_cents) FROM o WHERE payment_status IN ('paid', 'cod_collected')), 0)::bigint),
    'booked', app.rs(coalesce((SELECT sum(total_cents) FROM o WHERE status NOT IN ('cancelled', 'expired', 'refunded', 'pending_payment')), 0)::bigint),
    'orders', (SELECT count(*) FROM o WHERE status NOT IN ('cancelled', 'expired')),
    'byStatus', coalesce((SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*) n FROM o GROUP BY status) s), '{}'::jsonb),
    'last7days', (SELECT jsonb_agg(jsonb_build_object('day', to_char(dd, 'YYYY-MM-DD'), 'total', app.rs(coalesce((SELECT sum(total_cents) FROM o
                     WHERE (placed_at AT TIME ZONE 'Asia/Colombo')::date = dd::date AND status NOT IN ('cancelled', 'expired', 'pending_payment')), 0)::bigint)) ORDER BY dd)
                  FROM generate_series((now() AT TIME ZONE 'Asia/Colombo')::date - 6, (now() AT TIME ZONE 'Asia/Colombo')::date, interval '1 day') dd),
    'lowStock', coalesce((SELECT jsonb_agg(x) FROM (SELECT jsonb_build_object('slug', p.slug, 'name', p.name, 'size', v.size, 'available', i.on_hand - i.reserved, 'reorder_level', i.reorder_level) x
                  FROM app.inventory i JOIN app.product_variants v ON v.id = i.variant_id JOIN app.products p ON p.id = v.product_id
                 WHERE p.status = 'active' AND v.active AND i.on_hand - i.reserved <= i.reorder_level AND app.can_shop(p.shop_id) ORDER BY i.on_hand - i.reserved, p.name LIMIT 50) q), '[]'::jsonb),
    'needsReview', (SELECT count(*) FROM o WHERE needs_review),
    'payments', jsonb_build_object('bank', (SELECT count(*) FROM o WHERE status = 'awaiting_bank_transfer'),
                  'cod_uncollected', (SELECT count(*) FROM o WHERE payment_status = 'cod_pending' AND status = 'delivered'),
                  'card_pending', (SELECT count(*) FROM o WHERE status = 'pending_payment')),
    'queue', CASE WHEN app.has_perm('backups.read') THEN (SELECT jsonb_build_object('waiting', count(*) FILTER (WHERE status = 'queued'), 'running', count(*) FILTER (WHERE status = 'running'),
                  'dead', count(*) FILTER (WHERE status = 'dead'), 'oldestWaitingMinutes', round(extract(epoch FROM now() - min(created_at) FILTER (WHERE status = 'queued')) / 60)) FROM app.jobs) END,
    'backups', CASE WHEN app.has_perm('backups.read') THEN app.backup_health() END,
    'payhere', (SELECT jsonb_build_object('mode', payhere_mode, 'configured', payhere_configured) FROM app.ops_settings WHERE id = 1),
    'email', (SELECT jsonb_build_object('configured', email_configured) FROM app.ops_settings WHERE id = 1)
  ) INTO r;
  RETURN r;
END $$;
