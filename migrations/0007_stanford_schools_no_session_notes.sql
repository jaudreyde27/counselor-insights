-- 0007: put "Stanford" in front of every school name, and remove session notes.
-- (Changes the `sessions` columns in SPEC.md section 4 and the school list.)
UPDATE students SET school = CASE school
  WHEN 'School of Engineering' THEN 'Stanford School of Engineering'
  WHEN 'School of Medicine'    THEN 'Stanford School of Medicine'
  WHEN 'School of Law'         THEN 'Stanford School of Law'
  WHEN 'Undergraduate'         THEN 'Stanford Undergraduate'
  ELSE school
END;
ALTER TABLE sessions DROP COLUMN notes;
