-- Customer profile: a second phone number, an address at sign-up, and a profile photo.
--   * sign-up sends name, phone, phone2 and address in the account data; the sign-up trigger saves them
--     (an address that does not pass the checks is skipped, never blocking the sign-up)
--   * profile photo: public "avatars" bucket, 2 MB, JPEG/PNG/WebP; each person writes only <their id>/<uuid>.<ext>,
--     at most 3 files at a time; shown next to their reviews
--   * no email is needed (the owner turned email confirmation off), so a forgotten password is reset by staff with
--     customers.write: admin_customer_password_check() here, the new password is set by the admin-staff Edge Function

ALTER TABLE app.customers
  ADD COLUMN phone2 text CHECK (phone2 IS NULL OR length(phone2) <= 20),
  ADD COLUMN avatar_path text CHECK (avatar_path IS NULL OR avatar_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$');

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('avatars', 'avatars', true, 2097152, ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO UPDATE SET public = true, file_size_limit = 2097152, allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp'];

CREATE POLICY "own avatar upload" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'avatars' AND name ~ ('^' || (SELECT auth.uid())::text || '/[0-9a-f-]{36}\.(jpg|png|webp)$'));
CREATE POLICY "own avatar read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'avatars' AND split_part(name, '/', 1) = (SELECT auth.uid())::text);
CREATE POLICY "own avatar delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'avatars' AND split_part(name, '/', 1) = (SELECT auth.uid())::text);

-- no more than 3 photo files per person (old ones are deleted by the page after a new one is saved)
CREATE FUNCTION app.limit_avatar_files() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.bucket_id = 'avatars' AND (SELECT count(*) FROM storage.objects o WHERE o.bucket_id = 'avatars' AND split_part(o.name, '/', 1) = split_part(NEW.name, '/', 1)) >= 3 THEN
    RAISE EXCEPTION 'Too many photos. Remove an old one first.' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER avatar_file_limit BEFORE INSERT ON storage.objects FOR EACH ROW EXECUTE FUNCTION app.limit_avatar_files();

-- sign-up: name, phones and the address come from the account data
CREATE OR REPLACE FUNCTION app.handle_new_auth_user() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE m jsonb := coalesce(NEW.raw_user_meta_data, '{}'::jsonb); a jsonb; v_d text; v_name text;
BEGIN
  IF coalesce(NEW.raw_app_meta_data ->> 'kind', '') <> 'staff' THEN
    v_name := left(btrim(coalesce(m ->> 'name', '')), 80);
    INSERT INTO app.customers (id, email, phone, phone2, name)
    VALUES (NEW.id, NEW.email, nullif(left(btrim(coalesce(m ->> 'phone', '')), 20), ''), nullif(left(btrim(coalesce(m ->> 'phone2', '')), 20), ''), v_name)
    ON CONFLICT (id) DO NOTHING;
    a := m -> 'address';
    IF jsonb_typeof(a) = 'object' THEN
      SELECT code INTO v_d FROM app.districts WHERE code = a ->> 'district' OR lower(name) = lower(a ->> 'district') LIMIT 1;
      IF v_d IS NOT NULL AND length(btrim(coalesce(a ->> 'line1', ''))) BETWEEN 4 AND 200 AND length(btrim(coalesce(a ->> 'city', ''))) BETWEEN 2 AND 60 THEN
        INSERT INTO app.customer_addresses (customer_id, name, phone, line1, city, district_code, is_default)
        VALUES (NEW.id, coalesce(nullif(v_name, ''), 'Customer'), left(btrim(coalesce(m ->> 'phone', '')), 20), btrim(a ->> 'line1'), btrim(a ->> 'city'), v_d, true);
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- the photo file must already be uploaded to the person's own folder
CREATE FUNCTION public.set_my_avatar(p_path text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM app.customers WHERE id = auth.uid() AND status = 'active') THEN PERFORM app.fail('unauthorized', 'Please sign in to your account.'); END IF;
  IF coalesce(p_path, '') = '' THEN
    UPDATE app.customers SET avatar_path = NULL WHERE id = auth.uid();
  ELSE
    IF p_path !~ ('^' || auth.uid()::text || '/[0-9a-f-]{36}\.(jpg|png|webp)$') THEN PERFORM app.fail('bad_request', 'That photo cannot be used.'); END IF;
    IF NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'avatars' AND name = p_path) THEN PERFORM app.fail('not_found', 'Upload the photo first.'); END IF;
    UPDATE app.customers SET avatar_path = p_path WHERE id = auth.uid();
  END IF;
  RETURN public.my_profile();
END $$;

-- staff: registered customer accounts (also those who have not ordered yet)
CREATE FUNCTION public.admin_customer_accounts(p_q text DEFAULT NULL, p_limit int DEFAULT 100, p_offset int DEFAULT 0) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_like text;
BEGIN
  PERFORM app.require_perm('customers.read');
  IF p_limit NOT BETWEEN 1 AND 200 OR p_offset < 0 OR length(coalesce(p_q, '')) > 80 THEN PERFORM app.fail('bad_request', 'invalid filter'); END IF;
  v_like := CASE WHEN coalesce(p_q, '') = '' THEN NULL ELSE '%' || replace(replace(p_q, '%', ''), '_', '') || '%' END;
  PERFORM app.audit('customers.list_accounts', 'customers', NULL, NULL, jsonb_build_object('q', p_q));
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'email', c.email::text, 'phone', c.phone, 'phone2', c.phone2, 'avatar', c.avatar_path,
      'status', c.status, 'createdAt', c.created_at,
      'address', (SELECT a.line1 || ', ' || a.city || ', ' || d.name FROM app.customer_addresses a JOIN app.districts d ON d.code = a.district_code WHERE a.customer_id = c.id AND a.is_default LIMIT 1),
      'orders', (SELECT count(*) FROM app.orders o WHERE o.customer_id = c.id)) ORDER BY c.created_at DESC)
    FROM (SELECT * FROM app.customers x
           WHERE v_like IS NULL OR x.name ILIKE v_like OR x.email::text ILIKE v_like OR x.phone ILIKE v_like OR x.phone2 ILIKE v_like
           ORDER BY x.created_at DESC LIMIT p_limit OFFSET p_offset) c), '[]'::jsonb);
END $$;

-- staff: may this caller set a new password for this customer? (the admin-staff Edge Function then sets it)
CREATE FUNCTION public.admin_customer_password_check(p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c app.customers;
BEGIN
  PERFORM app.require_perm('customers.write');
  SELECT * INTO c FROM app.customers WHERE id = p_id;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM app.staff_users WHERE id = p_id) THEN PERFORM app.fail('not_found', 'Customer account not found.'); END IF;
  PERFORM app.audit('customer.password_reset', 'customer', p_id::text, NULL, jsonb_build_object('email', c.email::text));
  RETURN jsonb_build_object('ok', true);
END $$;

REVOKE ALL ON FUNCTION app.limit_avatar_files() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_my_avatar(text), public.admin_customer_accounts(text, int, int), public.admin_customer_password_check(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_my_avatar(text), public.admin_customer_accounts(text, int, int), public.admin_customer_password_check(uuid) TO authenticated;

-- profile, reviews: also return the second phone and the photo
CREATE OR REPLACE FUNCTION public.my_profile() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('id', c.id, 'name', c.name, 'email', c.email::text, 'phone', c.phone, 'phone2', c.phone2, 'avatar', c.avatar_path,
    'verified', (SELECT u.email_confirmed_at IS NOT NULL FROM auth.users u WHERE u.id = c.id),
    'address', (SELECT jsonb_build_object('name', a.name, 'phone', a.phone, 'line1', a.line1, 'city', a.city, 'district', d.name)
                  FROM app.customer_addresses a JOIN app.districts d ON d.code = a.district_code WHERE a.customer_id = c.id AND a.is_default))
    FROM app.customers c WHERE c.id = auth.uid() AND c.status = 'active'
$$;

CREATE OR REPLACE FUNCTION public.update_my_profile(p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_name text; v_phone text; v_d text; a jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM app.customers WHERE id = auth.uid() AND status = 'active') THEN PERFORM app.fail('unauthorized', 'Please sign in to your account.'); END IF;
  v_name := app.v_text(p_data, 'name', 80, 2); v_phone := app.v_text(p_data, 'phone', 20);
  UPDATE app.customers SET name = v_name, phone = nullif(v_phone, '') WHERE id = auth.uid();
  IF p_data ? 'phone2' THEN UPDATE app.customers SET phone2 = nullif(app.v_text(p_data, 'phone2', 20), '') WHERE id = auth.uid(); END IF;
  a := p_data -> 'address';
  IF a IS NOT NULL AND a <> 'null'::jsonb THEN
    SELECT code INTO v_d FROM app.districts WHERE code = a ->> 'district' OR lower(name) = lower(a ->> 'district');
    IF v_d IS NULL THEN PERFORM app.fail('bad_request', 'Please choose your district.'); END IF;
    DELETE FROM app.customer_addresses WHERE customer_id = auth.uid() AND is_default;
    INSERT INTO app.customer_addresses (customer_id, name, phone, line1, city, district_code, is_default)
    VALUES (auth.uid(), v_name, coalesce(v_phone, ''), app.v_text(a, 'line1', 200, 4), app.v_text(a, 'city', 60, 2), v_d, true);
  END IF;
  RETURN public.my_profile();
END $$;

CREATE OR REPLACE FUNCTION public.product_reviews(p_product text, p_stars int DEFAULT NULL, p_limit int DEFAULT 10, p_offset int DEFAULT 0) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
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
    'reviews', coalesce((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'name', r.author_name, 'avatar', (SELECT c.avatar_path FROM app.customers c WHERE c.id = r.customer_id), 'rating', r.rating, 'comment', r.comment, 'variant', r.variant_label,
        'at', r.created_at, 'edited', r.updated_at > r.created_at + interval '1 minute', 'reply', nullif(r.reply, ''), 'repliedAt', r.replied_at) ORDER BY r.created_at DESC, r.id DESC)
      FROM (SELECT * FROM app.product_reviews WHERE product_id = v_pid AND status = 'visible' AND (p_stars IS NULL OR rating = p_stars)
             ORDER BY created_at DESC, id DESC LIMIT v_lim OFFSET v_off) r), '[]'::jsonb));
END $$;
