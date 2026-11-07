-- 0003_run_changes: keep call 2's "changes since earlier sessions" notes with the run.
-- Not in the SPEC.md section 4 table list, but section 6.4 and 7.5 show these notes
-- on the recommendation cards, so they have to be saved somewhere to survive a reload.
ALTER TABLE analysis_runs
  ADD COLUMN changes_since_earlier_sessions text[] NOT NULL DEFAULT '{}';
