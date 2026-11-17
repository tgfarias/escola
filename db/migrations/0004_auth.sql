CREATE TABLE devices (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  kind text NOT NULL CHECK (kind IN ('guardian', 'kitchen')),
  guardian_id uuid,
  secret_hash text,
  pairing_code_hash text,
  pairing_expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  FOREIGN KEY (school_id, guardian_id) REFERENCES guardians (school_id, id),
  CHECK ((kind = 'guardian') = (guardian_id IS NOT NULL))
);

CREATE UNIQUE INDEX devices_guardian_secret
  ON devices (school_id, guardian_id, secret_hash) WHERE kind = 'guardian';

CREATE TABLE magic_links (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  guardian_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  scope text NOT NULL CHECK (scope IN ('order', 'documents')),
  service_date date,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  FOREIGN KEY (school_id, guardian_id) REFERENCES guardians (school_id, id)
);

CREATE TABLE otp_challenges (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  subject_kind text NOT NULL CHECK (subject_kind IN ('guardian', 'staff')),
  subject_id uuid NOT NULL,
  code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['devices', 'magic_links', 'otp_challenges']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (school_id = app_school_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user', t);
  END LOOP;
END $$;

-- Únicas consultas sem tenant desta fase (spec 4.4). Devolvem o mínimo para abrir o withTenant.
CREATE FUNCTION resolve_magic_link(p_token_hash text)
RETURNS TABLE (school_id uuid, magic_link_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT m.school_id, m.id FROM magic_links m WHERE m.token_hash = p_token_hash $$;

CREATE FUNCTION resolve_staff_email(p_email text)
RETURNS TABLE (school_id uuid, staff_user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT s.school_id, s.id FROM staff_users s WHERE s.email = lower(p_email) AND s.active $$;

REVOKE ALL ON FUNCTION resolve_magic_link(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_staff_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_magic_link(text) TO app_user;
GRANT EXECUTE ON FUNCTION resolve_staff_email(text) TO app_user;
