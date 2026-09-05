-- Filing without a review step.
-- A job may be marked to file itself once the reader has finished, provided it
-- knows who it belongs to and what date it carries. Anything short of that
-- still stops for a human.

ALTER TABLE jobs ADD COLUMN auto_file INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN filed_at TEXT;
ALTER TABLE jobs ADD COLUMN record_id TEXT;

-- Episodes the app grouped by itself, so they can be shown as provisional and
-- renamed or split later.
ALTER TABLE care_events ADD COLUMN auto_created INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS ix_event_window ON care_events(person_id, event_date);

INSERT OR REPLACE INTO settings (key, value) VALUES
  ('schema_version','7'),
  ('episode_window_days','14');
