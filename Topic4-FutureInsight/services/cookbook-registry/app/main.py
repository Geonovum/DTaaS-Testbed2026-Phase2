"""Cookbook API Registry — stores and serves raw recipe (CWL) payloads.

Endpoints:
  GET    /recipes                    list registered recipes (id + metadata)
  GET    /recipes/{id}               raw CWL document (application/cwl+yaml)
  GET    /recipes/{id}/original      the bundled, on-disk canonical CWL for this recipe, if any
  GET    /recipes/{id}/schema        JSON Schema for the recipe's top-level inputs
  GET    /recipes/{id}/dag           the execution graph the Cook Orchestrator walks
  POST   /recipes/{id}/effective     schema+dag for a per-run tool-substituted variant, not persisted
  POST   /recipes                    register/replace a recipe, publishes it to the catalog
  DELETE /recipes/{id}               remove a recipe, retracts it from the catalog
  GET    /processes/fetch-description  proxies GET {url} for an arbitrary OGC API Process,
                                        so the Orchestrator tab can fetch a pasted external
                                        process's description without hitting browser CORS

The schema and dag endpoints are always derived fresh from the stored CWL text
(see app/cwl_parser.py) — nothing about a recipe's shape is cached, so it can
never drift from the document that will actually be executed.
"""

from __future__ import annotations

import datetime
import os
import pathlib
from typing import Optional

import httpx
from fastapi import Depends, FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from . import cwl_parser, models, records_client
from .db import Base, engine, get_db
from .repository import RecipeRepository

Base.metadata.create_all(bind=engine)

SERVICE_TITLE = "nLDT Sandbox Stack — Cookbook API Registry"
SERVICE_DESCRIPTION = "Stores and serves raw CWL recipe definitions for the Sandbox Stack."

# The externally-reachable base URL this service advertises to the Records
# Wrapper as the home of a recipe's raw payload. Defaults to the docker-compose
# service DNS name; override for host-side testing (see README.md).
PUBLIC_BASE_URL = os.getenv("COOKBOOK_PUBLIC_URL", "http://cookbook-registry:8000")

# Where the bundled, hand-authored canonical recipes ship from (see
# recipes/add-multiply-demo.cwl) — the "factory" definition a recipe can be
# reset back to, independent of whatever is currently stored/edited in the
# database. Only recipes that shipped this way have one; a recipe registered
# purely at runtime has no such fallback (see get_recipe_original below).
BUNDLED_RECIPES_DIR = pathlib.Path(__file__).resolve().parent.parent / "recipes"

app = FastAPI(title=SERVICE_TITLE, description=SERVICE_DESCRIPTION, version="0.1.0")

# See DECISIONS.md, D11: open CORS is a deliberate, documented choice for
# this no-auth sandbox, so the browser-based UI can call this service directly.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class RecipeIn(BaseModel):
    id: str = Field(..., description="Stable identifier, e.g. 'recipe-add-multiply-demo'")
    title: str
    description: Optional[str] = None
    keywords: list[str] = Field(default_factory=list)
    cwl: str = Field(..., description="The raw CWL v1.2 Workflow document, as text")


class ValidateRequest(BaseModel):
    cwl: str = Field(..., description="CWL text to check, without persisting anything")


class EffectiveRequest(BaseModel):
    toolOverrides: dict[str, str] = Field(
        default_factory=dict,
        description="stepId -> tool id, for a per-run custom configuration — never persisted",
    )


def _recipe_summary(recipe: models.RecipeModel) -> dict:
    return {
        "id": recipe.id,
        "title": recipe.title,
        "description": recipe.description,
        "keywords": recipe.keywords or [],
        "created": recipe.created.isoformat() + "Z" if recipe.created else None,
        "updated": recipe.updated.isoformat() + "Z" if recipe.updated else None,
    }


@app.get("/")
def landing_page():
    return {"title": SERVICE_TITLE, "description": SERVICE_DESCRIPTION}


@app.get("/recipes")
def list_recipes(db: Session = Depends(get_db)):
    repo = RecipeRepository(db)
    return {"recipes": [_recipe_summary(r) for r in repo.list()]}


@app.get("/recipes/{recipe_id}")
def get_recipe_cwl(recipe_id: str, db: Session = Depends(get_db)):
    repo = RecipeRepository(db)
    recipe = repo.get(recipe_id)
    if not recipe:
        raise HTTPException(status_code=404, detail=f"Recipe '{recipe_id}' not found")
    return Response(content=recipe.cwl_text, media_type="application/cwl+yaml")


def _find_bundled_original(recipe_id: str) -> Optional[str]:
    """Scans the bundled recipes/ directory for a .cwl file whose own `id:`
    field matches — not a filename guess — so this stays correct even if a
    file gets renamed or a recipe's id doesn't match its filename (as is
    already the case: add-multiply-demo.cwl declares
    id: recipe-add-multiply-demo)."""
    if not BUNDLED_RECIPES_DIR.is_dir():
        return None
    for path in sorted(BUNDLED_RECIPES_DIR.glob("*.cwl")):
        try:
            text = path.read_text(encoding="utf-8")
            doc = cwl_parser.parse_cwl(text)
        except (OSError, cwl_parser.CWLParseError):
            continue
        if doc.get("id") == recipe_id:
            return text
    return None


@app.get("/recipes/{recipe_id}/original")
def get_recipe_original(recipe_id: str):
    """Serves the bundled, on-disk canonical CWL for a recipe — independent
    of whatever is currently stored/edited in the database. Powers the
    Orchestrator tab's Reset action: "reset to original" means going back to
    this file, not just re-fetching whatever happens to be saved right now
    (which could itself be a broken in-progress edit).
    """
    original = _find_bundled_original(recipe_id)
    if original is None:
        raise HTTPException(status_code=404, detail=f"No bundled original CWL found for '{recipe_id}'")
    return Response(content=original, media_type="application/cwl+yaml")


@app.get("/processes/fetch-description")
def fetch_process_description(url: str):
    """Proxies `GET {url}` for an arbitrary OGC API Process the Orchestrator
    tab's author pasted in (e.g. https://demo.pygeoapi.io/master/processes/
    hello-world), so the browser doesn't have to reach that third-party
    server directly — this service's own CORS policy is open (see the
    CORSMiddleware above), but that says nothing about whether the pasted
    server itself allows cross-origin requests from the UI's origin, which
    can't be assumed for an arbitrary external process.

    Returns the upstream JSON body verbatim: the standard OGC API Processes
    Part 1 process description (`inputs`/`outputs`, each with a JSON Schema),
    for the UI to turn into a new CWL step (see UI/js/toolCatalog.js's
    processDescriptionToTool).

    No allowlist, no auth forwarding, no SSRF protection — the same posture
    already documented for the Cook Orchestrator's own step execution (see
    services/cook-orchestrator/README.md, "Limitations"): appropriate for
    this no-auth sandbox, not for a deployment exposed to untrusted authors.
    """
    if not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="url must be an http(s) OGC API Process address")
    url = url.rstrip("/")
    if url.endswith("/execution"):
        url = url[: -len("/execution")]
    try:
        resp = httpx.get(url, timeout=10.0, headers={"Accept": "application/json"})
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Could not reach '{url}': {exc}") from exc
    if not resp.is_success:
        raise HTTPException(
            status_code=502, detail=f"'{url}' responded with HTTP {resp.status_code}"
        )
    try:
        return resp.json()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=f"'{url}' did not return JSON: {exc}") from exc


@app.get("/recipes/{recipe_id}/schema")
def get_recipe_schema(recipe_id: str, db: Session = Depends(get_db)):
    repo = RecipeRepository(db)
    recipe = repo.get(recipe_id)
    if not recipe:
        raise HTTPException(status_code=404, detail=f"Recipe '{recipe_id}' not found")
    doc = cwl_parser.parse_cwl(recipe.cwl_text)
    return cwl_parser.extract_input_schema(doc)


@app.get("/recipes/{recipe_id}/dag")
def get_recipe_dag(recipe_id: str, db: Session = Depends(get_db)):
    repo = RecipeRepository(db)
    recipe = repo.get(recipe_id)
    if not recipe:
        raise HTTPException(status_code=404, detail=f"Recipe '{recipe_id}' not found")
    doc = cwl_parser.parse_cwl(recipe.cwl_text)
    return cwl_parser.extract_dag(doc)


@app.post("/recipes/{recipe_id}/effective")
def get_effective_recipe(recipe_id: str, payload: EffectiveRequest, db: Session = Depends(get_db)):
    """Same shape as /schema + /dag combined, but for the recipe's stored CWL
    with the given steps' tools substituted (see cwl_parser.apply_tool_overrides)
    — a hub's own custom configuration for THIS run, never touching the
    recipe's stored/default CWL. Called by the UI's Wizard (to preview the
    resulting parameter shape as overrides are picked) and by the Cook
    Orchestrator itself at execution time when a request carries overrides.
    """
    repo = RecipeRepository(db)
    recipe = repo.get(recipe_id)
    if not recipe:
        raise HTTPException(status_code=404, detail=f"Recipe '{recipe_id}' not found")
    try:
        doc = cwl_parser.apply_tool_overrides(cwl_parser.parse_cwl(recipe.cwl_text), payload.toolOverrides)
        return {"schema": cwl_parser.extract_input_schema(doc), "dag": cwl_parser.extract_dag(doc)}
    except (cwl_parser.ToolOverrideError, cwl_parser.CWLParseError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/recipes/validate")
def validate_recipe(payload: ValidateRequest):
    """Checks whether a CWL document is in the subset this registry supports,
    WITHOUT storing it or touching the catalog. Used by the UI's recipe editor
    to gate its Save action on an explicit, successful validation — the same
    check `POST /recipes` itself runs before persisting anything, exposed here
    on its own so a client can check before committing to a save.

    Always returns 200: an invalid document is an expected, well-formed
    answer from a validity check, not a server error.
    """
    try:
        doc = cwl_parser.parse_cwl(payload.cwl)
        schema = cwl_parser.extract_input_schema(doc)
        dag = cwl_parser.extract_dag(doc)
    except cwl_parser.CWLParseError as exc:
        return {"valid": False, "error": str(exc)}
    return {"valid": True, "schema": schema, "dag": dag}


@app.post("/recipes", status_code=201)
def register_recipe(payload: RecipeIn, db: Session = Depends(get_db)):
    # Validate before persisting anything — a recipe that doesn't parse never
    # gets stored, so /recipes/{id} always yields something the DAG/schema
    # endpoints can also handle.
    try:
        cwl_parser.extract_dag(cwl_parser.parse_cwl(payload.cwl))
    except cwl_parser.CWLParseError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid CWL: {exc}") from exc

    repo = RecipeRepository(db)
    now = datetime.datetime.utcnow()
    existing = repo.get(payload.id)
    recipe = models.RecipeModel(
        id=payload.id,
        title=payload.title,
        description=payload.description,
        keywords=payload.keywords,
        cwl_text=payload.cwl,
        created=existing.created if existing else now,
        updated=now,
    )
    saved = repo.upsert(recipe)

    catalog_published = True
    catalog_error = None
    try:
        records_client.publish_record(
            record_id=saved.id,
            title=saved.title,
            description=saved.description,
            keywords=saved.keywords or [],
            cookbook_url=f"{PUBLIC_BASE_URL}/recipes/{saved.id}",
        )
    except records_client.RecordsWrapperError as exc:
        # The recipe is safely stored either way — a catalog outage shouldn't
        # lose the recipe itself. We report the failure rather than hide it.
        catalog_published = False
        catalog_error = str(exc)

    return {
        **_recipe_summary(saved),
        "catalog_published": catalog_published,
        "catalog_error": catalog_error,
    }


@app.delete("/recipes/{recipe_id}", status_code=200)
def delete_recipe(recipe_id: str, db: Session = Depends(get_db)):
    repo = RecipeRepository(db)
    if not repo.delete(recipe_id):
        raise HTTPException(status_code=404, detail=f"Recipe '{recipe_id}' not found")

    catalog_retracted = True
    catalog_error = None
    try:
        records_client.retract_record(recipe_id)
    except records_client.RecordsWrapperError as exc:
        catalog_retracted = False
        catalog_error = str(exc)

    return {"deleted": recipe_id, "catalog_retracted": catalog_retracted, "catalog_error": catalog_error}
