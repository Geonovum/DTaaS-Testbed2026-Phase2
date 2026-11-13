"""In-memory job store for asynchronous 'cook' executions.

Deliberately not persistent (see DECISIONS.md, "Open items") — a
restart loses in-flight/completed job records. Acceptable for now: recipe
executions are cheap and re-runnable, and nothing downstream depends on job
history surviving a restart yet.
"""

from __future__ import annotations

import datetime
import threading
import uuid

from . import engine

_LOCK = threading.Lock()
_JOBS: dict[str, dict] = {}
# One cancel flag per job, set by dismiss_job and watched by the engine
# while it runs (see engine.execute_recipe's `cancel`).
_CANCEL: dict[str, threading.Event] = {}


def _now() -> str:
    return datetime.datetime.utcnow().isoformat() + "Z"


def create_job(recipe_id: str, parameters: dict, tool_overrides: dict | None = None) -> dict:
    job = {
        "jobID": str(uuid.uuid4()),
        "processID": "cook",
        "type": "process",
        "status": "accepted",
        "created": _now(),
        "updated": _now(),
        "recipe_id": recipe_id,
        "parameters": parameters,
        "tool_overrides": tool_overrides or {},
        "result": None,
        "error": None,
        # Where a failure came from — engine.ExecutionError.origin().
        "error_source": None,
        # Per-step progress as reported by the engine (see engine._Run):
        # [{id, label, processId, status, remoteStatus, remoteProgress, message}].
        "steps": [],
        "started": None,
    }
    with _LOCK:
        _JOBS[job["jobID"]] = job
        _CANCEL[job["jobID"]] = threading.Event()
    return dict(job)


def get_job(job_id: str) -> dict | None:
    with _LOCK:
        job = _JOBS.get(job_id)
        return dict(job) if job else None


def list_jobs() -> list[dict]:
    with _LOCK:
        return [dict(j) for j in _JOBS.values()]


def run_job(job_id: str) -> None:
    """Executed on a background thread — see app/main.py."""
    with _LOCK:
        job = _JOBS.get(job_id)
        if not job or job["status"] == "dismissed":
            return
        job["status"] = "running"
        job["started"] = job["updated"] = _now()
        cancel = _CANCEL[job_id]

    def on_progress(steps: list[dict]) -> None:
        with _LOCK:
            live = _JOBS.get(job_id)
            if live:
                live["steps"] = steps
                live["updated"] = _now()

    try:
        outcome = engine.execute_recipe(
            job["recipe_id"], job["parameters"], job.get("tool_overrides"), cancel=cancel, on_progress=on_progress
        )
    except Exception as exc:  # noqa: BLE001 — anything uncaught would leave the job "running" forever
        with _LOCK:
            job = _JOBS.get(job_id)
            if job and job["status"] != "dismissed":
                job["status"] = "failed"
                if isinstance(exc, engine.ExecutionError):
                    job["error"], job["error_source"] = str(exc), exc.origin()
                else:
                    job["error"], job["error_source"] = f"{type(exc).__name__}: {exc}", {"source": "cook"}
                job["updated"] = _now()
        return

    with _LOCK:
        job = _JOBS.get(job_id)
        if job and job["status"] != "dismissed":
            job["status"] = "successful"
            job["result"] = outcome
            job["updated"] = _now()


def dismiss_job(job_id: str) -> bool:
    """Stops a queued or running job: marks it dismissed and signals the
    engine, which stops at its next check — between steps, or within one
    poll interval while waiting on a step's remote job, which it then
    dismisses on the remote server too."""
    with _LOCK:
        job = _JOBS.get(job_id)
        if not job:
            return False
        if job["status"] in ("accepted", "running"):
            job["status"] = "dismissed"
            job["updated"] = _now()
            _CANCEL[job_id].set()
        return True
