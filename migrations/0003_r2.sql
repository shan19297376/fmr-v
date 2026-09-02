-- Documents move from Google Drive to Cloudflare R2.
-- Google's consent screen cannot reach production without a domain we own, and
-- an unpublished app loses its Drive authorisation every seven days. R2 removes
-- that dependency and the whole OAuth surface with it.

ALTER TABLE documents RENAME COLUMN drive_file_id TO r2_key;
ALTER TABLE documents DROP COLUMN drive_url;
ALTER TABLE job_files RENAME COLUMN drive_file_id TO r2_key;
ALTER TABLE shares    RENAME COLUMN drive_file_id TO r2_key;

DELETE FROM settings WHERE key IN ('drive_root_folder_id','google_connected')
   OR key LIKE 'drive_folder:%';

INSERT OR REPLACE INTO settings (key, value) VALUES
  ('storage_backend','r2'),
  ('schema_version','3');
