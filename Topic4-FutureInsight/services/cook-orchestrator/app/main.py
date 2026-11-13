"""Cook Orchestrator Engine — an OGC API - Processes - Part 1: Core service
that exposes exactly one process, "cook": given a recipe id and parameters, it
fetches that recipe's execution DAG from the Cookbook API Registry, executes
each step against its OGC API Processes tool service in order, and pipes
outputs into subsequent inputs (see app/engine.py).

Conformance classes implemented (OGC API - Processes - Part 1: Core, v1.0 —
see DECISIONS.md, D6, for why v1.0
rather than the v2.0 draft conformance URIs):
  - ogcapi-processes-1/1.0/conf/core
  - ogcapi-processes-1/1.0/conf/json
  - ogcapi-processes-1/1.0/conf/oas30
  - ogcapi-processes-1/1.0/conf/job-list
  - ogcapi-processes-1/1.0/conf/dismiss

Endpoints:
  GET  /                                landing page
  GET  /conformance                     declared conformance classes
  GET  /processes                       process list (one: "cook")
  GET  /processes/cook                  process description
  POST /processes/cook/execution        execute (sync by default; `Prefer:
                                         respond-async` for the async path)
  GET  /jobs                            list jobs
  GET  /jobs/{jobId}                    job status
  GET  /jobs/{jobId}/results            job results (once successful)
  DELETE /jobs/{jobId}                  dismiss a job
"""

from __future__ import annotations

import threading
from http import HTTPStatus
from typing import Optional

from fastapi import FastAPI, HTTPException, Header, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from pydantic import BaseModel, Field

from . import engine, jobs

SERVICE_TITLE = "nLDT Sandbox Stack — Cook Orchestrator Engine"
SERVICE_DESCRIPTION = (
    "Executes registered nLDT recipes by walking their CWL-derived execution "
    "DAG and calling each step's OGC API Processes tool service in order."
)

CONFORMANCE_CLASSES = [
    "http://www.opengis.net/spec/ogcapi-processes-1/1.0/conf/core",
    "http://www.opengis.net/spec/ogcapi-processes-1/1.0/conf/json",
    "http://www.opengis.net/spec/ogcapi-processes-1/1.0/conf/oas30",
    "http://www.opengis.net/spec/ogcapi-processes-1/1.0/conf/job-list",
    "http://www.opengis.net/spec/ogcapi-processes-1/1.0/conf/dismiss",
]

COOK_PROCESS = {
    "id": "cook",
    "title": "Cook — Recipe Orchestrator",
    "description": (
        "Executes a registered nLDT recipe: fetches its execution DAG from the "
        "Cookbook API Registry, calls each step's OGC API Process tool service "
        "in order, and pipes outputs into subsequent inputs."
    ),
    "version": "1.0.0",
    "jobControlOptions": ["sync-execute", "async-execute", "dismiss"],
    "outputTransmission": ["value"],
    "inputs": {
        "recipeId": {
            "title": "Recipe identifier",
            "description": "The id of a recipe registered in the Cookbook API Registry.",
            "schema": {"type": "string"},
        },
        "parameters": {
            "title": "Recipe parameters",
            "description": "Values for the recipe's top-level workflow inputs.",
            "schema": {"type": "object"},
        },
        "toolOverrides": {
            "title": "Per-run tool overrides",
            "description": (
                "Optional stepId -> tool id map, for a custom configuration for this run only — "
                "the recipe's own stored CWL is never modified."
            ),
            "schema": {"type": "object"},
        },
    },
    "outputs": {
        "result": {
            "title": "Recipe result",
            "description": "The recipe's declared workflow outputs, by output id.",
            "schema": {"type": "object"},
        }
    },
}

app = FastAPI(title=SERVICE_TITLE, description=SERVICE_DESCRIPTION, version="0.1.0")

# The UI (served from a different origin/port, possibly file://) needs to call
# these services directly from the browser. No auth/credentials are in play in
# this sandbox, so an open CORS policy is the pragmatic, documented choice —
# see DECISIONS.md, D11.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# OGC API - Processes - Part 1 exceptions: a JSON body with a `type` URI
# (OGC's own for the cases the standard names: no-such-process, no-such-job,
# result-not-ready), plus title, status and detail, instead of FastAPI's
# default {"detail": ...}. `detail` keeps its name, so the UI, which reads it,
# is unaffected.
OGC_EXCEPTIONS = "http://www.opengis.net/def/exceptions/ogcapi-processes-1/1.0/"


def _exception(status: int, detail, path: str = "", type_: str | None = None) -> JSONResponse:
    if type_ is None:
        if status == 404 and "/jobs/" in path:
            type_ = OGC_EXCEPTIONS + "no-such-job"
        elif status == 404 and "/processes/" in path:  # path may carry the gateway prefix (--root-path)
            type_ = OGC_EXCEPTIONS + "no-such-process"
        else:
            type_ = "about:blank"
    return JSONResponse(
        {"type": type_, "title": HTTPStatus(status).phrase, "status": status, "detail": detail},
        status_code=status,
    )


@app.exception_handler(StarletteHTTPException)
async def _http_exception(request: Request, exc: StarletteHTTPException):
    return _exception(exc.status_code, exc.detail, request.url.path)


@app.exception_handler(RequestValidationError)
async def _validation_exception(request: Request, exc: RequestValidationError):
    return _exception(400, "Invalid request: " + "; ".join(e.get("msg", "") for e in exc.errors()), request.url.path)


class ExecuteRequest(BaseModel):
    inputs: dict = Field(default_factory=dict)


def _url(request: Request, path: str) -> str:
    return f"{str(request.base_url).rstrip('/')}{path}"


@app.get("/")
def landing_page(request: Request):
    return {
        "title": SERVICE_TITLE,
        "description": SERVICE_DESCRIPTION,
        "links": [
            {"rel": "self", "type": "application/json", "href": _url(request, "/")},
            {"rel": "conformance", "type": "application/json", "href": _url(request, "/conformance")},
            {"rel": "processes", "type": "application/json", "href": _url(request, "/processes")},
            {"rel": "http://www.opengis.net/def/rel/ogc/1.0/job-list", "type": "application/json", "href": _url(request, "/jobs")},
            {"rel": "service-desc", "type": "application/vnd.oai.openapi+json;version=3.0", "href": _url(request, "/openapi.json")},
            {"rel": "service-doc", "type": "text/html", "href": _url(request, "/docs")},
        ],
    }


@app.get("/conformance")
def conformance():
    return {"conformsTo": CONFORMANCE_CLASSES}


@app.get("/processes")
def list_processes(request: Request):
    return {
        "processes": [
            {
                "id": COOK_PROCESS["id"],
                "title": COOK_PROCESS["title"],
                "version": COOK_PROCESS["version"],
                "jobControlOptions": COOK_PROCESS["jobControlOptions"],
                "links": [{"rel": "self", "type": "application/json", "href": _url(request, "/processes/cook")}],
            }
        ],
        "links": [{"rel": "self", "type": "application/json", "href": _url(request, "/processes")}],
    }


@app.get("/processes/cook")
def get_process(request: Request):
    return {
        **COOK_PROCESS,
        "links": [
            {"rel": "self", "type": "application/json", "href": _url(request, "/processes/cook")},
            {"rel": "execute", "type": "application/json", "href": _url(request, "/processes/cook/execution")},
        ],
    }


def _job_progress(steps: list[dict]) -> tuple[int | None, str | None]:
    """OGC statusInfo's `progress` (0-100) and a one-line `message`, derived
    from the engine's per-step progress: finished steps count fully, the
    running one by its remote job's own progress, if it reports any."""
    if not steps:
        return None, None
    done = sum(1 for s in steps if s["status"] == "successful")
    # Several steps can be active at once (independent steps run in parallel).
    active = [i for i, s in enumerate(steps) if s["status"] not in ("pending", "successful")]
    partial = sum(
        min(max(steps[i]["remoteProgress"], 0), 100) / 100
        for i in active
        if isinstance(steps[i].get("remoteProgress"), (int, float))
    )
    progress = round(100 * (done + partial) / len(steps))
    if not active:
        return progress, f"{done} of {len(steps)} steps done"
    if len(active) == 1:
        step = steps[active[0]]
        return progress, f"Step {active[0] + 1} of {len(steps)}: {step['label']} — {step['status']}"
    names = ", ".join(steps[i]["label"] for i in active)
    return progress, f"{len(active)} steps running ({done} of {len(steps)} done): {names}"


def _job_status_body(job: dict, request: Request) -> dict:
    progress, message = _job_progress(job.get("steps") or [])
    body = {
        "jobID": job["jobID"],
        "processID": job["processID"],
        "type": job["type"],
        "status": job["status"],
        "created": job["created"],
        "started": job.get("started"),
        "updated": job["updated"],
        "recipeId": job.get("recipe_id"),
        # Beyond OGC's statusInfo: the full per-step breakdown (see
        # engine._Run), so a caller can show every step, not just a percentage.
        "steps": job.get("steps") or [],
    }
    if progress is not None:
        body["progress"] = progress
    if job["status"] == "failed":
        body["message"] = job["error"]
        # Beyond OGC's statusInfo: whether the failure is the Cook's own, the
        # Cookbook Registry's, or a step's tool's — see engine.ExecutionError.
        body["errorSource"] = job.get("error_source") or {"source": "cook"}
    elif job["status"] == "dismissed":
        body["message"] = "Cancelled"
    elif message:
        body["message"] = message
    job_url = _url(request, f"/jobs/{job['jobID']}")
    body["links"] = [
        {"rel": "self", "type": "application/json", "href": job_url},
        {"rel": "monitor", "type": "application/json", "href": job_url},
    ]
    if job["status"] == "successful":
        body["links"].append(
            {"rel": "http://www.opengis.net/def/rel/ogc/1.0/results", "type": "application/json", "href": f"{job_url}/results"}
        )
    # OGC's statusInfo schema has no nulls (e.g. `started` before a job starts):
    # a field without a value is left out.
    return {key: value for key, value in body.items() if value is not None}


@app.post("/processes/cook/execution")
def execute_cook(
    payload: ExecuteRequest,
    request: Request,
    response: Response,
    prefer: Optional[str] = Header(default=None),
):
    recipe_id = payload.inputs.get("recipeId")
    parameters = payload.inputs.get("parameters") or {}
    tool_overrides = payload.inputs.get("toolOverrides") or {}
    if not recipe_id:
        raise HTTPException(status_code=400, detail="inputs.recipeId is required")

    async_requested = bool(prefer and "respond-async" in prefer)

    if async_requested:
        job = jobs.create_job(recipe_id, parameters, tool_overrides)
        threading.Thread(target=jobs.run_job, args=(job["jobID"],), daemon=True).start()
        response.status_code = 201
        response.headers["Location"] = _url(request, f"/jobs/{job['jobID']}")
        response.headers["Preference-Applied"] = "respond-async"
        return _job_status_body(job, request)

    try:
        outcome = engine.execute_recipe(recipe_id, parameters, tool_overrides)
    except engine.ExecutionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"result": outcome["outputs"], "trace": outcome["trace"]}


@app.get("/jobs")
def list_jobs(request: Request):
    return {
        "jobs": [_job_status_body(j, request) for j in jobs.list_jobs()],
        "links": [{"rel": "self", "type": "application/json", "href": _url(request, "/jobs")}],
    }


@app.get("/jobs/{job_id}")
def get_job(job_id: str, request: Request):
    job = jobs.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found")
    return _job_status_body(job, request)


@app.get("/jobs/{job_id}/results")
def get_job_results(job_id: str, request: Request):
    job = jobs.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found")
    # As OGC API Processes 1.0 asks: a job that hasn't finished has no results
    # yet (404, result-not-ready); a failed job answers with its own error.
    if job["status"] == "failed":
        return _exception(500, job.get("error") or f"Job '{job_id}' failed", request.url.path)
    if job["status"] != "successful":
        return _exception(
            404,
            f"Job '{job_id}' has no results yet (status: {job['status']})",
            request.url.path,
            OGC_EXCEPTIONS + "result-not-ready",
        )
    return {"result": job["result"]["outputs"], "trace": job["result"]["trace"]}


@app.delete("/jobs/{job_id}", status_code=200)
def dismiss_job(job_id: str, request: Request):
    if not jobs.dismiss_job(job_id):
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found")
    return _job_status_body(jobs.get_job(job_id), request)
