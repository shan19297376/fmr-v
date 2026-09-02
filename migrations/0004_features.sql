-- Carrying over the remaining v4 capabilities.

-- Historical scans stay in Google Drive; only new ones go to R2. Storing the
-- old link means the import does not have to move thousands of files.
ALTER TABLE documents ADD COLUMN legacy_url TEXT;
ALTER TABLE records   ADD COLUMN legacy_url TEXT;

-- v4 let you enter a home BP or sugar reading with no document attached.
ALTER TABLE test_results ADD COLUMN context TEXT;

-- Which upload a record came from, so a filed record can be traced back.
ALTER TABLE records ADD COLUMN job_id TEXT;

-- Duplicate decisions, ported from the v4 Duplicate Review tab.
CREATE TABLE IF NOT EXISTS duplicate_review (
  review_id     TEXT PRIMARY KEY,
  person_id     TEXT NOT NULL REFERENCES people(person_id) ON DELETE CASCADE,
  duplicate_id  TEXT NOT NULL,
  canonical_id  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',   -- open | kept | deleted
  detected_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_dup_open ON duplicate_review(person_id, status);

CREATE INDEX IF NOT EXISTS ix_tl_deleted ON timeline(ref_id, deleted);

INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version','4');
