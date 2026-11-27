-- Return / refund requests (after delivery), like a marketplace:
--   * the buyer of a DELIVERED order (own account, or the order's secret tracking token) asks within the shop's return
--     window (storefront "returnDays", default 7) counted from the moment the order was marked delivered
--   * chooses items + quantities (never more than bought, minus what is already in an open or finished request),
--     a reason (change of mind is not a reason), details, up to 3 photos, and refund or replacement;
--     Cash on Delivery / bank transfer refunds need the bank account to pay into
--   * staff with returns.manage: approve / reject (with a message to the customer) -> received (optionally back in stock)
--     -> replaced; recording the money refund also needs refunds.create and is written to app.refunds
--   * photos live in a PRIVATE bucket; uploaded by the return-photo Edge Function, seen by staff through short signed links

INSERT INTO app.permissions (code, description) VALUES ('returns.manage', 'See and handle return / refund requests')
ON CONFLICT (code) DO NOTHING;
INSERT INTO app.role_permissions (role_id, permission)
SELECT r.id, 'returns.manage' FROM app.roles r WHERE r.code IN ('owner', 'ops_manager', 'support', 'finance') ON CONFLICT DO NOTHING;

CREATE TABLE app.return_requests (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id        uuid NOT NULL REFERENCES app.orders(id) ON DELETE RESTRICT,
  customer_id     uuid REFERENCES app.customers(id) ON DELETE SET NULL,
  reason          text NOT NULL CHECK (reason IN ('damaged', 'not_working', 'wrong_item', 'not_as_described', 'missing_parts')),
  details         text NOT NULL CHECK (length(details) BETWEEN 10 AND 1000),
  wants           text NOT NULL CHECK (wants IN ('refund', 'replacement')),
  bank            jsonb CHECK (bank IS NULL OR jsonb_typeof(bank) = 'object'),
  photos          text[] NOT NULL DEFAULT '{}' CHECK (cardinality(photos) <= 3),
  status          text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'rejected', 'received', 'refunded', 'replaced', 'cancelled')),
  staff_note      text NOT NULL DEFAULT '' CHECK (length(staff_note) <= 500),
  restocked       boolean NOT NULL DEFAULT false,
  refund_cents    bigint CHECK (refund_cents IS NULL OR refund_cents > 0),
  refund_reference text CHECK (refund_reference IS NULL OR length(refund_reference) <= 80),
  decided_by      uuid REFERENCES app.staff_users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX return_requests_order_idx ON app.return_requests (order_id);
CREATE INDEX return_requests_status_idx ON app.return_requests (status, created_at DESC);
CREATE TABLE app.return_items (
  request_id    bigint NOT NULL REFERENCES app.return_requests(id) ON DELETE CASCADE,
  order_item_id uuid NOT NULL REFERENCES app.order_items(id) ON DELETE RESTRICT,
  quantity      int NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  PRIMARY KEY (request_id, order_item_id)
);
ALTER TABLE app.return_requests ENABLE ROW LEVEL SECURITY; ALTER TABLE app.return_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE app.return_items ENABLE ROW LEVEL SECURITY;    ALTER TABLE app.return_items FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_all ON app.return_requests FOR ALL TO postgres USING (true) WITH CHECK (true);
CREATE POLICY owner_all ON app.return_items FOR ALL TO postgres USING (true) WITH CHECK (true);
REVOKE ALL ON app.return_requests, app.return_items FROM PUBLIC, anon, authenticated;
-- same owner rule as every other app table (the reviews table from 20261119000001 did not get it yet)
CREATE POLICY owner_all ON app.product_reviews FOR ALL TO postgres USING (true) WITH CHECK (true);

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('return-photos', 'return-photos', false, 2097152, ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 2097152, allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp'];
-- staff who handle returns may read (signed links); nobody else may read, and only the Edge Function (service role) writes
CREATE POLICY "staff read return photos" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'return-photos' AND app.has_perm('returns.manage'));

-- ---------- helpers ----------
CREATE FUNCTION app.return_window_days() RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT CASE WHEN jsonb_typeof(value -> 'returnDays') = 'number' THEN (value ->> 'returnDays')::numeric::int END FROM app.site_content WHERE key = 'storefront'), 7)
$$;
CREATE FUNCTION app.delivered_at(p_order uuid) RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT max(created_at) FROM app.order_status_history WHERE order_id = p_order AND to_status = 'delivered'
$$;
-- the order this caller may ask about: their own account, or the order's secret tracking token
CREATE FUNCTION app.return_order(p_number text, p_token text) RETURNS app.orders LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE o app.orders;
BEGIN
  SELECT * INTO o FROM app.orders WHERE order_number = upper(btrim(coalesce(p_number, '')));
  IF NOT FOUND OR NOT (
       (auth.uid() IS NOT NULL AND o.customer_id = auth.uid())
    OR (p_token IS NOT NULL AND length(p_token) BETWEEN 10 AND 100 AND app.sha256_hex(p_token) = o.tracking_token_hash)) THEN
    PERFORM app.fail('not_found', 'Order not found.');
  END IF;
  RETURN o;
END $$;
-- how many of each order line can still be asked for (open and finished requests count; rejected / cancelled do not)
CREATE FUNCTION app.returnable(p_order uuid) RETURNS TABLE (order_item_id uuid, left_qty int) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT oi.id, (oi.quantity - coalesce((SELECT sum(ri.quantity) FROM app.return_items ri JOIN app.return_requests rr ON rr.id = ri.request_id
                                          WHERE ri.order_item_id = oi.id AND rr.status NOT IN ('rejected', 'cancelled')), 0))::int
    FROM app.order_items oi WHERE oi.order_id = p_order
$$;
-- why this order cannot get a new request now ('' = it can)
CREATE FUNCTION app.return_blocker(o app.orders) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE
    WHEN o.status <> 'delivered' THEN 'Returns open after the order is delivered.'
    WHEN app.delivered_at(o.id) IS NULL OR now() > app.delivered_at(o.id) + make_interval(days => app.return_window_days())
      THEN 'The ' || app.return_window_days() || '-day return period for this order has ended. Please call us if you need help.'
    WHEN NOT EXISTS (SELECT 1 FROM app.returnable(o.id) WHERE left_qty > 0) THEN 'Every item in this order is already in a return request.'
    ELSE '' END
$$;
CREATE FUNCTION app.return_view(r app.return_requests, p_staff boolean) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('id', r.id, 'status', r.status, 'reason', r.reason, 'details', r.details, 'wants', r.wants,
    'staffNote', r.staff_note, 'photos', CASE WHEN p_staff THEN to_jsonb(r.photos) ELSE to_jsonb(cardinality(r.photos)) END,
    'refund', CASE WHEN r.refund_cents IS NULL THEN NULL ELSE app.rs(r.refund_cents) END, 'refundReference', CASE WHEN p_staff THEN r.refund_reference END,
    'restocked', r.restocked, 'createdAt', r.created_at, 'updatedAt', r.updated_at,
    'items', coalesce((SELECT jsonb_agg(jsonb_build_object('id', oi.id, 'name', oi.product_name, 'variant', oi.variant_label, 'qty', ri.quantity,
                                                             'unitPrice', app.rs(oi.unit_price_cents)) ORDER BY oi.product_name)
                         FROM app.return_items ri JOIN app.order_items oi ON oi.id = ri.order_item_id WHERE ri.request_id = r.id), '[]'::jsonb))
$$;

-- ---------- customer ----------
CREATE FUNCTION public.order_returns(p_number text, p_token text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE o app.orders := app.return_order(p_number, p_token); v_block text;
BEGIN
  v_block := app.return_blocker(o);
  RETURN jsonb_build_object('eligible', v_block = '', 'message', v_block, 'windowDays', app.return_window_days(),
    'deadline', CASE WHEN app.delivered_at(o.id) IS NOT NULL THEN app.delivered_at(o.id) + make_interval(days => app.return_window_days()) END,
    'paymentMethod', o.payment_method,
    'items', coalesce((SELECT jsonb_agg(jsonb_build_object('id', oi.id, 'name', oi.product_name, 'variant', oi.variant_label, 'qty', oi.quantity,
                                                             'returnable', r.left_qty, 'unitPrice', app.rs(oi.unit_price_cents)) ORDER BY oi.product_name)
                         FROM app.order_items oi JOIN app.returnable(o.id) r ON r.order_item_id = oi.id WHERE oi.order_id = o.id), '[]'::jsonb),
    'requests', coalesce((SELECT jsonb_agg(app.return_view(x, false) ORDER BY x.created_at DESC) FROM app.return_requests x WHERE x.order_id = o.id), '[]'::jsonb));
END $$;

-- used by the return-photo Edge Function before it stores a photo
CREATE FUNCTION public.return_photo_check(p_number text, p_token text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE o app.orders := app.return_order(p_number, p_token); v_block text := app.return_blocker(o);
BEGIN
  IF v_block <> '' THEN PERFORM app.fail('bad_request', v_block); END IF;
  RETURN jsonb_build_object('orderId', o.id,
    'photos', (SELECT count(*) FROM storage.objects WHERE bucket_id = 'return-photos' AND name LIKE 'returns/' || o.id::text || '/%'));
END $$;

CREATE FUNCTION public.return_request_create(p_number text, p_token text, p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o app.orders := app.return_order(p_number, p_token); v_block text; v_reason text; v_details text; v_wants text; v_bank jsonb; v_photos text[] := '{}';
  it jsonb; v_id bigint; v_left int; v_qty int; v_n int := 0; p text;
BEGIN
  -- one request at a time per order: stops two requests racing for the same items
  PERFORM 1 FROM app.orders WHERE id = o.id FOR UPDATE;
  v_block := app.return_blocker(o);
  IF v_block <> '' THEN PERFORM app.fail('bad_request', v_block); END IF;
  IF NOT app.hit_rate_limit('return:' || o.id::text, 10, 3600) THEN PERFORM app.fail('bad_request', 'Too many requests for this order. Try again later.'); END IF;
  v_reason := p_data ->> 'reason';
  IF v_reason IS NULL OR v_reason NOT IN ('damaged', 'not_working', 'wrong_item', 'not_as_described', 'missing_parts') THEN PERFORM app.fail('bad_request', 'Choose the reason for the return.'); END IF;
  v_details := btrim(coalesce(p_data ->> 'details', ''));
  IF length(v_details) NOT BETWEEN 10 AND 1000 THEN PERFORM app.fail('bad_request', 'Tell us what is wrong (10 to 1000 characters).'); END IF;
  v_wants := p_data ->> 'wants';
  IF v_wants IS NULL OR v_wants NOT IN ('refund', 'replacement') THEN PERFORM app.fail('bad_request', 'Choose refund or replacement.'); END IF;
  IF v_wants = 'refund' AND o.payment_method IN ('cod', 'bank_transfer') THEN
    v_bank := jsonb_build_object('bank', app.v_text(p_data -> 'bank', 'bank', 60, 2), 'branch', app.v_text(p_data -> 'bank', 'branch', 60, 0),
                                 'accountName', app.v_text(p_data -> 'bank', 'accountName', 80, 2), 'accountNumber', app.v_text(p_data -> 'bank', 'accountNumber', 30, 4));
    IF (v_bank ->> 'accountNumber') !~ '^[0-9 -]{4,30}$' THEN PERFORM app.fail('bad_request', 'Enter the bank account number (numbers only).'); END IF;
  END IF;
  IF jsonb_typeof(p_data -> 'photos') = 'array' THEN
    IF jsonb_array_length(p_data -> 'photos') > 3 THEN PERFORM app.fail('bad_request', 'Up to 3 photos.'); END IF;
    FOR p IN SELECT jsonb_array_elements_text(p_data -> 'photos') LOOP
      IF p !~ ('^returns/' || o.id::text || '/[0-9a-f-]{36}\.(jpg|png|webp)$') OR NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'return-photos' AND name = p)
         OR EXISTS (SELECT 1 FROM app.return_requests WHERE p = ANY (photos)) OR p = ANY (v_photos) THEN
        PERFORM app.fail('bad_request', 'A photo could not be used. Add it again.');
      END IF;
      v_photos := v_photos || p;
    END LOOP;
  END IF;
  IF jsonb_typeof(p_data -> 'items') <> 'array' OR jsonb_array_length(p_data -> 'items') = 0 THEN PERFORM app.fail('bad_request', 'Choose at least one item to return.'); END IF;
  INSERT INTO app.return_requests (order_id, customer_id, reason, details, wants, bank, photos)
  VALUES (o.id, o.customer_id, v_reason, v_details, v_wants, v_bank, v_photos) RETURNING id INTO v_id;
  FOR it IN SELECT * FROM jsonb_array_elements(p_data -> 'items') LOOP
    v_qty := CASE WHEN jsonb_typeof(it -> 'qty') = 'number' AND (it ->> 'qty') ~ '^[0-9]{1,2}$' THEN (it ->> 'qty')::int END;
    SELECT r.left_qty INTO v_left FROM app.returnable(o.id) r WHERE r.order_item_id::text = it ->> 'id';
    IF v_left IS NULL THEN PERFORM app.fail('bad_request', 'That item is not in this order.'); END IF;
    IF v_qty IS NULL OR v_qty < 1 OR v_qty > v_left THEN PERFORM app.fail('bad_request', 'You can return at most ' || v_left || ' of that item.'); END IF;
    INSERT INTO app.return_items (request_id, order_item_id, quantity) VALUES (v_id, (it ->> 'id')::uuid, v_qty);
    v_n := v_n + 1;
  END LOOP;
  PERFORM app.history(o.id, o.status, o.status, 'customer', 'return request #' || v_id || ' (' || v_reason || ', ' || v_wants || ')');
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

CREATE FUNCTION public.return_request_cancel(p_number text, p_token text, p_id bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o app.orders := app.return_order(p_number, p_token); r app.return_requests;
BEGIN
  SELECT * INTO r FROM app.return_requests WHERE id = p_id AND order_id = o.id FOR UPDATE;
  IF NOT FOUND THEN PERFORM app.fail('not_found', 'Return request not found.'); END IF;
  IF r.status <> 'requested' THEN PERFORM app.fail('bad_request', 'This request is already being handled. Please call us to change it.'); END IF;
  UPDATE app.return_requests SET status = 'cancelled', updated_at = now() WHERE id = r.id;
  PERFORM app.history(o.id, o.status, o.status, 'customer', 'return request #' || r.id || ' withdrawn');
  RETURN jsonb_build_object('ok', true);
END $$;

-- ---------- staff ----------
CREATE FUNCTION public.admin_returns(p_filter text DEFAULT 'open', p_limit int DEFAULT 50, p_offset int DEFAULT 0) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_lim int := least(greatest(coalesce(p_limit, 50), 1), 200); v_off int := greatest(coalesce(p_offset, 0), 0); v_money boolean := app.has_perm('refunds.create');
BEGIN
  PERFORM app.require_perm('returns.manage');
  RETURN jsonb_build_object(
    'counts', (SELECT jsonb_build_object('requested', count(*) FILTER (WHERE status = 'requested'), 'approved', count(*) FILTER (WHERE status = 'approved'),
                 'received', count(*) FILTER (WHERE status = 'received'), 'open', count(*) FILTER (WHERE status IN ('requested', 'approved', 'received')),
                 'closed', count(*) FILTER (WHERE status IN ('rejected', 'refunded', 'replaced', 'cancelled')), 'all', count(*)) FROM app.return_requests),
    'canRefund', v_money,
    'requests', coalesce((SELECT jsonb_agg(app.return_view(r, true) || jsonb_build_object('order', o.order_number, 'customer', o.ship_name, 'phone', o.ship_phone,
        'paymentMethod', o.payment_method, 'paymentStatus', o.payment_status, 'orderTotal', app.rs(o.total_cents),
        'refundedSoFar', app.rs(coalesce((SELECT sum(f.amount_cents) FROM app.refunds f WHERE f.order_id = o.id), 0)::bigint),
        'deliveredAt', app.delivered_at(o.id), 'bank', CASE WHEN v_money THEN r.bank END) ORDER BY r.created_at DESC, r.id DESC)
      FROM (SELECT * FROM app.return_requests x
             WHERE CASE coalesce(p_filter, 'open') WHEN 'open' THEN x.status IN ('requested', 'approved', 'received') WHEN 'closed' THEN x.status IN ('rejected', 'refunded', 'replaced', 'cancelled')
                                                  WHEN 'all' THEN true ELSE x.status = p_filter END
             ORDER BY x.created_at DESC, x.id DESC LIMIT v_lim OFFSET v_off) r JOIN app.orders o ON o.id = r.order_id), '[]'::jsonb));
END $$;

-- p_action: approve | reject | receive | replace | refund.  p_data: {restock: bool} for receive, {amount, reference} for refund
CREATE FUNCTION public.admin_return_update(p_id bigint, p_action text, p_note text DEFAULT '', p_data jsonb DEFAULT '{}'::jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r app.return_requests; o app.orders; v_note text := btrim(coalesce(p_note, '')); v_new text; v_amount bigint; v_done bigint; v_ref text; v_pay uuid; x record; v_moved int;
BEGIN
  PERFORM app.require_perm('returns.manage');
  IF length(v_note) > 500 THEN PERFORM app.fail('bad_request', 'Keep the message under 500 characters.'); END IF;
  SELECT * INTO r FROM app.return_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM app.fail('not_found', 'Return request not found.'); END IF;
  SELECT * INTO o FROM app.orders WHERE id = r.order_id FOR UPDATE;
  v_new := CASE p_action WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' WHEN 'receive' THEN 'received' WHEN 'replace' THEN 'replaced' WHEN 'refund' THEN 'refunded' END;
  IF v_new IS NULL THEN PERFORM app.fail('bad_request', 'Unknown action.'); END IF;
  IF NOT ((p_action = 'approve' AND r.status = 'requested') OR (p_action = 'reject' AND r.status IN ('requested', 'approved'))
       OR (p_action = 'receive' AND r.status = 'approved') OR (p_action = 'replace' AND r.status = 'received')
       OR (p_action = 'refund' AND r.status IN ('approved', 'received'))) THEN
    PERFORM app.fail('conflict', 'This request is "' || r.status || '" now; that step is not possible. Reload the page.');
  END IF;
  IF p_action = 'reject' AND length(v_note) < 5 THEN PERFORM app.fail('bad_request', 'Tell the customer why (at least 5 characters).'); END IF;
  IF p_action = 'receive' AND app.v_bool(p_data, 'restock', false) THEN
    -- put the returned items back in stock, never more than this order took out
    FOR x IN SELECT oi.variant_id, ri.quantity FROM app.return_items ri JOIN app.order_items oi ON oi.id = ri.order_item_id WHERE ri.request_id = r.id AND oi.variant_id IS NOT NULL LOOP
      SELECT least(x.quantity, greatest(0, -coalesce(sum(delta_on_hand), 0)))::int INTO v_moved FROM app.inventory_movements
       WHERE order_id = o.id AND variant_id = x.variant_id AND reason IN ('order_consumed', 'order_cancelled', 'return');
      IF v_moved > 0 THEN
        UPDATE app.inventory SET on_hand = on_hand + v_moved WHERE variant_id = x.variant_id;
        INSERT INTO app.inventory_movements (variant_id, delta_on_hand, reason, order_id, staff_id, note) VALUES (x.variant_id, v_moved, 'return', o.id, app.staff_actor(), 'return request #' || r.id);
      END IF;
    END LOOP;
    UPDATE app.return_requests SET restocked = true WHERE id = r.id;
  END IF;
  IF p_action = 'refund' THEN
    PERFORM app.require_perm('refunds.create');
    IF o.payment_status NOT IN ('paid', 'cod_collected', 'partially_refunded') THEN PERFORM app.fail('bad_request', 'The payment for this order is not recorded as received, so there is nothing to refund yet.'); END IF;
    v_amount := app.v_money(p_data, 'amount', NULL, true);
    SELECT coalesce(sum(amount_cents), 0) INTO v_done FROM app.refunds WHERE order_id = o.id;
    IF v_amount IS NULL OR v_amount <= 0 OR v_amount > o.total_cents - v_done THEN
      PERFORM app.fail('bad_request', 'The refund must be more than 0 and at most ' || app.rs(o.total_cents - v_done) || ' (the order total less earlier refunds).');
    END IF;
    v_ref := btrim(coalesce(p_data ->> 'reference', ''));
    IF length(v_ref) NOT BETWEEN 3 AND 80 THEN PERFORM app.fail('bad_request', 'Enter the refund reference (bank or PayHere reference).'); END IF;
    SELECT id INTO v_pay FROM app.payments WHERE order_id = o.id ORDER BY created_at LIMIT 1;
    INSERT INTO app.refunds (order_id, payment_id, amount_cents, reason, restock, staff_id)
    VALUES (o.id, v_pay, v_amount, 'return request #' || r.id || ' (' || r.reason || ')', r.restocked, app.staff_actor());
    UPDATE app.return_requests SET refund_cents = v_amount, refund_reference = v_ref WHERE id = r.id;
    IF v_done + v_amount = o.total_cents THEN
      UPDATE app.orders SET payment_status = 'refunded', status = 'refunded' WHERE id = o.id;
      PERFORM app.history(o.id, o.status, 'refunded', 'staff:' || app.staff_label(), 'refunded in full (return request #' || r.id || ')');
    ELSE
      UPDATE app.orders SET payment_status = 'partially_refunded' WHERE id = o.id;
    END IF;
  END IF;
  UPDATE app.return_requests SET status = v_new, staff_note = CASE WHEN v_note <> '' THEN v_note ELSE staff_note END, decided_by = app.staff_actor(), updated_at = now() WHERE id = r.id;
  IF p_action <> 'refund' OR v_done + v_amount < o.total_cents THEN
    PERFORM app.history(o.id, o.status, o.status, 'staff:' || app.staff_label(), 'return request #' || r.id || ': ' || v_new || CASE WHEN v_note <> '' THEN ' — ' || v_note ELSE '' END);
  END IF;
  PERFORM app.audit('return.' || p_action, 'return', r.id::text, jsonb_build_object('status', r.status),
    jsonb_build_object('status', v_new, 'note', v_note, 'amount', CASE WHEN v_amount IS NULL THEN NULL ELSE app.rs(v_amount) END, 'reference', v_ref, 'restock', app.v_bool(p_data, 'restock', false)));
  RETURN jsonb_build_object('ok', true, 'status', v_new);
END $$;

REVOKE ALL ON FUNCTION app.return_window_days(), app.delivered_at(uuid), app.return_order(text, text), app.returnable(uuid), app.return_blocker(app.orders),
  app.return_view(app.return_requests, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_returns(text, text), public.return_photo_check(text, text), public.return_request_create(text, text, jsonb),
  public.return_request_cancel(text, text, bigint), public.admin_returns(text, int, int), public.admin_return_update(bigint, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.order_returns(text, text), public.return_request_create(text, text, jsonb), public.return_request_cancel(text, text, bigint) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.return_photo_check(text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_returns(text, int, int), public.admin_return_update(bigint, text, text, jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_returns(text, int, int), public.admin_return_update(bigint, text, text, jsonb) FROM anon;
