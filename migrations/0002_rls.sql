-- 0002_rls: row-level security (SPEC.md section 4).
--
-- The app connects as the non-superuser role `app_user` and, for every request,
-- sets `app.current_counselor_id` (see src/lib/db.ts). A counselor can only
-- read and write rows that belong to them. With no counselor set, no rows are
-- visible at all.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    -- No login yet. The migration runner sets the login password from the
    -- environment, so no password is ever stored in a file.
    CREATE ROLE app_user NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO app_user;

-- Current counselor for this transaction; NULL when unset.
CREATE FUNCTION app_current_counselor() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_counselor_id', true), '')::uuid
$$;
GRANT EXECUTE ON FUNCTION app_current_counselor() TO app_user;

-- Sign-in needs to find (or create) the counselor row BEFORE we know the
-- counselor's id, so this one narrow function runs with owner rights.
CREATE FUNCTION find_or_create_counselor(p_sub text, p_email text, p_name text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM counselors WHERE cognito_sub = p_sub;
  IF v_id IS NULL THEN
    INSERT INTO counselors (cognito_sub, email, display_name)
    VALUES (p_sub, p_email, p_name)
    ON CONFLICT (cognito_sub) DO UPDATE SET cognito_sub = EXCLUDED.cognito_sub
    RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION find_or_create_counselor(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION find_or_create_counselor(text, text, text) TO app_user;

-- Table privileges for the app role. (Row access is then narrowed by policies.)
GRANT SELECT, INSERT, UPDATE, DELETE ON
  students, sessions, utterances, analysis_runs, themes, theme_evidence,
  crisis_evidence, recommendations, audit_events
TO app_user;
GRANT SELECT, UPDATE ON counselors TO app_user;

ALTER TABLE counselors       ENABLE ROW LEVEL SECURITY;
ALTER TABLE students         ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE utterances       ENABLE ROW LEVEL SECURITY;
ALTER TABLE analysis_runs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE themes           ENABLE ROW LEVEL SECURITY;
ALTER TABLE theme_evidence   ENABLE ROW LEVEL SECURITY;
ALTER TABLE crisis_evidence  ENABLE ROW LEVEL SECURITY;
ALTER TABLE recommendations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events     ENABLE ROW LEVEL SECURITY;

-- Note: the policies apply to `app_user`. The database owner (used only for
-- migrations, and by find_or_create_counselor below) is deliberately not forced,
-- so that function keeps working on AWS RDS where the owner is not a superuser.

-- Tables with their own counselor_id.
CREATE POLICY counselors_own ON counselors
  FOR ALL TO app_user
  USING (id = app_current_counselor())
  WITH CHECK (id = app_current_counselor());

CREATE POLICY students_own ON students
  FOR ALL TO app_user
  USING (counselor_id = app_current_counselor())
  WITH CHECK (counselor_id = app_current_counselor());

-- A session must belong to this counselor AND point at one of their students.
CREATE POLICY sessions_own ON sessions
  FOR ALL TO app_user
  USING (counselor_id = app_current_counselor())
  WITH CHECK (
    counselor_id = app_current_counselor()
    AND student_id IN (SELECT id FROM students)
  );

CREATE POLICY audit_events_own ON audit_events
  FOR ALL TO app_user
  USING (counselor_id = app_current_counselor())
  WITH CHECK (counselor_id = app_current_counselor());

-- Tables that reach the counselor through a session. The subselects run under
-- the same policies, so they only ever see this counselor's sessions.
CREATE POLICY utterances_own ON utterances
  FOR ALL TO app_user
  USING (session_id IN (SELECT id FROM sessions))
  WITH CHECK (session_id IN (SELECT id FROM sessions));

CREATE POLICY analysis_runs_own ON analysis_runs
  FOR ALL TO app_user
  USING (session_id IN (SELECT id FROM sessions))
  WITH CHECK (session_id IN (SELECT id FROM sessions));

CREATE POLICY themes_own ON themes
  FOR ALL TO app_user
  USING (session_id IN (SELECT id FROM sessions))
  WITH CHECK (session_id IN (SELECT id FROM sessions));

CREATE POLICY recommendations_own ON recommendations
  FOR ALL TO app_user
  USING (session_id IN (SELECT id FROM sessions))
  WITH CHECK (session_id IN (SELECT id FROM sessions));

CREATE POLICY theme_evidence_own ON theme_evidence
  FOR ALL TO app_user
  USING (theme_id IN (SELECT id FROM themes))
  WITH CHECK (theme_id IN (SELECT id FROM themes));

CREATE POLICY crisis_evidence_own ON crisis_evidence
  FOR ALL TO app_user
  USING (analysis_run_id IN (SELECT id FROM analysis_runs))
  WITH CHECK (analysis_run_id IN (SELECT id FROM analysis_runs));
