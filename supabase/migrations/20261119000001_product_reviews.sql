-- Product reviews (star rating + written opinion), like a marketplace:
--   * only a person who RECEIVED the product can review it: the order must be delivered, and the caller must be the
--     signed-in customer who placed it, or hold the order's secret tracking token (guest orders, same device)
--   * one review per product per order; the buyer can change it later (a hidden review stays hidden)
--   * published at once; staff with reviews.manage can hide / show it and reply as the shop
--   * products.rating / reviews_count are recomputed from the visible reviews after every change
--   * the public sees a short name ("Nimal P."), never the full name, phone, email or order number

INSERT INTO app.permissions (code, description) VALUES ('reviews.manage', 'Hide or show product reviews and reply to them')
ON CONFLICT (code) DO NOTHING;
INSERT INTO app.role_permissions (role_id, permission)
SELECT r.id, 'reviews.manage' FROM app.roles r WHERE r.code IN ('owner', 'ops_manager', 'support', 'co_admin') ON CONFLICT DO NOTHING;

CREATE TABLE app.product_reviews (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id    uuid NOT NULL REFERENCES app.products(id) ON DELETE CASCADE,
  order_id      uuid NOT NULL REFERENCES app.orders(id) ON DELETE CASCADE,
  customer_id   uuid REFERENCES app.customers(id) ON DELETE SET NULL,
  author_name   text NOT NULL CHECK (length(author_name) BETWEEN 1 AND 40),
  variant_label text NOT NULL DEFAULT '' CHECK (length(variant_label) <= 80),
  rating        smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment       text NOT NULL DEFAULT '' CHECK (length(comment) <= 1000),
  status        text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'hidden')),
  reply         text NOT NULL DEFAULT '' CHECK (length(reply) <= 1000),
  replied_at    timestamptz,
  replied_by    uuid REFERENCES app.staff_users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, product_id)
);
CREATE INDEX product_reviews_product_idx ON app.product_reviews (product_id, status, created_at DESC);
CREATE INDEX product_reviews_created_idx ON app.product_reviews (created_at DESC);
ALTER TABLE app.product_reviews ENABLE ROW LEVEL SECURITY; ALTER TABLE app.product_reviews FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.product_reviews FROM PUBLIC, anon, authenticated;

-- "Nimal Perera" -> "Nimal P."  (public display name)
CREATE FUNCTION app.review_name(p_name text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN cardinality(w) = 0 THEN 'Customer'
              WHEN cardinality(w) = 1 THEN left(w[1], 30)
              ELSE left(w[1], 30) || ' ' || upper(left(w[cardinality(w)], 1)) || '.' END
    FROM (SELECT coalesce(array_remove(regexp_split_to_array(btrim(coalesce(p_name, '')), '\s+'), ''), '{}') AS w) x
$$;

CREATE FUNCTION app.refresh_rating(p_product uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  UPDATE app.products p SET rating = coalesce((SELECT round(avg(r.rating)::numeric, 1) FROM app.product_reviews r WHERE r.product_id = p.id AND r.status = 'visible'), 0),
                            reviews_count = (SELECT count(*) FROM app.product_reviews r WHERE r.product_id = p.id AND r.status = 'visible')
   WHERE p.id = p_product
$$;

-- The order this caller may review: the buyer's own signed-in account, or the order's secret tracking token.
CREATE FUNCTION app.review_order(p_number text, p_token text) RETURNS app.orders LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
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

-- What can be reviewed in this order, and the reviews already written (for the order page)
CREATE FUNCTION public.order_reviews(p_number text, p_token text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE o app.orders := app.review_order(p_number, p_token);
BEGIN
  RETURN jsonb_build_object('canReview', o.status = 'delivered',
    'items', coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.slug, 'name', i.name, 'variant', i.variant,
        'review', (SELECT jsonb_build_object('rating', r.rating, 'comment', r.comment, 'status', r.status, 'reply', r.reply, 'at', r.updated_at)
                     FROM app.product_reviews r WHERE r.order_id = o.id AND r.product_id = p.id)) ORDER BY i.name)
      FROM (SELECT oi.product_id, min(oi.product_name) AS name, string_agg(DISTINCT nullif(oi.variant_label, ''), ', ') AS variant
              FROM app.order_items oi WHERE oi.order_id = o.id AND oi.product_id IS NOT NULL GROUP BY oi.product_id) i
      JOIN app.products p ON p.id = i.product_id), '[]'::jsonb));
END $$;

CREATE FUNCTION public.submit_review(p_number text, p_token text, p_product text, p_rating int, p_comment text DEFAULT '') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o app.orders := app.review_order(p_number, p_token); v_pid uuid; v_variant text; v_comment text := btrim(coalesce(p_comment, ''));
BEGIN
  IF o.status <> 'delivered' THEN PERFORM app.fail('bad_request', 'You can review the items after the order is delivered.'); END IF;
  IF p_rating IS NULL OR p_rating NOT BETWEEN 1 AND 5 THEN PERFORM app.fail('bad_request', 'Choose 1 to 5 stars.'); END IF;
  IF length(v_comment) > 1000 THEN PERFORM app.fail('bad_request', 'Keep your review under 1000 characters.'); END IF;
  IF v_comment ~* '(https?://|www\.|\.(com|lk|net|org)\y)' THEN PERFORM app.fail('bad_request', 'Please do not put links in a review.'); END IF;
  SELECT p.id, string_agg(DISTINCT nullif(oi.variant_label, ''), ', ') INTO v_pid, v_variant
    FROM app.order_items oi JOIN app.products p ON p.id = oi.product_id
   WHERE oi.order_id = o.id AND p.slug = p_product GROUP BY p.id;
  IF v_pid IS NULL THEN PERFORM app.fail('not_found', 'That product is not in this order.'); END IF;
  IF NOT app.hit_rate_limit('review:' || o.id::text, 30, 3600) THEN PERFORM app.fail('bad_request', 'Too many changes. Try again later.'); END IF;
  INSERT INTO app.product_reviews (product_id, order_id, customer_id, author_name, variant_label, rating, comment)
  VALUES (v_pid, o.id, o.customer_id, app.review_name(o.ship_name), left(coalesce(v_variant, ''), 80), p_rating, v_comment)
  ON CONFLICT (order_id, product_id) DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, updated_at = now();   -- status (hidden) and the shop's reply are kept
  PERFORM app.refresh_rating(v_pid);
  RETURN jsonb_build_object('ok', true);
END $$;

-- Public: summary and the visible reviews of one product (newest first; optional star filter)
CREATE FUNCTION public.product_reviews(p_product text, p_stars int DEFAULT NULL, p_limit int DEFAULT 10, p_offset int DEFAULT 0) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_pid uuid; v_lim int := least(greatest(coalesce(p_limit, 10), 1), 50); v_off int := greatest(coalesce(p_offset, 0), 0);
BEGIN
  SELECT id INTO v_pid FROM app.products WHERE slug = p_product AND status = 'active';
  IF v_pid IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object(
    'count', (SELECT count(*) FROM app.product_reviews WHERE product_id = v_pid AND status = 'visible'),
    'average', (SELECT coalesce(round(avg(rating)::numeric, 1), 0) FROM app.product_reviews WHERE product_id = v_pid AND status = 'visible'),
    'stars', (SELECT jsonb_build_object('5', count(*) FILTER (WHERE rating = 5), '4', count(*) FILTER (WHERE rating = 4), '3', count(*) FILTER (WHERE rating = 3),
                                        '2', count(*) FILTER (WHERE rating = 2), '1', count(*) FILTER (WHERE rating = 1))
                FROM app.product_reviews WHERE product_id = v_pid AND status = 'visible'),
    'matching', (SELECT count(*) FROM app.product_reviews WHERE product_id = v_pid AND status = 'visible' AND (p_stars IS NULL OR rating = p_stars)),
    'reviews', coalesce((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'name', r.author_name, 'rating', r.rating, 'comment', r.comment, 'variant', r.variant_label,
        'at', r.created_at, 'edited', r.updated_at > r.created_at + interval '1 minute', 'reply', nullif(r.reply, ''), 'repliedAt', r.replied_at) ORDER BY r.created_at DESC, r.id DESC)
      FROM (SELECT * FROM app.product_reviews WHERE product_id = v_pid AND status = 'visible' AND (p_stars IS NULL OR rating = p_stars)
             ORDER BY created_at DESC, id DESC LIMIT v_lim OFFSET v_off) r), '[]'::jsonb));
END $$;

-- Staff: all reviews (newest first) with the buyer's order, to hide abuse and reply
CREATE FUNCTION public.admin_reviews(p_filter text DEFAULT 'all', p_limit int DEFAULT 50, p_offset int DEFAULT 0) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_lim int := least(greatest(coalesce(p_limit, 50), 1), 200); v_off int := greatest(coalesce(p_offset, 0), 0);
BEGIN
  PERFORM app.require_perm('reviews.manage');
  RETURN jsonb_build_object(
    'counts', (SELECT jsonb_build_object('all', count(*), 'low', count(*) FILTER (WHERE rating <= 2), 'unanswered', count(*) FILTER (WHERE reply = '' AND comment <> ''),
                                         'hidden', count(*) FILTER (WHERE status = 'hidden'), 'week', count(*) FILTER (WHERE created_at > now() - interval '7 days'))
                 FROM app.product_reviews),
    'reviews', coalesce((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'product', p.slug, 'productName', p.name, 'order', o.order_number, 'buyer', o.ship_name,
        'name', r.author_name, 'rating', r.rating, 'comment', r.comment, 'variant', r.variant_label, 'status', r.status, 'reply', r.reply,
        'at', r.created_at, 'updatedAt', r.updated_at, 'repliedAt', r.replied_at) ORDER BY r.created_at DESC, r.id DESC)
      FROM (SELECT * FROM app.product_reviews x
             WHERE CASE coalesce(p_filter, 'all') WHEN 'low' THEN x.rating <= 2 WHEN 'unanswered' THEN x.reply = '' AND x.comment <> ''
                                                  WHEN 'hidden' THEN x.status = 'hidden' ELSE true END
             ORDER BY x.created_at DESC, x.id DESC LIMIT v_lim OFFSET v_off) r
      JOIN app.products p ON p.id = r.product_id JOIN app.orders o ON o.id = r.order_id), '[]'::jsonb));
END $$;

-- Staff: hide / show a review and/or reply to it (empty reply removes the reply)
CREATE FUNCTION public.admin_review_update(p_id bigint, p_status text DEFAULT NULL, p_reply text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r app.product_reviews; v_reply text := btrim(p_reply);
BEGIN
  PERFORM app.require_perm('reviews.manage');
  SELECT * INTO r FROM app.product_reviews WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM app.fail('not_found', 'Review not found.'); END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('visible', 'hidden') THEN PERFORM app.fail('bad_request', 'Choose show or hide.'); END IF;
  IF length(v_reply) > 1000 THEN PERFORM app.fail('bad_request', 'Keep the reply under 1000 characters.'); END IF;
  UPDATE app.product_reviews SET status = coalesce(p_status, status),
         reply = coalesce(v_reply, reply),
         replied_at = CASE WHEN v_reply IS NULL THEN replied_at WHEN v_reply = '' THEN NULL ELSE now() END,
         replied_by = CASE WHEN v_reply IS NULL THEN replied_by WHEN v_reply = '' THEN NULL ELSE app.current_staff_id() END
   WHERE id = p_id;
  PERFORM app.refresh_rating(r.product_id);
  PERFORM app.audit(CASE WHEN p_status = 'hidden' THEN 'review.hide' WHEN p_status = 'visible' THEN 'review.show' ELSE 'review.reply' END, 'review', p_id::text,
    jsonb_build_object('status', r.status, 'reply', r.reply), jsonb_build_object('status', coalesce(p_status, r.status), 'reply', coalesce(v_reply, r.reply)));
  RETURN jsonb_build_object('ok', true);
END $$;

REVOKE ALL ON FUNCTION app.review_name(text), app.refresh_rating(uuid), app.review_order(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_reviews(text, text), public.submit_review(text, text, text, int, text), public.product_reviews(text, int, int, int),
  public.admin_reviews(text, int, int), public.admin_review_update(bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.order_reviews(text, text), public.submit_review(text, text, text, int, text), public.product_reviews(text, int, int, int) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_reviews(text, int, int), public.admin_review_update(bigint, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_reviews(text, int, int), public.admin_review_update(bigint, text, text) FROM anon;
