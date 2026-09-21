"""Atomic numeric progress for bounded CPU continuations; never source text."""
import json
import os
from pathlib import Path


def save_progress(file, *, total, cached, computed, status):
    if not file:
        return
    if any(type(n) is not int or n < 0 for n in (total, cached, computed)) \
            or cached + computed > total:
        raise ValueError("cloud_sync_progress_counts_invalid")
    if status not in {"running", "paused_time", "complete"}:
        raise ValueError("cloud_sync_progress_status_invalid")
    record = {"schemaVersion": 1, "status": status, "totalRows": total,
              "cachedRows": cached, "computedRows": computed,
              "remainingRows": total - cached - computed}
    destination = Path(file)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".tmp")
    temporary.write_text(json.dumps(record, separators=(",", ":")), encoding="utf-8")
    os.replace(temporary, destination)
