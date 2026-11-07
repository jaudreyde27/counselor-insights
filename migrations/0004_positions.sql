-- 0004_positions: keep the order the analysis produced.
-- Recommendations are "the most important ones" first (SPEC.md 6.4), so their order
-- matters. Rows written in one transaction share a timestamp and have random uuids,
-- so without an explicit position the order would be arbitrary.
ALTER TABLE themes          ADD COLUMN position integer NOT NULL DEFAULT 0;
ALTER TABLE recommendations ADD COLUMN position integer NOT NULL DEFAULT 0;
