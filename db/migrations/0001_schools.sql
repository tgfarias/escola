-- Depois de um SET LOCAL, o parâmetro volta como string vazia na mesma sessão;
-- nullif evita o erro de cast e faz a política não casar com nenhuma linha.
CREATE FUNCTION app_school_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.school_id', true), '')::uuid $$;

CREATE TABLE schools (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
  default_cutoff_time time NOT NULL DEFAULT '07:30',
  kitchen_phone text,
  payment_account_ref text,
  payment_webhook_secret_ref text,
  platform_fee_bps integer NOT NULL DEFAULT 0 CHECK (platform_fee_bps BETWEEN 0 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE schools ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON schools USING (id = app_school_id());

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT ON schools TO app_user;
GRANT EXECUTE ON FUNCTION app_school_id() TO app_user;
