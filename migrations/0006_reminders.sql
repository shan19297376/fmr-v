-- Reminders, bulk uploads and medicine management.

-- One row per thing that needs doing on a date. Follow-ups and medicines
-- generate these automatically; you can also add your own.
CREATE TABLE IF NOT EXISTS reminders (
  reminder_id TEXT PRIMARY KEY,
  person_id   TEXT NOT NULL REFERENCES people(person_id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'custom',   -- followup | medicine | test | custom
  title       TEXT NOT NULL,
  detail      TEXT,
  due_date    TEXT NOT NULL,
  repeat_days INTEGER NOT NULL DEFAULT 0,       -- 0 = one-off; 30 = monthly, etc.
  source_ref  TEXT,                             -- the follow-up or medicine it came from
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | done | dismissed
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_rem_due ON reminders(person_id, status, due_date);
-- One auto-generated reminder per source, so the nightly job cannot pile up duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS ux_rem_source ON reminders(source_ref, kind)
  WHERE source_ref IS NOT NULL;

-- Bulk upload: several reports sent together, each read separately, optionally
-- grouped into one episode of care once the reader knows who they belong to.
ALTER TABLE jobs ADD COLUMN batch_id TEXT;
ALTER TABLE jobs ADD COLUMN auto_episode INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS ix_job_batch ON jobs(batch_id);

INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version','6');
