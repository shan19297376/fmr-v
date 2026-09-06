#!/usr/bin/env python3
from __future__ import annotations

import sqlite3
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = sorted((ROOT / "migrations").glob("*.sql"))

with tempfile.TemporaryDirectory() as tmp:
    db_path = Path(tmp) / "fmr.sqlite"
    con = sqlite3.connect(db_path)
    con.execute("PRAGMA foreign_keys=ON")
    for migration in MIGRATIONS:
        try:
            con.executescript(migration.read_text(encoding="utf-8"))
        except Exception as exc:
            raise SystemExit(f"{migration.name} failed: {exc}") from exc

    fk = con.execute("PRAGMA foreign_key_list(core_job_files)").fetchall()
    parents = {row[2] for row in fk}
    assert "core_jobs" in parents, fk
    assert "jobs_old" not in parents, fk

    con.execute("INSERT INTO core_people(person_id,name) VALUES('p1','Test Person')")
    con.execute("INSERT INTO core_profiles(person_id) VALUES('p1')")
    con.execute(
        "INSERT INTO core_jobs(job_id,person_id,status,created_by) VALUES('j1','p1','draft','owner@example.com')"
    )
    con.execute(
        "INSERT INTO core_job_files(job_file_id,job_id,file_name,r2_key) VALUES('f1','j1','report.pdf','d/p1/f1')"
    )

    con.execute(
        "INSERT INTO core_reminders(reminder_id,person_id,kind,title,due_date,source_ref) "
        "VALUES('r1','p1','followup','Review','2026-09-10','fu1') "
        "ON CONFLICT(source_ref,kind) WHERE source_ref IS NOT NULL DO UPDATE SET due_date=excluded.due_date "
        "WHERE core_reminders.status='pending'"
    )
    con.execute(
        "INSERT INTO core_reminders(reminder_id,person_id,kind,title,due_date,source_ref) "
        "VALUES('r2','p1','followup','Review','2026-09-11','fu1') "
        "ON CONFLICT(source_ref,kind) WHERE source_ref IS NOT NULL DO UPDATE SET due_date=excluded.due_date "
        "WHERE core_reminders.status='pending'"
    )
    due = con.execute("SELECT due_date FROM core_reminders WHERE source_ref='fu1'").fetchone()[0]
    assert due == "2026-09-11", due

    columns = {row[1] for row in con.execute("PRAGMA table_info(core_jobs)").fetchall()}
    assert {"expected_files", "submitted_at", "filing_started_at"}.issubset(columns), columns

    con.execute(
        "INSERT INTO health_records(record_id,person_id,event_date,record_type,job_id) "
        "VALUES('rec1','p1','2026-09-06','Lab Test','j1')"
    )
    try:
        con.execute(
            "INSERT INTO health_records(record_id,person_id,event_date,record_type,job_id) "
            "VALUES('rec2','p1','2026-09-06','Lab Test','j1')"
        )
    except sqlite3.IntegrityError:
        pass
    else:
        raise AssertionError("A job was allowed to create two health records")

    version = con.execute("SELECT value FROM core_settings WHERE key='schema_version'").fetchone()[0]
    assert version == "10", version

print(f"Applied {len(MIGRATIONS)} migrations; foreign keys and reminder upsert verified.")
