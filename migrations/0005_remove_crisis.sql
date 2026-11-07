-- 0005_remove_crisis: the tool no longer has any crisis-language feature.
-- Removes the crisis evidence table (and its row-level-security policy) and the
-- per-run crisis flag. This changes SPEC.md section 4, 6.2, 6.3 and 6.6.
DROP TABLE IF EXISTS crisis_evidence;
ALTER TABLE analysis_runs DROP COLUMN IF EXISTS crisis_flag;
