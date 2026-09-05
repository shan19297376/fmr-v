-- The core split.
--
-- Nothing here changes behaviour. It gives every table an owner: `core_` for
-- things any future app needs (identity, people, documents, reminders, audit),
-- `health_` for things only the medical records app cares about.
--
-- Done now, while there are a few hundred rows. In a year with several apps
-- leaning on these tables it would be a weekend of careful work.

-- Views are rebuilt afterwards, so drop them before the tables move.
DROP VIEW IF EXISTS v_latest_tests;
DROP VIEW IF EXISTS v_active_medicines;
DROP VIEW IF EXISTS v_open_follow_ups;

ALTER TABLE people RENAME TO core_people;
ALTER TABLE profiles RENAME TO core_profiles;
ALTER TABLE app_users RENAME TO core_app_users;
ALTER TABLE audit_log RENAME TO core_audit_log;
ALTER TABLE settings RENAME TO core_settings;
ALTER TABLE shares RENAME TO core_shares;
ALTER TABLE jobs RENAME TO core_jobs;
ALTER TABLE job_files RENAME TO core_job_files;
ALTER TABLE documents RENAME TO core_documents;
ALTER TABLE reminders RENAME TO core_reminders;
ALTER TABLE corrections RENAME TO core_corrections;

ALTER TABLE records RENAME TO health_records;
ALTER TABLE care_events RENAME TO health_care_events;
ALTER TABLE test_results RENAME TO health_test_results;
ALTER TABLE medicines RENAME TO health_medicines;
ALTER TABLE diagnoses RENAME TO health_diagnoses;
ALTER TABLE follow_ups RENAME TO health_follow_ups;
ALTER TABLE bills RENAME TO health_bills;
ALTER TABLE timeline RENAME TO health_timeline;
ALTER TABLE parameter_aliases RENAME TO health_parameter_aliases;
ALTER TABLE unit_conversions RENAME TO health_unit_conversions;
ALTER TABLE reference_bands RENAME TO health_reference_bands;
ALTER TABLE test_categories RENAME TO health_test_categories;
ALTER TABLE duplicate_review RENAME TO health_duplicate_review;

CREATE VIEW v_latest_tests AS
  SELECT t.person_id, t.parameter, t.unit, t.test_date, t.result_text, t.value_a,
         t.ref_low, t.ref_high, t.flag, t.is_abnormal, t.lab,
         LAG(t.value_a)   OVER w AS prev_value,
         LAG(t.test_date) OVER w AS prev_date,
         ROW_NUMBER() OVER (PARTITION BY t.person_id, t.parameter ORDER BY t.test_date DESC) AS rn
    FROM health_test_results t WHERE t.deleted = 0
  WINDOW w AS (PARTITION BY t.person_id, t.parameter ORDER BY t.test_date);

CREATE VIEW v_active_medicines AS
  SELECT * FROM health_medicines
   WHERE deleted = 0 AND status <> 'stopped' AND status <> 'completed'
     AND (end_date IS NULL OR end_date >= date('now'));

CREATE VIEW v_open_follow_ups AS
  SELECT * FROM health_follow_ups WHERE deleted = 0 AND status = 'pending';

-- Which apps exist, and who may open each. One row per app per person.
CREATE TABLE IF NOT EXISTS core_apps (
  app_id     TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  tagline    TEXT,
  icon       TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO core_apps (app_id, name, tagline, icon, sort_order) VALUES
  ('health', 'Family Health Records', 'Reports, medicines, trends', 'heart', 1);

CREATE TABLE IF NOT EXISTS core_app_access (
  email  TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES core_apps(app_id) ON DELETE CASCADE,
  role   TEXT NOT NULL DEFAULT 'member',
  PRIMARY KEY (email, app_id)
);

INSERT OR REPLACE INTO core_settings (key, value) VALUES ('schema_version','8');
