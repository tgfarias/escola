-- F5: documentos — dados pessoais confirmados pela escola (spec 8.1), modelos, lotes, documentos e aberturas (spec 8, 9).

ALTER TABLE students ADD COLUMN birth_date date;
ALTER TABLE guardians
  ADD COLUMN full_name text CHECK (length(full_name) BETWEEN 1 AND 200),
  ADD COLUMN cpf text CHECK (cpf ~ '^[0-9]{11}$');

CREATE TABLE document_templates (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  template_group_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  category text NOT NULL CHECK (category IN ('declaracao', 'comunicado', 'autorizacao', 'outro')),
  body_md text NOT NULL CHECK (length(body_md) BETWEEN 1 AND 20000),
  fields jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(fields) = 'array' AND jsonb_array_length(fields) <= 10),
  created_by uuid NOT NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  CONSTRAINT document_templates_version UNIQUE (school_id, template_group_id, version),
  FOREIGN KEY (school_id, created_by) REFERENCES staff_users (school_id, id)
);

CREATE TABLE document_batches (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  template_id uuid NOT NULL,
  field_values jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(field_values) = 'object'),
  issued_on date NOT NULL,
  per_guardian boolean NOT NULL,
  created_by uuid NOT NULL,
  status text NOT NULL DEFAULT 'rendering' CHECK (status IN ('rendering', 'ready', 'published')),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  FOREIGN KEY (school_id, template_id) REFERENCES document_templates (school_id, id),
  FOREIGN KEY (school_id, created_by) REFERENCES staff_users (school_id, id),
  CHECK ((status = 'published') = (published_at IS NOT NULL))
);

CREATE TABLE documents (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  batch_id uuid NOT NULL,
  student_id uuid NOT NULL,
  guardian_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'rendering', 'rendered', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  lease_until timestamptz,
  storage_path text,
  sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  rendered_at timestamptz,
  discarded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  CONSTRAINT documents_one_per_recipient UNIQUE NULLS NOT DISTINCT (school_id, batch_id, student_id, guardian_id),
  FOREIGN KEY (school_id, batch_id) REFERENCES document_batches (school_id, id),
  FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id),
  FOREIGN KEY (school_id, guardian_id) REFERENCES guardians (school_id, id),
  CHECK ((status = 'rendered') = (storage_path IS NOT NULL AND sha256 IS NOT NULL AND rendered_at IS NOT NULL)),
  CHECK ((status = 'rendering') = (lease_until IS NOT NULL)),
  CHECK (discarded_at IS NULL OR status = 'failed')
);

CREATE INDEX documents_batch_status ON documents (school_id, batch_id, status);

CREATE TABLE document_views (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  document_id uuid NOT NULL,
  guardian_id uuid NOT NULL,
  first_viewed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  CONSTRAINT document_views_once UNIQUE (school_id, document_id, guardian_id),
  FOREIGN KEY (school_id, document_id) REFERENCES documents (school_id, id),
  FOREIGN KEY (school_id, guardian_id) REFERENCES guardians (school_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['document_templates', 'document_batches', 'documents', 'document_views']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (school_id = app_school_id())', t);
  END LOOP;
END $$;

-- Nada é apagado: modelo arquiva, documento falho é descartado, abertura só é registrada.
GRANT SELECT, INSERT, UPDATE ON document_templates, document_batches, documents TO app_user;
GRANT SELECT, INSERT ON document_views TO app_user;
