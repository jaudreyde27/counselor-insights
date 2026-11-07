-- 0008_webhook_lookup: the transcription webhook is called by AssemblyAI, not by a signed-in
-- counselor, so it has no counselor to run as. It only knows a transcript id. This one narrow
-- function (like find_or_create_counselor) finds which session and counselor that id belongs to,
-- so the app can then do the rest as that counselor with row-level security applied.
CREATE INDEX IF NOT EXISTS sessions_transcript_idx ON sessions(assemblyai_transcript_id);

CREATE FUNCTION find_session_for_transcript(p_transcript_id text)
RETURNS TABLE (o_session_id uuid, o_counselor_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
    SELECT s.id, s.counselor_id FROM sessions s
     WHERE s.assemblyai_transcript_id = p_transcript_id
     LIMIT 1;
END $$;
REVOKE ALL ON FUNCTION find_session_for_transcript(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION find_session_for_transcript(text) TO app_user;
