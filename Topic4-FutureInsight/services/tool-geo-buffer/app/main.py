"""A minimal OGC API - Processes - Part 1: Core tool service: buffers a
GeoJSON geometry by a distance in meters.

Same "deliberately simple leaf tool" allowance as ../tool-service (see
DECISIONS.md, D1) — but a standalone codebase rather than one more
operation in tool-service's OPERATIONS dict, because that service's contract
is hard-coded numeric ("type": "number", float(...) coercion throughout) and
this one's inputs/outputs are GeoJSON geometries, not scalars.

Only synchronous execution is implemented — legitimate under OGC API
Processes Part 1: Core, and appropriate for a computation this fast.

`geometry` is a data input: it may be given by value (a GeoJSON geometry,
Feature or FeatureCollection, or an OGC qualified value `{"value": ...,
"mediaType": ...}`) or — how the Cook Orchestrator sends a recipe's data
ingredient — by reference, `{"href": "<URL>", "type": "application/geo+json"}`,
in which case this service fetches the GeoJSON itself.

Endpoints:
  GET  /                                landing page
  GET  /conformance
  GET  /processes                       list (one entry: buffer-geometry)
  GET  /processes/{processId}           process description
  POST /processes/{processId}/execution synchronous execution -> {"outputs": {...}}
  GET  /jobs                            always an empty job list (no async jobs)
"""

from __future__ import annotations

import json
import os

import httpx
from http import HTTPStatus

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from pyproj import Transformer
from shapely.geometry import mapping, shape
from shapely.ops import transform, unary_union

PROCESS_ID = "buffer-geometry"
PROCESS_TITLE = "Buffer a geometry"

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

# The input geometry (and the recipe's Rotterdam boundary ingredient it's fed
# from — see ../hub-datasets) is WGS84 (EPSG:4326) GeoJSON, but a buffer
# distance only means "meters" in a projected CRS — buffering directly in
# degrees would be wrong by roughly a factor of 100,000. RD New (EPSG:28992,
# the Dutch national grid, appropriate for a Rotterdam-local computation) is
# used only as scratch space for the buffer operation itself.
_TO_RD = Transformer.from_crs("EPSG:4326", "EPSG:28992", always_xy=True).transform
_TO_WGS84 = Transformer.from_crs("EPSG:28992", "EPSG:4326", always_xy=True).transform


# How long fetching a by-reference geometry may take (the PDOK-backed
# Rotterdam boundary in ../hub-datasets is fetched live and can take ~15s).
FETCH_TIMEOUT = float(os.getenv("GEOMETRY_FETCH_TIMEOUT", "60.0"))


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
        "inputs": {
            "geometry": {
                "title": "Input geometry (GeoJSON)",
                "description": (
                    "A WGS84 GeoJSON geometry, Feature or FeatureCollection — by value, "
                    "or by reference as {\"href\": <URL>, \"type\": \"application/geo+json\"}, "
                    "which this service fetches."
                ),
                "schema": {"type": "object", "contentMediaType": "application/geo+json"},
            },
            "distance": {"title": "Buffer distance (meters)", "schema": {"type": "number"}},
        },
        "outputs": {"bufferedGeometry": {"title": "Buffered geometry (GeoJSON Feature)", "schema": {"type": "object"}}},
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


def _fetch_reference(href: str) -> object:
    """Fetches a by-reference input's GeoJSON. Unwraps a `{"content": ...}`
    envelope, as ../hub-datasets' older /content endpoint returns."""
    try:
        resp = httpx.get(
            href,
            timeout=FETCH_TIMEOUT,
            follow_redirects=True,
            headers={"Accept": "application/geo+json, application/json"},
        )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=400, detail=f"Input 'geometry': could not fetch {href}: {exc}") from None
    if resp.status_code >= 400:
        raise HTTPException(
            status_code=400, detail=f"Input 'geometry': {href} responded with HTTP {resp.status_code}"
        )
    try:
        body = resp.json()
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Input 'geometry': {href} did not return JSON") from None
    if isinstance(body, dict) and set(body) == {"content"}:
        body = body["content"]
    return body


def _input_value(value, name: str):
    """An input's actual value, whichever way OGC API Processes allows it to
    be given: by reference ({"href": ...}, fetched), as a qualified value
    ({"value": ..., "mediaType": ...}), or plain."""
    if isinstance(value, dict) and isinstance(value.get("href"), str):
        return _fetch_reference(value["href"])
    if isinstance(value, dict) and "value" in value and set(value) <= {"value", "mediaType", "encoding", "schema", "format"}:
        inner = value["value"]
        if isinstance(inner, str) and name == "geometry":
            try:
                return json.loads(inner)
            except ValueError:
                raise HTTPException(status_code=400, detail="Input 'geometry' value is not GeoJSON") from None
        return inner
    return value


def _to_shape(value):
    """A shapely geometry from a GeoJSON geometry, Feature, or
    FeatureCollection (its features' geometries merged)."""
    if not isinstance(value, dict):
        raise HTTPException(status_code=400, detail="Input 'geometry' must be a GeoJSON object")
    kind = value.get("type")
    try:
        if kind == "FeatureCollection":
            geoms = [shape(f["geometry"]) for f in value.get("features") or [] if isinstance(f, dict) and f.get("geometry")]
            if not geoms:
                raise HTTPException(status_code=400, detail="Input 'geometry' FeatureCollection has no geometries")
            return unary_union(geoms)
        if kind == "Feature":
            geom = value.get("geometry")
            if not isinstance(geom, dict):
                raise HTTPException(status_code=400, detail="Input 'geometry' Feature has no geometry")
            return shape(geom)
        return shape(value)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 — shapely raises several unrelated types (incl. GeometryTypeError)
        raise HTTPException(status_code=400, detail=f"Input 'geometry' is not a valid GeoJSON geometry: {exc}") from None


@app.post("/processes/{process_id}/execution")
def execute(process_id: str, payload: ExecuteRequest):
    if process_id != PROCESS_ID:
        raise HTTPException(status_code=404, detail=f"Unknown process '{process_id}'")

    if "geometry" not in payload.inputs:
        raise HTTPException(status_code=400, detail="Missing required input 'geometry'")
    if "distance" not in payload.inputs:
        raise HTTPException(status_code=400, detail="Missing required input 'distance'")

    try:
        distance = float(_input_value(payload.inputs["distance"], "distance"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Input 'distance' must be a number") from None
    if distance < 0:
        raise HTTPException(status_code=400, detail="Input 'distance' must not be negative")

    geom = _to_shape(_input_value(payload.inputs["geometry"], "geometry"))

    geom_rd = transform(_TO_RD, geom)
    # For an area geometry (the Rotterdam boundary polygon), buffering the
    # polygon itself just nudges the whole outline outward by `distance` —
    # barely visible without zooming in, since the interior dominates the
    # rendered shape and doesn't change. Buffering the boundary LINE instead
    # produces a ring/band whose thickness is directly `distance`, making the
    # parameter's effect obvious at a glance. Point/LineString inputs have no
    # interior to begin with, so buffering them directly already produces a
    # visible band.
    to_buffer = geom_rd.boundary if geom_rd.geom_type in ("Polygon", "MultiPolygon") else geom_rd
    buffered_rd = to_buffer.buffer(distance)
    buffered_wgs84 = transform(_TO_WGS84, buffered_rd)

    feature = {
        "type": "Feature",
        "geometry": mapping(buffered_wgs84),
        "properties": {"buffer_distance_m": distance},
    }
    return {"outputs": {"bufferedGeometry": feature}}
