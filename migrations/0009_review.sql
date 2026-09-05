-- Uploads: remembering whether you chose the person, and letting a document be
-- completed by hand when the reader gets nothing off the page.

-- Your explicit choice wins over anything read off the document. Recording that
-- it WAS explicit is what lets the app tell the difference between "you said
-- Vishal" and "it guessed Vishal".
ALTER TABLE core_jobs ADD COLUMN person_explicit INTEGER NOT NULL DEFAULT 0;

-- What a person typed in, for a document the reader could not handle.
ALTER TABLE core_jobs ADD COLUMN manual INTEGER NOT NULL DEFAULT 0;

-- Handwritten and poor scans are expected, so review is a permanent feature and
-- not an error path. This flag drives the badge on the Review tab.
ALTER TABLE core_jobs ADD COLUMN needs_attention INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS ix_job_attention ON core_jobs(needs_attention, updated_at DESC);

INSERT OR REPLACE INTO core_settings (key, value) VALUES ('schema_version','9');
