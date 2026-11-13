"""Hub Datasets — the real dataset/resource store behind the Sandbox Stack's
"LDT hub" concept (see DECISIONS.md, D1): the data a recipe takes in, and
the results it produces.

What lives here:
  - Input datasets a recipe's data ingredients (its CWL `type: File` inputs)
    can be picked from:
      - "PDOK Rotterdam Boundary Data" — its one resource is fetched live from
        PDOK on every read (see app/pdok.py), never cached.
      - "AHN Point Cloud Sample" — a link-only resource pointing at a small,
        public AHN3 LAZ crop (see AHN_LAZ_URL).
      - "Sample Polygon" — a stored 100 x 100 GeoJSON square.
  - An output dataset, "Sandbox Stack Recipe Results" (same id/title as the
    UI's fallback stub in UI/data/datasets.json), that the Status tab saves
    every successful run's result into, automatically.

Every resource has a plain data URL, `/datasets/{d}/resources/{r}/data`: that
URL is what the UI puts in a CWL File's `location`, and what an OGC API
Process receives as an `href` and fetches itself.

Not an OGC API of its own (no landing page/conformance) — this is a small,
purpose-built REST store the UI's js/data.js and js/sandboxApi.js talk to
directly, same spirit as the OGC API services but without claiming a spec
this deliberately small a store doesn't need to.

Endpoints:
  GET  /datasets
  GET  /datasets/{datasetId}
  GET  /datasets/{datasetId}/resources
  GET  /datasets/{datasetId}/resources/{resourceId}/data     (raw data, for processes)
  GET  /datasets/{datasetId}/resources/{resourceId}/content  ({"content": ...} envelope)
  POST /datasets/{datasetId}/resources
  DELETE /datasets/{datasetId}/resources
"""

from __future__ import annotations

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field, model_validator
from sqlalchemy.orm import Session

from . import models
from .db import Base, engine, get_db, migrate
from .pdok import PdokFetchError, fetch_rotterdam_boundary_geometry
from .repository import DatasetRepository

Base.metadata.create_all(bind=engine)
migrate()

app = FastAPI(title="nLDT Sandbox Stack — Hub Datasets", version="0.1.0")

# Same open-CORS reasoning as every other service in this stack (see
# DECISIONS.md, D11) — the browser-based UI calls this directly.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# The one resource whose content is never stored — every read fetches fresh
# from PDOK (see pdok.py). Its dataset/resource id are otherwise ordinary
# rows, so everything else about it (listing, picking it in the Wizard) works
# through the same generic paths as any other resource.
LIVE_PDOK_DATASET_ID = "ds-pdok-rotterdam-boundary"
LIVE_PDOK_RESOURCE_ID = "res-pdok-rotterdam-outline"

# A real AHN3 point cloud, kept small: a ~1.2 MB crop (208,432 points, RD New
# / EPSG:28992) of AHN3 tile c_37en2 in Delft, published as example data of
# TU Delft's 3dfier. A full AHN tile is several GB, which is pointless to hand
# around (or to start downloading by accident) for a demo. A link-only
# resource: this service never downloads or stores it, it only hands out the
# URL (see get_resource_data). The data ingredient of the roofer playground
# recipe.
AHN_DATASET_ID = "ds-ahn-point-cloud-sample"
AHN_RESOURCE_ID = "res-ahn-point-cloud-sample"
AHN_LAZ_URL = "https://raw.githubusercontent.com/tudelft3d/3dfier/master/example_data/ahn3/ahn3_cropped_2.laz"
AHN_RESOURCE_NAME = "AHN3 crop, Delft (LAZ, 1.2 MB)"

# A small stored GeoJSON polygon — the data ingredient of the Geolabs
# playground recipe (in plain coordinate units, not a real place).
SAMPLE_POLYGON_DATASET_ID = "ds-sample-polygon"
SAMPLE_POLYGON_RESOURCE_ID = "res-sample-polygon"
SAMPLE_POLYGON = {"type": "Polygon", "coordinates": [[[0, 0], [0, 100], [100, 100], [100, 0], [0, 0]]]}

# Seeded, code-owned resources a "Delete All" reset must never remove — they
# are the input data recipes pick, not user-saved data. Every other resource
# in every dataset (e.g. a live recipe's "Save to Hub" run result) is fair
# game to clear.
PROTECTED_RESOURCE_IDS = {LIVE_PDOK_RESOURCE_ID, AHN_RESOURCE_ID, SAMPLE_POLYGON_RESOURCE_ID}


def _seed(db: Session) -> None:
    repo = DatasetRepository(db)
    repo.create_dataset_if_missing(
        models.DatasetModel(
            id=LIVE_PDOK_DATASET_ID,
            title="PDOK Rotterdam Boundary Data",
            description=(
                "Rotterdam's municipal outline, sourced live from PDOK's Bestuurlijke "
                "Gebieden dataset (Kadaster) on every read — an open-data input a recipe's "
                "GeoJSON data ingredient can be picked from."
            ),
            owner_hub_id="nldt-sandbox-hub",
            owner_hub_name="nLDT Sandbox Hub",
            license="CC0 1.0",
            findability="PUBLIC",
            tags=["Sandbox Stack", "Open Data", "PDOK"],
        )
    )
    repo.create_resource_if_missing(
        models.ResourceModel(
            id=LIVE_PDOK_RESOURCE_ID,
            dataset_id=LIVE_PDOK_DATASET_ID,
            name="Rotterdam Municipal Outline",
            # "wfs", not "geojson" — this is a live WFS 2.0.0 connection
            # (see pdok.py), re-queried on every read, not a static file;
            # GeoJSON is only the wire encoding requested from it (and what
            # its /data URL returns). The UI's resource picker accepts "wfs"
            # for a recipe input whose CWL format is application/geo+json.
            format="wfs",
            content=None,
        )
    )
    # This resource's format/name are definitional, code-owned metadata, not
    # user data — create_resource_if_missing alone would leave a row created
    # by an older version of this function stuck with a stale format forever
    # (confirmed: exactly this happened when the format changed from
    # "geojson" to "wfs" — the persisted volume kept the original row).
    repo.sync_seeded_resource_metadata(
        LIVE_PDOK_DATASET_ID, LIVE_PDOK_RESOURCE_ID, name="Rotterdam Municipal Outline", format="wfs"
    )
    repo.create_dataset_if_missing(
        models.DatasetModel(
            id="ds-sandbox-results",
            title="Sandbox Stack Recipe Results",
            description=(
                "Destination dataset for saving the output of live recipes executed via "
                "the Sandbox Stack's Cook Orchestrator — one resource per run's result."
            ),
            owner_hub_id="nldt-sandbox-hub",
            owner_hub_name="nLDT Sandbox Hub",
            license="CC0 1.0",
            findability="PUBLIC",
            tags=["Sandbox Stack", "Live Recipe Output"],
        )
    )
    repo.create_dataset_if_missing(
        models.DatasetModel(
            id=AHN_DATASET_ID,
            title="AHN Point Cloud Sample",
            description=(
                "A small crop of a real AHN3 point cloud (LAZ) in Delft, from the Actueel "
                "Hoogtebestand Nederland: about 1.2 MB, 208,432 points, RD New (EPSG:28992), "
                "published as example data of TU Delft's 3dfier. A link-only resource: the file "
                "stays where it is published and a recipe receives its URL, never a copy."
            ),
            owner_hub_id="nldt-sandbox-hub",
            owner_hub_name="nLDT Sandbox Hub",
            license="CC0 1.0",
            findability="PUBLIC",
            tags=["Sandbox Stack", "Open Data", "AHN", "Point Cloud"],
        )
    )
    repo.create_resource_if_missing(
        models.ResourceModel(
            id=AHN_RESOURCE_ID,
            dataset_id=AHN_DATASET_ID,
            name=AHN_RESOURCE_NAME,
            format="laz",
            content=None,
            url=AHN_LAZ_URL,
        )
    )
    repo.sync_seeded_resource_metadata(
        AHN_DATASET_ID, AHN_RESOURCE_ID, name=AHN_RESOURCE_NAME, format="laz", url=AHN_LAZ_URL
    )
    repo.create_dataset_if_missing(
        models.DatasetModel(
            id=SAMPLE_POLYGON_DATASET_ID,
            title="Sample Polygon",
            description=(
                "A 100 x 100 square polygon in plain coordinate units — a small GeoJSON input for "
                "trying out geometry processes."
            ),
            owner_hub_id="nldt-sandbox-hub",
            owner_hub_name="nLDT Sandbox Hub",
            license="CC0 1.0",
            findability="PUBLIC",
            tags=["Sandbox Stack", "Sample Data"],
        )
    )
    repo.create_resource_if_missing(
        models.ResourceModel(
            id=SAMPLE_POLYGON_RESOURCE_ID,
            dataset_id=SAMPLE_POLYGON_DATASET_ID,
            name="Square polygon (100 x 100)",
            format="geojson",
            content=SAMPLE_POLYGON,
        )
    )
    repo.sync_seeded_resource_metadata(
        SAMPLE_POLYGON_DATASET_ID, SAMPLE_POLYGON_RESOURCE_ID, name="Square polygon (100 x 100)", format="geojson"
    )


class ResourceIn(BaseModel):
    name: str
    format: str = Field(default="geojson")
    content: dict | None = Field(default=None, description="The resource's actual payload, e.g. a GeoJSON Feature")
    url: str | None = Field(default=None, description="Where a link-only resource's data lives instead")

    @model_validator(mode="after")
    def _content_or_url(self) -> "ResourceIn":
        if self.content is None and not self.url:
            raise ValueError("A resource needs either `content` or a `url`")
        return self


def _dataset_out(d: models.DatasetModel) -> dict:
    return {
        "id": d.id,
        "title": d.title,
        "description": d.description,
        "owner_hub_id": d.owner_hub_id,
        "owner_hub_name": d.owner_hub_name,
        "license": d.license,
        "findability": d.findability,
        "tags": d.tags or [],
    }


def _resource_out(r: models.ResourceModel) -> dict:
    return {
        "id": r.id,
        "dataset_id": r.dataset_id,
        "name": r.name,
        "format": r.format,
        "url": r.url,
        "created": r.created.isoformat() + "Z" if r.created else None,
    }


def _get_dataset_or_404(repo: DatasetRepository, dataset_id: str) -> models.DatasetModel:
    dataset = repo.get_dataset(dataset_id)
    if not dataset:
        raise HTTPException(status_code=404, detail=f"Dataset '{dataset_id}' not found")
    return dataset


@app.get("/datasets")
def list_datasets(db: Session = Depends(get_db)):
    repo = DatasetRepository(db)
    return {"datasets": [_dataset_out(d) for d in repo.list_datasets()]}


@app.get("/datasets/{dataset_id}")
def get_dataset(dataset_id: str, db: Session = Depends(get_db)):
    repo = DatasetRepository(db)
    return _dataset_out(_get_dataset_or_404(repo, dataset_id))


@app.get("/datasets/{dataset_id}/resources")
def list_resources(dataset_id: str, db: Session = Depends(get_db)):
    repo = DatasetRepository(db)
    _get_dataset_or_404(repo, dataset_id)
    return {"resources": [_resource_out(r) for r in repo.list_resources(dataset_id)]}


def _get_resource_or_404(repo: DatasetRepository, dataset_id: str, resource_id: str) -> models.ResourceModel:
    _get_dataset_or_404(repo, dataset_id)
    resource = repo.get_resource(dataset_id, resource_id)
    if not resource:
        raise HTTPException(status_code=404, detail=f"Resource '{resource_id}' not found in dataset '{dataset_id}'")
    return resource


# Media type of a stored resource's content, by its catalogue format.
_STORED_MEDIA_TYPES = {"geojson": "application/geo+json"}


@app.get("/datasets/{dataset_id}/resources/{resource_id}/data")
def get_resource_data(dataset_id: str, resource_id: str, db: Session = Depends(get_db)):
    """A resource's raw data at a plain URL — what a CWL File's `location`
    points at, and what an OGC API Process fetches when it receives that
    File as an `{"href": ...}` input. Unlike /content, nothing is wrapped:
    the body is the data itself, with its own media type."""
    repo = DatasetRepository(db)
    resource = _get_resource_or_404(repo, dataset_id, resource_id)

    if resource.id == LIVE_PDOK_RESOURCE_ID:
        try:
            geometry = fetch_rotterdam_boundary_geometry()
        except PdokFetchError as exc:
            raise HTTPException(status_code=502, detail=f"Could not fetch live data from PDOK: {exc}") from None
        return JSONResponse(geometry, media_type="application/geo+json")

    if resource.url:
        return RedirectResponse(resource.url, status_code=307)

    if resource.content is None:
        raise HTTPException(status_code=404, detail=f"Resource '{resource_id}' has no data")
    return JSONResponse(resource.content, media_type=_STORED_MEDIA_TYPES.get(resource.format, "application/json"))


@app.get("/datasets/{dataset_id}/resources/{resource_id}/content")
def get_resource_content(dataset_id: str, resource_id: str, db: Session = Depends(get_db)):
    repo = DatasetRepository(db)
    resource = _get_resource_or_404(repo, dataset_id, resource_id)

    if resource.id == LIVE_PDOK_RESOURCE_ID:
        try:
            return {"content": fetch_rotterdam_boundary_geometry()}
        except PdokFetchError as exc:
            raise HTTPException(status_code=502, detail=f"Could not fetch live data from PDOK: {exc}") from None

    if resource.content is None:
        raise HTTPException(status_code=404, detail=f"Resource '{resource_id}' has no content")
    return {"content": resource.content}


@app.post("/datasets/{dataset_id}/resources", status_code=201)
def create_resource(dataset_id: str, payload: ResourceIn, db: Session = Depends(get_db)):
    repo = DatasetRepository(db)
    _get_dataset_or_404(repo, dataset_id)
    resource = models.ResourceModel(
        dataset_id=dataset_id,
        name=payload.name,
        format=payload.format,
        content=payload.content,
        url=payload.url,
    )
    saved = repo.create_resource(resource)
    return _resource_out(saved)


@app.delete("/datasets/{dataset_id}/resources/{resource_id}")
def delete_resource(dataset_id: str, resource_id: str, db: Session = Depends(get_db)):
    """Deletes one user-saved resource — the "Delete selected" button on the
    Data Catalogue's map preview (see UI/js/hubPreview.js) calls this once
    per selected result. A seeded resource (PROTECTED_RESOURCE_IDS) is
    refused with 409, the same rule as the bulk reset below."""
    repo = DatasetRepository(db)
    resource = _get_resource_or_404(repo, dataset_id, resource_id)
    if resource.id in PROTECTED_RESOURCE_IDS:
        raise HTTPException(status_code=409, detail=f"Resource '{resource_id}' is built in and can't be deleted")
    repo.delete_resource(resource)
    return {"deleted": resource_id}


@app.delete("/datasets/{dataset_id}/resources")
def delete_all_resources(dataset_id: str, db: Session = Depends(get_db)):
    """Demo-only bulk reset: clears every user-saved resource in the dataset
    (e.g. accumulated recipe run results) but leaves any seeded resource
    (PROTECTED_RESOURCE_IDS) in place. For scripted resets; the UI's preview
    deletes selected results one by one, via delete_resource."""
    repo = DatasetRepository(db)
    _get_dataset_or_404(repo, dataset_id)
    deleted = repo.delete_all_resources(dataset_id, exclude_ids=PROTECTED_RESOURCE_IDS)
    return {"deleted": deleted}


@app.on_event("startup")
def on_startup() -> None:
    db = next(get_db())
    try:
        _seed(db)
    finally:
        db.close()
