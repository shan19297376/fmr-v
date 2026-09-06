-- Reliability foundation.
-- Repairs the foreign key left pointing at jobs_old after migration 0005,
-- adds an explicit upload submission boundary, and makes one filed record per job.

CREATE TABLE core_job_files_v10 (
  job_file_id    TEXT PRIMARY KEY,
  job_id         TEXT NOT NULL REFERENCES core_jobs(job_id) ON DELETE CASCADE,
  file_index     INTEGER NOT NULL DEFAULT 1,
  file_name      TEXT NOT NULL,
  mime_type      TEXT,
  bytes          INTEGER,
  r2_key         TEXT NOT NULL,
  content_sha256 TEXT,
  duplicate_of   TEXT,
  ai_status      TEXT NOT NULL DEFAULT 'waiting',
  ai_json        TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO core_job_files_v10 (
  job_file_id, job_id, file_index, file_name, mime_type, bytes, r2_key,
  content_sha256, duplicate_of, ai_status, ai_json, attempts, last_error, created_at
)
SELECT job_file_id, job_id, file_index, file_name, mime_type, bytes, r2_key,
       content_sha256, duplicate_of, ai_status, ai_json, attempts, last_error, created_at
  FROM core_job_files;

DROP TABLE core_job_files;
ALTER TABLE core_job_files_v10 RENAME TO core_job_files;
CREATE INDEX ix_jobfile_job ON core_job_files(job_id, file_index);

ALTER TABLE core_jobs ADD COLUMN expected_files INTEGER NOT NULL DEFAULT 1;
ALTER TABLE core_jobs ADD COLUMN submitted_at TEXT;
ALTER TABLE core_jobs ADD COLUMN filing_started_at TEXT;
CREATE INDEX ix_job_creator_status ON core_jobs(created_by, status, updated_at DESC);

CREATE UNIQUE INDEX ux_health_record_job
  ON health_records(job_id) WHERE job_id IS NOT NULL;

INSERT OR REPLACE INTO core_settings (key, value) VALUES ('schema_version','10');
