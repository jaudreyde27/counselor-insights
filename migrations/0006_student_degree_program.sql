-- 0006_student_degree_program: replace graduation year with degree type, and add program of study.
-- (Changes the `students` columns in SPEC.md section 4.)
ALTER TABLE students
  ADD COLUMN degree_type text NOT NULL DEFAULT 'masters'
    CHECK (degree_type IN ('bachelors', 'masters')),
  ADD COLUMN program_of_study text NOT NULL DEFAULT '';
ALTER TABLE students DROP COLUMN graduation_year;
-- New rows must say what they are: no silent defaults from here on.
ALTER TABLE students ALTER COLUMN degree_type DROP DEFAULT;
ALTER TABLE students ALTER COLUMN program_of_study DROP DEFAULT;
