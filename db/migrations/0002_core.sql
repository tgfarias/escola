CREATE TABLE classes (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, name)
);

CREATE TABLE students (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  class_id uuid NOT NULL,
  external_code text NOT NULL,
  first_name text NOT NULL,
  full_name text,
  dietary_restrictions text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, external_code),
  FOREIGN KEY (school_id, class_id) REFERENCES classes (school_id, id)
);

CREATE TABLE guardians (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  first_name text NOT NULL,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, phone_e164)
);

CREATE TABLE guardian_students (
  school_id uuid NOT NULL REFERENCES schools (id),
  guardian_id uuid NOT NULL,
  student_id uuid NOT NULL,
  restriction_consent_at timestamptz,
  PRIMARY KEY (school_id, guardian_id, student_id),
  FOREIGN KEY (school_id, guardian_id) REFERENCES guardians (school_id, id),
  FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id)
);

CREATE TABLE staff_users (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  role text NOT NULL CHECK (role IN ('admin', 'secretaria', 'cozinha')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id)
);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  actor_kind text NOT NULL CHECK (actor_kind IN ('guardian', 'staff', 'kitchen', 'system')),
  actor_id uuid,
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['classes', 'students', 'guardians', 'guardian_students', 'staff_users', 'audit_log']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (school_id = app_school_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user', t);
  END LOOP;
END $$;

REVOKE UPDATE, DELETE ON audit_log FROM app_user;
