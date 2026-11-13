"""OGC API - Records - Part 1: Core, implemented for the nLDT Sandbox Stack.

Conformance classes implemented:
  - ogcapi-common-1 / core
  - ogcapi-common-2 / json
  - ogcapi-records-1 / core
  - ogcapi-records-1 / json

Endpoints:
  GET  /                                          landing page
  GET  /conformance                               declared conformance classes
  GET  /collections                               list of collections (here: one — "recipes")
  GET  /collections/{collectionId}                a single collection's description
  GET  /collections/{collectionId}/items          search/list records (q, limit, offset)
  GET  /collections/{collectionId}/items/{id}     a single record
  POST /collections/{collectionId}/items          register/replace a record  (*)
  DELETE /collections/{collectionId}/items/{id}   remove a record            (*)

(*) Part 1: Core is a read/discovery spec and does not itself define a write
    interface. These two endpoints are a documented, pragmatic extension used by the
    Cookbook API Registry to publish catalog entries — see DECISIONS.md.
"""

from __future__ import annotations

import os
import pathlib
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import models
from .repository import CKANError, RecordRepository

CKAN_URL = os.getenv("CKAN_URL", "http://ckan:5000")
CKAN_ORGANIZATION = os.getenv("CKAN_ORGANIZATION", "recipes")
CKAN_API_TOKEN_FILE = os.getenv("CKAN_API_TOKEN_FILE", "/secrets/ckan_api_token.txt")

SERVICE_TITLE = "nLDT Sandbox Stack — OGC API Records Wrapper"
SERVICE_DESCRIPTION = (
    "Catalog and discovery service for registered nLDT recipes. Implements "
    "OGC API - Records - Part 1: Core."
)

CONFORMANCE_CLASSES = [
    "http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/core",
    "http://www.opengis.net/spec/ogcapi-common-2/1.0/conf/json",
    "http://www.opengis.net/spec/ogcapi-records-1/1.0/conf/core",
    "http://www.opengis.net/spec/ogcapi-records-1/1.0/conf/json",
]

DEFAULT_COLLECTION_ID = "recipes"

app = FastAPI(title=SERVICE_TITLE, description=SERVICE_DESCRIPTION, version="0.1.0")

# The browser-based UI calls this service directly from whatever origin it's
# served from (including file://) — no auth/credentials are in play in this
# sandbox, so an open CORS policy is the pragmatic, documented choice. See
# DECISIONS.md, D11.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(CKANError)
async def ckan_error_handler(request: Request, exc: CKANError):
    return JSONResponse(status_code=502, content={"detail": f"CKAN backend error: {exc}"})


# The CKAN API token can only be created once CKAN itself is up and
# bootstrapped (see scripts/bootstrap_ckan.py and DECISIONS.md, D14) —
# so this is read lazily and cached, rather than at import time, and every
# CKAN-touching endpoint reports 503 (not a crash) until it's found.
_repository: Optional[RecordRepository] = None


def get_repository() -> RecordRepository:
    global _repository
    if _repository is None:
        token_path = pathlib.Path(CKAN_API_TOKEN_FILE)
        if not token_path.exists():
            raise HTTPException(
                status_code=503,
                detail=(
                    "CKAN API token not found yet — run "
                    "services/records-wrapper/scripts/bootstrap_ckan.py once "
                    "after `docker compose up`, then retry."
                ),
            )
        token = token_path.read_text(encoding="utf-8").strip()
        _repository = RecordRepository(CKAN_URL, token, CKAN_ORGANIZATION)
    return _repository


class RecordIn(BaseModel):
    id: str = Field(..., description="Stable identifier, e.g. 'recipe-add-multiply-demo'")
    title: str
    description: Optional[str] = None
    keywords: list[str] = Field(default_factory=list)
    type: str = Field(default="recipe")
    cookbook_url: Optional[str] = Field(
        default=None,
        description="URL of the raw recipe payload (a CWL document) served by the Cookbook API Registry.",
    )
    cwl_media_type: str = Field(default="application/cwl+yaml")


def _url(request: Request, path: str) -> str:
    return f"{str(request.base_url).rstrip('/')}{path}"


def record_to_feature(request: Request, record: models.RecordModel) -> dict:
    item_href = _url(request, f"/collections/{record.collection_id}/items/{record.id}")
    links = [
        {"rel": "self", "type": "application/json", "href": item_href},
        {
            "rel": "collection",
            "type": "application/json",
            "href": _url(request, f"/collections/{record.collection_id}"),
        },
    ]
    if record.cookbook_url:
        links.append(
            {
                "rel": "http://www.opengis.net/def/rel/ogc/1.0/recipe-source",
                "type": record.cwl_media_type or "application/cwl+yaml",
                "href": record.cookbook_url,
                "title": "Raw recipe definition (Cookbook API Registry)",
            }
        )
    return {
        "type": "Feature",
        "id": record.id,
        "conformsTo": ["http://www.opengis.net/spec/ogcapi-records-1/1.0/req/record-core"],
        "geometry": None,
        "properties": {
            "type": record.type,
            "title": record.title,
            "description": record.description,
            "keywords": record.keywords or [],
            "created": record.created.isoformat() + "Z" if record.created else None,
            "updated": record.updated.isoformat() + "Z" if record.updated else None,
        },
        "links": links,
    }


@app.get("/")
def landing_page(request: Request):
    return {
        "title": SERVICE_TITLE,
        "description": SERVICE_DESCRIPTION,
        "links": [
            {"rel": "self", "type": "application/json", "href": _url(request, "/")},
            {"rel": "conformance", "type": "application/json", "href": _url(request, "/conformance")},
            {"rel": "data", "type": "application/json", "href": _url(request, "/collections")},
            {"rel": "service-desc", "type": "application/json", "href": _url(request, "/openapi.json")},
        ],
    }


@app.get("/conformance")
def conformance():
    return {"conformsTo": CONFORMANCE_CLASSES}


def _collection_description(request: Request, collection_id: str) -> dict:
    return {
        "id": collection_id,
        "title": "Recipes",
        "description": "Registered nLDT recipes — executable, vendor-agnostic workflow blueprints.",
        "itemType": "record",
        "links": [
            {
                "rel": "self",
                "type": "application/json",
                "href": _url(request, f"/collections/{collection_id}"),
            },
            {
                "rel": "items",
                "type": "application/geo+json",
                "href": _url(request, f"/collections/{collection_id}/items"),
            },
        ],
    }


@app.get("/collections")
def list_collections(request: Request):
    return {
        "collections": [_collection_description(request, DEFAULT_COLLECTION_ID)],
        "links": [{"rel": "self", "type": "application/json", "href": _url(request, "/collections")}],
    }


@app.get("/collections/{collection_id}")
def get_collection(collection_id: str, request: Request):
    _require_known_collection(collection_id)
    return _collection_description(request, collection_id)


def _require_known_collection(collection_id: str) -> None:
    if collection_id != DEFAULT_COLLECTION_ID:
        raise HTTPException(status_code=404, detail=f"Unknown collection '{collection_id}'")


@app.get("/collections/{collection_id}/items")
def list_items(
    collection_id: str,
    request: Request,
    q: Optional[str] = Query(default=None, description="Free-text search across title/description"),
    limit: int = Query(default=10, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    repo: RecordRepository = Depends(get_repository),
):
    _require_known_collection(collection_id)
    items, total = repo.list(collection_id, q=q, limit=limit, offset=offset)
    return {
        "type": "FeatureCollection",
        "numberMatched": total,
        "numberReturned": len(items),
        "links": [
            {
                "rel": "self",
                "type": "application/geo+json",
                "href": _url(request, f"/collections/{collection_id}/items"),
            }
        ],
        "features": [record_to_feature(request, r) for r in items],
    }


@app.get("/collections/{collection_id}/items/{record_id}")
def get_item(
    collection_id: str, record_id: str, request: Request, repo: RecordRepository = Depends(get_repository)
):
    _require_known_collection(collection_id)
    record = repo.get(collection_id, record_id)
    if not record:
        raise HTTPException(status_code=404, detail=f"Record '{record_id}' not found in collection '{collection_id}'")
    return record_to_feature(request, record)


@app.post("/collections/{collection_id}/items", status_code=201)
def upsert_item(
    collection_id: str, payload: RecordIn, request: Request, repo: RecordRepository = Depends(get_repository)
):
    _require_known_collection(collection_id)
    # created/updated are not set here: CKAN owns metadata_created/
    # metadata_modified, and repo.upsert() returns the record with them.
    record = models.RecordModel(
        id=payload.id,
        collection_id=collection_id,
        type=payload.type,
        title=payload.title,
        description=payload.description,
        keywords=payload.keywords,
        cookbook_url=payload.cookbook_url,
        cwl_media_type=payload.cwl_media_type,
    )
    saved = repo.upsert(record)
    return record_to_feature(request, saved)


@app.delete("/collections/{collection_id}/items/{record_id}", status_code=204)
def delete_item(collection_id: str, record_id: str, repo: RecordRepository = Depends(get_repository)):
    _require_known_collection(collection_id)
    if not repo.delete(collection_id, record_id):
        raise HTTPException(status_code=404, detail=f"Record '{record_id}' not found")
    return None
