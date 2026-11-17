-- Serves the OTP issuance limits (per subject, per 15 minutes and per 24 hours).
CREATE INDEX otp_challenges_subject_recent ON otp_challenges (school_id, subject_kind, subject_id, created_at);

-- SECURITY DEFINER functions: pin pg_catalog first and pg_temp last so no object can shadow them.
ALTER FUNCTION resolve_magic_link(text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION resolve_staff_email(text) SET search_path = pg_catalog, public, pg_temp;
