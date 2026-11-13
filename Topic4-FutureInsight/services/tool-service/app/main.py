"""A minimal OGC API - Processes - Part 1: Core tool service.

The apps a recipe calls are the one place in the Sandbox Stack deliberately
kept simple (DECISIONS.md, D1). One codebase serves whichever operation
("add", "multiply", or "multiply3") a given container is configured for —
selected entirely by its environment variables (PROCESS_ID, PROCESS_TITLE,
OPERATION), set per-service in docker-compose.yml. Adding another tool means
one more compose block (and, if it's a new kind of computation, one more
entry in OPERATIONS below) — not a new service.

Only synchronous execution is implemented — legitimate under OGC API Processes
Part 1: Core (the "sync-execute" job control option), and appropriate for a
computation that finishes in microseconds. Job management is the Cook
Orchestrator's job for slower, chained work; these leaf tools don't need it.

Endpoints:
  GET  /                                landing page
  GET  /conformance
  GET  /processes                       list (one entry: this instance's PROCESS_ID)
  GET  /processes/{processId}           process description
  POST /processes/{processId}/execution synchronous execution -> {"outputs": {...}}
  GET  /jobs                            always an empty job list (no async jobs)
"""

from __future__ import annotations

import os

from http import HTTPStatus

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

OPERATIONS = {
    "add": {
        "inputs": ["a", "b"],
        "output": "sum",
        "compute": lambda v: v["a"] + v["b"],
    },
    "multiply": {
        "inputs": ["x", "y"],
        "output": "product",
        "compute": lambda v: v["x"] * v["y"],
    },
    "multiply3": {
        "inputs": ["x", "y", "z"],
        "output": "product",
        "compute": lambda v: v["x"] * v["y"] * v["z"],
    },
}

PROCESS_ID = os.environ["PROCESS_ID"]
PROCESS_TITLE = os.getenv("PROCESS_TITLE", PROCESS_ID)
OPERATION = os.environ["OPERATION"]

if OPERATION not in OPERATIONS:
    raise RuntimeError(f"Unknown OPERATION '{OPERATION}' — must be one of {list(OPERATIONS)}")

_OP = OPERATIONS[OPERATION]
CONFORMANCE_CLASSES = [
    "http://www.opengis.net/spec/ogcapi-processes-1/1.0/conf/core",
    "http://www.opengis.net/spec/ogcapi-processes-1/1.0/conf/json",
    "http://www.opengis.net/spec/ogcapi-processes-1/1.0/conf/oas30",
]

app = FastAPI(title=f"nLDT Sandbox Stack — Tool Service ({PROCESS_TITLE})", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# OGC API - Processes - Part 1 exceptions: a JSON body with a `type` URI
# (OGC's own for the cases the standard names, e.g. no-such-process), plus
# title, status and detail, instead of FastAPI's default {"detail": ...}.
# `detail` keeps its name, so clients that read it are unaffected.
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


def _process_description() -> dict:
    return {
        "id": PROCESS_ID,
        "title": PROCESS_TITLE,
        "version": "1.0.0",
        "jobControlOptions": ["sync-execute"],
        "outputTransmission": ["value"],
        "inputs": {name: {"title": name, "schema": {"type": "number"}} for name in _OP["inputs"]},
        "outputs": {_OP["output"]: {"title": _OP["output"], "schema": {"type": "number"}}},
    }


@app.get("/")
def landing_page(request: Request):
    return {
        "title": app.title,
        "links": [
            {"rel": "self", "type": "application/json", "href": _url(request, "/")},
            {"rel": "conformance", "type": "application/json", "href": _url(request, "/conformance")},
            {"rel": "processes", "type": "application/json", "href": _url(request, "/processes")},
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
                "id": PROCESS_ID,
                "title": PROCESS_TITLE,
                "version": "1.0.0",
                "jobControlOptions": ["sync-execute"],
                "outputTransmission": ["value"],
                "links": [{"rel": "self", "type": "application/json", "href": _url(request, f"/processes/{PROCESS_ID}")}],
            }
        ],
        "links": [{"rel": "self", "type": "application/json", "href": _url(request, "/processes")}],
    }


@app.get("/jobs")
def list_jobs(request: Request):
    # Execution here is synchronous only, so there are never jobs to list. The
    # endpoint still answers with a valid, empty job list (as OGC API Processes
    # clients and OGC's test suite expect) rather than a 404.
    return {"jobs": [], "links": [{"rel": "self", "type": "application/json", "href": _url(request, "/jobs")}]}


@app.get("/processes/{process_id}")
def get_process(process_id: str):
    if process_id != PROCESS_ID:
        raise HTTPException(status_code=404, detail=f"Unknown process '{process_id}'")
    return _process_description()


@app.post("/processes/{process_id}/execution")
def execute(process_id: str, payload: ExecuteRequest):
    if process_id != PROCESS_ID:
        raise HTTPException(status_code=404, detail=f"Unknown process '{process_id}'")

    values = {}
    for name in _OP["inputs"]:
        if name not in payload.inputs:
            raise HTTPException(status_code=400, detail=f"Missing required input '{name}'")
        try:
            values[name] = float(payload.inputs[name])
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail=f"Input '{name}' must be a number") from None

    try:
        result = _OP["compute"](values)
    except ZeroDivisionError:
        raise HTTPException(status_code=400, detail="Division by zero") from None
    return {"outputs": {_OP["output"]: result}}
