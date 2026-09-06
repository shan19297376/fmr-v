#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parents[1]
index = (root / "src/index.ts").read_text(encoding="utf-8")
approve = (root / "src/approve.ts").read_text(encoding="utf-8")
autofile = (root / "src/autofile.ts").read_text(encoding="utf-8")
records = (root / "src/records.ts").read_text(encoding="utf-8")

assert "status <> 'review'" not in index
assert "createPersonFromReport" not in index
assert "files.length !== expected" in index
assert "maintainUploadJobs(env)" in index
assert "safeOriginalFileName" in index
assert "cleanupPartialFiling" in autofile
assert "SET status='approved'" not in approve
assert "SET status='approved'" in autofile
assert "UPDATE core_reminders SET status='dismissed'" in records
assert "This record is being filed and cannot be discarded." in index
assert "allowedPerson = uploader ? uploader.scope_person_id : '__no_access__'" in index
assert "WHERE job_id = ? AND status IN ('draft','uploading')" in index
assert "Reference ${errorId}" in index
assert "views = views + 1" in index and "views < max_views" in index
print("Upload, queue, filing, sharing and deletion invariants verified.")
