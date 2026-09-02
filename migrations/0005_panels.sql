-- Test panels, so results group the way a lab report does rather than
-- alphabetically. Anything unmatched falls into 'Other tests', and the app
-- lets you re-file it by hand.

CREATE TABLE IF NOT EXISTS test_categories (
  parameter TEXT PRIMARY KEY,
  category  TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Haemoglobin', 'Haematology & Coagulation', 1);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Total WBC Count', 'Haematology & Coagulation', 2);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Platelet Count', 'Haematology & Coagulation', 3);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('RBC Count', 'Haematology & Coagulation', 4);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Haematocrit (PCV)', 'Haematology & Coagulation', 5);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('MCV', 'Haematology & Coagulation', 6);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('MCH', 'Haematology & Coagulation', 7);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('MCHC', 'Haematology & Coagulation', 8);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('RDW', 'Haematology & Coagulation', 9);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('ESR', 'Haematology & Coagulation', 10);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Neutrophils %', 'Haematology & Coagulation', 11);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Lymphocytes %', 'Haematology & Coagulation', 12);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Eosinophils %', 'Haematology & Coagulation', 13);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Monocytes %', 'Haematology & Coagulation', 14);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Basophils %', 'Haematology & Coagulation', 15);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Absolute Neutrophil Count', 'Haematology & Coagulation', 16);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Absolute Lymphocyte Count', 'Haematology & Coagulation', 17);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('D-Dimer', 'Haematology & Coagulation', 18);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Fasting Blood Sugar', 'Clinical Chemistry', 19);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Post Meal Blood Sugar', 'Clinical Chemistry', 20);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Random Blood Sugar', 'Clinical Chemistry', 21);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('HbA1c', 'Clinical Chemistry', 22);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Estimated Average Glucose', 'Clinical Chemistry', 23);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Fasting Insulin', 'Clinical Chemistry', 24);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Total Cholesterol', 'Clinical Chemistry', 25);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('HDL Cholesterol', 'Clinical Chemistry', 26);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('LDL Cholesterol', 'Clinical Chemistry', 27);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('VLDL Cholesterol', 'Clinical Chemistry', 28);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Triglycerides', 'Clinical Chemistry', 29);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Non-HDL Cholesterol', 'Clinical Chemistry', 30);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Cholesterol / HDL Ratio', 'Clinical Chemistry', 31);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Urea', 'Clinical Chemistry', 32);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Blood Urea Nitrogen', 'Clinical Chemistry', 33);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Creatinine', 'Clinical Chemistry', 34);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('eGFR', 'Clinical Chemistry', 35);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Uric Acid', 'Clinical Chemistry', 36);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Sodium', 'Clinical Chemistry', 37);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Potassium', 'Clinical Chemistry', 38);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Chloride', 'Clinical Chemistry', 39);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Calcium', 'Clinical Chemistry', 40);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Phosphorus', 'Clinical Chemistry', 41);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Magnesium', 'Clinical Chemistry', 42);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Total Bilirubin', 'Clinical Chemistry', 43);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Direct Bilirubin', 'Clinical Chemistry', 44);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Indirect Bilirubin', 'Clinical Chemistry', 45);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('ALT (SGPT)', 'Clinical Chemistry', 46);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('AST (SGOT)', 'Clinical Chemistry', 47);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Alkaline Phosphatase', 'Clinical Chemistry', 48);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('GGT', 'Clinical Chemistry', 49);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Total Protein', 'Clinical Chemistry', 50);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Albumin', 'Clinical Chemistry', 51);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Globulin', 'Clinical Chemistry', 52);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('A/G Ratio', 'Clinical Chemistry', 53);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Serum Iron', 'Clinical Chemistry', 54);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('TIBC', 'Clinical Chemistry', 55);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Transferrin Saturation', 'Clinical Chemistry', 56);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Ferritin', 'Clinical Chemistry', 57);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('TSH', 'Immunology & Serology', 58);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Free T3', 'Immunology & Serology', 59);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Free T4', 'Immunology & Serology', 60);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Total T3', 'Immunology & Serology', 61);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Total T4', 'Immunology & Serology', 62);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Anti-TPO Antibody', 'Immunology & Serology', 63);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('CRP', 'Immunology & Serology', 64);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('hs-CRP', 'Immunology & Serology', 65);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('PSA', 'Immunology & Serology', 66);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Testosterone', 'Immunology & Serology', 67);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Cortisol', 'Immunology & Serology', 68);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Prolactin', 'Immunology & Serology', 69);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Vitamin D', 'Immunology & Serology', 70);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Vitamin B12', 'Immunology & Serology', 71);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Folate', 'Immunology & Serology', 72);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Procalcitonin', 'Microbiology & Infectious Diseases', 73);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Urine Protein', 'Urinalysis & Body Fluids', 74);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Urine Sugar', 'Urinalysis & Body Fluids', 75);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Urine pH', 'Urinalysis & Body Fluids', 76);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Urine Specific Gravity', 'Urinalysis & Body Fluids', 77);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Urine Pus Cells', 'Urinalysis & Body Fluids', 78);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Blood Pressure', 'Vitals & Measurements', 79);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Pulse', 'Vitals & Measurements', 80);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('SpO2', 'Vitals & Measurements', 81);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Temperature', 'Vitals & Measurements', 82);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Weight', 'Vitals & Measurements', 83);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Height', 'Vitals & Measurements', 84);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('BMI', 'Vitals & Measurements', 85);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Respiratory Rate', 'Vitals & Measurements', 86);
INSERT OR IGNORE INTO test_categories (parameter, category, sort_order) VALUES ('Waist Circumference', 'Vitals & Measurements', 87);

CREATE INDEX IF NOT EXISTS ix_cat ON test_categories(category, sort_order);

-- Uploads no longer need the person chosen up front: the reader works out who
-- the report belongs to from the name printed on it. Jobs are transient, so the
-- table is simply rebuilt rather than migrated.
DROP TABLE IF EXISTS jobs_old;
ALTER TABLE jobs RENAME TO jobs_old;

CREATE TABLE jobs (
  job_id        TEXT PRIMARY KEY,
  person_id     TEXT REFERENCES people(person_id) ON DELETE CASCADE,
  detected_name TEXT,
  care_event_id TEXT,
  user_date     TEXT,
  status        TEXT NOT NULL DEFAULT 'draft',
  message       TEXT,
  extraction    TEXT,
  created_by    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO jobs (job_id, person_id, care_event_id, user_date, status, message, extraction, created_by, created_at, updated_at)
  SELECT job_id, person_id, care_event_id, user_date, status, message, extraction, created_by, created_at, updated_at FROM jobs_old;
DROP TABLE jobs_old;
CREATE INDEX IF NOT EXISTS ix_job_status ON jobs(status, updated_at DESC);

INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version','5');
