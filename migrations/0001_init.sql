-- ============================================================
--  FAMILY MEDICAL RECORDS  —  Cloudflare D1 schema  v1
--  Applied automatically by the Deploy to Cloudflare button.
-- ============================================================

PRAGMA foreign_keys = ON;

-- ---------- 1. WHO CAN GET IN -------------------------------
-- Access already proved the email. This table decides what they see.
CREATE TABLE IF NOT EXISTS app_users (
  email           TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL DEFAULT '',
  role            TEXT NOT NULL DEFAULT 'viewer',   -- owner | member | viewer
  scope_person_id TEXT,                             -- NULL = all people
  expires_at      TEXT,                             -- NULL = no expiry (ISO date)
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at    TEXT
);

-- ---------- 2. THE PEOPLE -----------------------------------
CREATE TABLE IF NOT EXISTS people (
  person_id    TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  active       INTEGER NOT NULL DEFAULT 1,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS profiles (
  person_id          TEXT PRIMARY KEY REFERENCES people(person_id) ON DELETE CASCADE,
  date_of_birth      TEXT,
  blood_group        TEXT,
  allergies          TEXT,
  chronic_conditions TEXT,
  regular_doctors    TEXT,
  emergency_contact  TEXT,
  insurance          TEXT,
  notes              TEXT,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- 3. CARE EVENTS (an illness / admission / episode)
CREATE TABLE IF NOT EXISTS care_events (
  care_event_id TEXT PRIMARY KEY,
  person_id     TEXT NOT NULL REFERENCES people(person_id) ON DELETE CASCADE,
  event_date    TEXT NOT NULL,
  event_type    TEXT NOT NULL DEFAULT 'Other',
  title         TEXT NOT NULL,
  facility      TEXT,
  notes         TEXT,
  deleted       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_care_person_date ON care_events(person_id, event_date DESC);

-- ---------- 4. RECORDS (one visit / one report) -------------
CREATE TABLE IF NOT EXISTS records (
  record_id       TEXT PRIMARY KEY,
  person_id       TEXT NOT NULL REFERENCES people(person_id) ON DELETE CASCADE,
  care_event_id   TEXT REFERENCES care_events(care_event_id) ON DELETE SET NULL,
  event_date      TEXT NOT NULL,
  record_type     TEXT NOT NULL DEFAULT 'Other',
  doctor          TEXT,
  speciality      TEXT,
  facility        TEXT,
  reason          TEXT,
  summary         TEXT,
  key_diagnosis   TEXT,
  key_findings    TEXT,
  deleted         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_rec_person_date ON records(person_id, event_date DESC) WHERE deleted = 0;
CREATE INDEX IF NOT EXISTS ix_rec_care        ON records(care_event_id);

-- ---------- 5. DOCUMENTS (the actual scans) -----------------
CREATE TABLE IF NOT EXISTS documents (
  document_id     TEXT PRIMARY KEY,
  record_id       TEXT REFERENCES records(record_id) ON DELETE CASCADE,
  person_id       TEXT NOT NULL REFERENCES people(person_id) ON DELETE CASCADE,
  document_date   TEXT,
  document_type   TEXT,
  category        TEXT,
  provider        TEXT,
  file_name       TEXT NOT NULL,
  drive_file_id   TEXT NOT NULL,          -- file ID in your Google Drive
  drive_url       TEXT,
  mime_type       TEXT,
  bytes           INTEGER,
  content_sha256  TEXT,                   -- duplicate detection
  duplicate_of    TEXT,
  summary         TEXT,
  deleted         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_doc_person ON documents(person_id, document_date DESC) WHERE deleted = 0;
CREATE UNIQUE INDEX IF NOT EXISTS ux_doc_hash ON documents(content_sha256) WHERE content_sha256 IS NOT NULL AND deleted = 0;

-- ---------- 6. TEST RESULTS (the analytics goldmine) --------
CREATE TABLE IF NOT EXISTS test_results (
  result_id           TEXT PRIMARY KEY,
  record_id           TEXT REFERENCES records(record_id) ON DELETE CASCADE,
  person_id           TEXT NOT NULL REFERENCES people(person_id) ON DELETE CASCADE,
  test_date           TEXT NOT NULL,
  panel               TEXT,
  parameter_raw       TEXT NOT NULL,      -- exactly as printed on the report
  parameter           TEXT NOT NULL,      -- canonical name
  result_text         TEXT,               -- exactly as printed, e.g. "120/80"
  value_a             REAL,               -- numeric, in canonical unit
  value_b             REAL,               -- second number (diastolic BP)
  unit_raw            TEXT,
  unit                TEXT,               -- canonical unit
  ref_range_text      TEXT,
  ref_low             REAL,
  ref_high            REAL,
  flag                TEXT,
  is_abnormal         INTEGER NOT NULL DEFAULT 0,
  lab                 TEXT,
  entry_source        TEXT NOT NULL DEFAULT 'ai',   -- ai | manual | correction
  notes               TEXT,
  deleted             INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_test_trend    ON test_results(person_id, parameter, test_date) WHERE deleted = 0;
CREATE INDEX IF NOT EXISTS ix_test_abnormal ON test_results(person_id, is_abnormal, test_date DESC) WHERE deleted = 0;
CREATE INDEX IF NOT EXISTS ix_test_record   ON test_results(record_id);

-- ---------- 7. MEDICINES ------------------------------------
CREATE TABLE IF NOT EXISTS medicines (
  medicine_id   TEXT PRIMARY KEY,
  record_id     TEXT REFERENCES records(record_id) ON DELETE CASCADE,
  person_id     TEXT NOT NULL REFERENCES people(person_id) ON DELETE CASCADE,
  prescribed_on TEXT NOT NULL,
  name          TEXT NOT NULL,
  composition   TEXT,
  strength      TEXT,
  form          TEXT,
  dose          TEXT,
  frequency     TEXT,
  route         TEXT,
  duration_text TEXT,
  instructions  TEXT,
  start_date    TEXT,
  end_date      TEXT,          -- computed on write from duration if absent
  status        TEXT NOT NULL DEFAULT 'unknown',  -- active | stopped | completed | unknown
  deleted       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_med_person ON medicines(person_id, status, prescribed_on DESC) WHERE deleted = 0;

-- ---------- 8. DIAGNOSES, FOLLOW-UPS, BILLS -----------------
CREATE TABLE IF NOT EXISTS diagnoses (
  diagnosis_id TEXT PRIMARY KEY,
  record_id    TEXT REFERENCES records(record_id) ON DELETE CASCADE,
  person_id    TEXT NOT NULL REFERENCES people(person_id) ON DELETE CASCADE,
  noted_on     TEXT NOT NULL,
  diagnosis    TEXT NOT NULL,
  status       TEXT,
  notes        TEXT,
  deleted      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_dx_person ON diagnoses(person_id, noted_on DESC) WHERE deleted = 0;

CREATE TABLE IF NOT EXISTS follow_ups (
  follow_up_id TEXT PRIMARY KEY,
  record_id    TEXT REFERENCES records(record_id) ON DELETE CASCADE,
  person_id    TEXT NOT NULL REFERENCES people(person_id) ON DELETE CASCADE,
  due_date     TEXT,
  type         TEXT,
  instruction  TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | completed | dismissed
  deleted      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_fu_open ON follow_ups(person_id, status, due_date) WHERE deleted = 0;

CREATE TABLE IF NOT EXISTS bills (
  bill_id        TEXT PRIMARY KEY,
  record_id      TEXT REFERENCES records(record_id) ON DELETE CASCADE,
  person_id      TEXT NOT NULL REFERENCES people(person_id) ON DELETE CASCADE,
  bill_date      TEXT NOT NULL,
  bill_type      TEXT,
  vendor         TEXT,
  invoice_number TEXT,
  item           TEXT,
  medicine_name  TEXT,
  quantity       TEXT,
  batch_number   TEXT,
  expiry_date    TEXT,
  line_amount    REAL,
  bill_total     REAL,
  payment_status TEXT,
  notes          TEXT,
  deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_bill_person ON bills(person_id, bill_date DESC) WHERE deleted = 0;

-- ---------- 9. THE NAME-STANDARDISING BRAIN -----------------
-- Ported straight from your v4 SEED_ALIASES / SEED_CONVERSIONS.
CREATE TABLE IF NOT EXISTS parameter_aliases (
  alias_key   TEXT PRIMARY KEY,           -- normalised, e.g. 'hba1c'
  original    TEXT NOT NULL,
  parameter   TEXT NOT NULL,              -- canonical name
  unit        TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT 'seed',  -- seed | gemini | manual
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_alias_param ON parameter_aliases(parameter);

CREATE TABLE IF NOT EXISTS unit_conversions (
  parameter     TEXT NOT NULL,
  from_unit_key TEXT NOT NULL,
  to_unit       TEXT NOT NULL,
  multiply_by   REAL NOT NULL DEFAULT 1,
  add_offset    REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (parameter, from_unit_key)
);

-- Healthy adult reference bands, used when a lab prints no range.
CREATE TABLE IF NOT EXISTS reference_bands (
  parameter TEXT NOT NULL,
  sex       TEXT NOT NULL DEFAULT 'any',  -- any | m | f
  age_min   INTEGER NOT NULL DEFAULT 0,
  age_max   INTEGER NOT NULL DEFAULT 200,
  low       REAL,
  high      REAL,
  unit      TEXT,
  PRIMARY KEY (parameter, sex, age_min, age_max)
);

-- ---------- 10. THE UPLOAD PIPELINE -------------------------
CREATE TABLE IF NOT EXISTS jobs (
  job_id       TEXT PRIMARY KEY,
  person_id    TEXT NOT NULL REFERENCES people(person_id) ON DELETE CASCADE,
  care_event_id TEXT,
  user_date    TEXT,
  status       TEXT NOT NULL DEFAULT 'draft',
     -- draft | uploading | queued | reading | review | approved | rejected | error
  message      TEXT,
  extraction   TEXT,                      -- JSON blob from Gemini
  created_by   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_job_status ON jobs(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS job_files (
  job_file_id  TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
  file_index   INTEGER NOT NULL DEFAULT 1,
  file_name    TEXT NOT NULL,
  mime_type    TEXT,
  bytes        INTEGER,
  drive_file_id TEXT NOT NULL,
  content_sha256 TEXT,
  duplicate_of TEXT,
  ai_status    TEXT NOT NULL DEFAULT 'waiting',  -- waiting | reading | done | error
  ai_json      TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_jobfile_job ON job_files(job_id, file_index);

-- ---------- 11. SHARING & AUDIT -----------------------------
CREATE TABLE IF NOT EXISTS shares (
  share_id     TEXT PRIMARY KEY,          -- random, appears in the URL
  person_id    TEXT NOT NULL REFERENCES people(person_id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'handout',
  drive_file_id TEXT NOT NULL,
  created_by   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT NOT NULL,
  max_views    INTEGER NOT NULL DEFAULT 0,   -- 0 = unlimited until expiry
  views        INTEGER NOT NULL DEFAULT 0,
  revoked      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_share_expiry ON shares(expires_at) WHERE revoked = 0;

CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL DEFAULT (datetime('now')),
  actor     TEXT,
  action    TEXT NOT NULL,
  ref_id    TEXT,
  detail    TEXT
);
CREATE INDEX IF NOT EXISTS ix_audit_at ON audit_log(at DESC);

CREATE TABLE IF NOT EXISTS corrections (
  correction_id TEXT PRIMARY KEY,
  at            TEXT NOT NULL DEFAULT (datetime('now')),
  actor         TEXT,
  person_id     TEXT,
  table_name    TEXT NOT NULL,
  row_id        TEXT NOT NULL,
  before_json   TEXT,
  after_json    TEXT,
  reason        TEXT NOT NULL
);

-- ---------- 12. SHEET MIRROR BOOKKEEPING --------------------
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
INSERT OR IGNORE INTO settings(key,value) VALUES
  ('schema_version','1'),
  ('sheet_last_sync',''),
  ('data_version','0'),
  ('drive_root_folder_id',''),   -- created on first run
  ('mirror_sheet_id',''),        -- the readable Google Sheet
  ('google_connected','0');

-- ============================================================
--  VIEWS — these are what make the app feel instant.
--  In Sheets these were whole rebuilt tabs. Here they cost nothing.
-- ============================================================

-- Everything for one person on one timeline, ready to page through.
CREATE VIEW IF NOT EXISTS v_timeline AS
  SELECT person_id, 'record'   AS kind, record_id AS ref_id, event_date AS date,
         record_type AS title, summary AS value,
         TRIM(COALESCE(doctor,'')||' '||COALESCE(facility,'')) AS detail,
         '' AS flag, care_event_id
    FROM records WHERE deleted = 0
  UNION ALL
  SELECT person_id, 'test', result_id, test_date, parameter,
         COALESCE(result_text,'')||' '||COALESCE(unit_raw,''),
         COALESCE(panel,'')||' '||COALESCE(lab,''), COALESCE(flag,''), NULL
    FROM test_results WHERE deleted = 0
  UNION ALL
  SELECT person_id, 'medicine', medicine_id, prescribed_on,
         name||' '||COALESCE(strength,''),
         COALESCE(dose,'')||' '||COALESCE(frequency,''),
         COALESCE(instructions,''), status, NULL
    FROM medicines WHERE deleted = 0
  UNION ALL
  SELECT person_id, 'diagnosis', diagnosis_id, noted_on, diagnosis,
         COALESCE(status,''), COALESCE(notes,''), '', NULL
    FROM diagnoses WHERE deleted = 0
  UNION ALL
  SELECT person_id, 'document', document_id, document_date,
         COALESCE(document_type,'Document'), COALESCE(summary,''),
         COALESCE(provider,''), '', NULL
    FROM documents WHERE deleted = 0
  UNION ALL
  SELECT person_id, 'bill', bill_id, bill_date,
         COALESCE(medicine_name, item, bill_type, 'Bill'),
         CAST(COALESCE(bill_total, line_amount, 0) AS TEXT),
         COALESCE(vendor,''), COALESCE(payment_status,''), NULL
    FROM bills WHERE deleted = 0;

-- The latest value of every test, with the previous one for direction.
CREATE VIEW IF NOT EXISTS v_latest_tests AS
  SELECT t.person_id, t.parameter, t.unit,
         t.test_date, t.result_text, t.value_a, t.ref_low, t.ref_high,
         t.flag, t.is_abnormal, t.lab,
         LAG(t.value_a)   OVER w AS prev_value,
         LAG(t.test_date) OVER w AS prev_date,
         ROW_NUMBER()     OVER (PARTITION BY t.person_id, t.parameter
                                ORDER BY t.test_date DESC) AS rn
    FROM test_results t
   WHERE t.deleted = 0
  WINDOW w AS (PARTITION BY t.person_id, t.parameter ORDER BY t.test_date);

-- Medicines that are genuinely current (no 90-day guessing).
CREATE VIEW IF NOT EXISTS v_active_medicines AS
  SELECT * FROM medicines
   WHERE deleted = 0
     AND status <> 'stopped' AND status <> 'completed'
     AND (end_date IS NULL OR end_date >= date('now'));

CREATE VIEW IF NOT EXISTS v_open_follow_ups AS
  SELECT * FROM follow_ups
   WHERE deleted = 0 AND status = 'pending';
