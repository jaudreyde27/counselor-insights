-- 0001_init: tables, constraints and indexes (SPEC.md section 4).
-- Row-level security is added in 0002_rls.sql.
-- Standard Postgres only. UUID primary keys. All timestamps are timestamptz.

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

CREATE TABLE counselors (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cognito_sub   text NOT NULL UNIQUE,
  email         text NOT NULL,
  display_name  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE students (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  counselor_id       uuid NOT NULL REFERENCES counselors(id) ON DELETE CASCADE,
  full_name          text NOT NULL,
  school             text NOT NULL,
  graduation_year    integer NOT NULL,
  country_of_origin  text NOT NULL,
  notes              text NOT NULL DEFAULT '',
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX students_counselor_idx ON students(counselor_id);

CREATE TABLE sessions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id                uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  counselor_id              uuid NOT NULL REFERENCES counselors(id) ON DELETE CASCADE,
  session_date              date NOT NULL,
  status                    text NOT NULL DEFAULT 'created'
    CHECK (status IN ('created','awaiting_upload','uploaded','transcribing',
                      'transcribed','analyzing','complete','failed')),
  source                    text NOT NULL CHECK (source IN ('audio','pasted')),
  audio_s3_key              text,
  assemblyai_transcript_id  text,
  student_speaker_label     text,
  consent_confirmed_at      timestamptz,
  notes                     text NOT NULL DEFAULT '',
  error_message             text,
  current_analysis_run_id   uuid,  -- FK added below, after analysis_runs exists
  created_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_student_idx ON sessions(student_id);
CREATE INDEX sessions_counselor_idx ON sessions(counselor_id);

CREATE TABLE utterances (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  idx             integer NOT NULL,
  speaker         text NOT NULL CHECK (speaker IN ('counselor','student')),
  raw_speaker_label text,
  start_ms        integer,
  end_ms          integer,
  text            text NOT NULL,
  UNIQUE (session_id, idx)
);

CREATE TABLE analysis_runs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id           uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  model_id             text NOT NULL,
  prompt_version       text NOT NULL,
  criteria_version     text NOT NULL,
  status               text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','complete','failed')),
  dropped_quote_count  integer NOT NULL DEFAULT 0,
  crisis_flag          boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX analysis_runs_session_idx ON analysis_runs(session_id);

ALTER TABLE sessions
  ADD CONSTRAINT sessions_current_run_fk
  FOREIGN KEY (current_analysis_run_id) REFERENCES analysis_runs(id) ON DELETE SET NULL;

CREATE TABLE themes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_run_id  uuid NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  session_id       uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sub_driver_id    text NOT NULL,   -- from config/criteria.json, or 'other'
  domain_id        text NOT NULL,   -- copied from the config when saved
  other_label      text,
  title            text NOT NULL,
  interpretation   text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX themes_run_idx ON themes(analysis_run_id);
CREATE INDEX themes_session_idx ON themes(session_id);

CREATE TABLE theme_evidence (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  theme_id      uuid NOT NULL REFERENCES themes(id) ON DELETE CASCADE,
  utterance_id  uuid NOT NULL REFERENCES utterances(id) ON DELETE CASCADE,
  quote         text NOT NULL
);
CREATE INDEX theme_evidence_theme_idx ON theme_evidence(theme_id);

CREATE TABLE crisis_evidence (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_run_id  uuid NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  utterance_id     uuid NOT NULL REFERENCES utterances(id) ON DELETE CASCADE,
  quote            text NOT NULL
);
CREATE INDEX crisis_evidence_run_idx ON crisis_evidence(analysis_run_id);

CREATE TABLE recommendations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_run_id     uuid NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  session_id          uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  topic               text NOT NULL,
  open_question       text NOT NULL,
  suggested_approach  text NOT NULL,
  based_on_theme_ids  uuid[] NOT NULL DEFAULT '{}'
);
CREATE INDEX recommendations_run_idx ON recommendations(analysis_run_id);

-- Audit rows outlive the things they describe, so student/session links are
-- cleared (not cascaded) when those rows are deleted. Student names never go
-- in `action`.
CREATE TABLE audit_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  counselor_id  uuid NOT NULL REFERENCES counselors(id) ON DELETE CASCADE,
  student_id    uuid REFERENCES students(id) ON DELETE SET NULL,
  session_id    uuid REFERENCES sessions(id) ON DELETE SET NULL,
  action        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_counselor_idx ON audit_events(counselor_id);
