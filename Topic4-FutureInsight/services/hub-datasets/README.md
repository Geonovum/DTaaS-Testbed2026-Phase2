# Hub Datasets

## 1. What is it?

The dataset/resource store behind the Sandbox Stack's "LDT hub" concept: the
data a recipe's **data ingredients** are picked from, and where a recipe
run's result is saved. It's a small, purpose-built REST store (SQLite via
SQLAlchemy, all database access in `app/repository.py`), not an OGC API of
its own — it doesn't claim a spec this deliberately small a store doesn't
need. So it has no landing page or conformance endpoint, and its errors are
plain FastAPI `{"detail": ...}` bodies rather than OGC exception documents.

A recipe declares its data ingredients as standard CWL `type: File` inputs
with a `format` (see `../../DECISIONS.md`, D19). At run time such an input is
a reference, `{"class": "File", "location": <url>}`, and the process fetches
the data itself. Every resource here therefore has a plain **data URL** —
`/datasets/{d}/resources/{r}/data` — which is what the UI puts in a File's
`location` (for a link-only resource, the UI uses its `url` directly).

A resource's data lives in one of three places:

| Kind | Example | What `/data` does |
|---|---|---|
| **Live upstream** | the PDOK boundary | fetches it fresh on every read |
| **Stored content** | a saved recipe result, the sample polygon | returns the stored JSON |
| **Link-only** (`url` set) | the AHN point cloud sample | `307` redirect to `url` |

It seeds these datasets on startup (all owned by the nLDT Sandbox Hub):

- **`ds-pdok-rotterdam-boundary`** ("PDOK Rotterdam Boundary Data") — one
  resource, `res-pdok-rotterdam-outline` (format `wfs`). Its content is
  **never stored**: every read fetches Rotterdam's municipal outline fresh
  from PDOK's real WFS 2.0.0 service for the Bestuurlijke Gebieden (Kadaster)
  dataset (`https://service.pdok.nl/kadaster/brk-bestuurlijke-gebieden/wfs/v1_0`,
  requested with `outputFormat=json` — see `app/pdok.py`). Its `/data` URL
  returns the geometry as `application/geo+json`. The data ingredient of the
  "Rotterdam Boundary Buffer" recipe.
- **`ds-ahn-point-cloud-sample`** ("AHN Point Cloud Sample") — one link-only
  resource, `res-ahn-point-cloud-sample` (format `laz`), pointing at a small
  crop of a real AHN3 point cloud in Delft (tile `c_37en2`, ~1.2 MB, 208,432
  points, RD New / EPSG:28992), published as example data of TU Delft's
  3dfier: `https://raw.githubusercontent.com/tudelft3d/3dfier/master/example_data/ahn3/ahn3_cropped_2.laz`.
  Never downloaded or stored here. Deliberately small: a full AHN tile is
  several GB. The data ingredient of the roofer playground recipe
  (Playground Recipe 1).
- **`ds-sample-polygon`** ("Sample Polygon") — one stored resource,
  `res-sample-polygon` (format `geojson`): a 100 x 100 square in plain
  coordinate units. The data ingredient of the Geolabs playground recipe
  (Playground Recipe 2).
- **`ds-sandbox-results`** ("Sandbox Stack Recipe Results") — no seeded
  resource; the UI's Status tab saves every successful run's result here
  automatically, one resource per run (see `../../UI/js/liveRecipe.js`). Same
  id/title as the UI's fallback stub in `../../UI/data/datasets.json`.

`../../UI/js/data.js::getDatasets()` merges these into the shape the UI catalogue
uses, so the Data Catalogue, a hub's Datasets tab, and the Recipe Wizard's
resource picker all read them with no special-casing.

## 2. How to use it

### Run locally (no Docker)

```bash
cd services/hub-datasets
python -m venv .venv
. .venv/Scripts/activate   # Windows Git Bash; use .venv/bin/activate on macOS/Linux
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8014
```

The database is set by `HUB_DATASETS_DB_URL` (an SQLAlchemy URL; default
`sqlite:///./hub_datasets.db`, in Docker Compose `sqlite:////data/hub_datasets.db`
on the `hub_datasets_data` volume). The seed datasets are created on startup;
there is no separate seeding script. In Docker Compose this is the
`hub-datasets` service (published on port 8014); behind the single-origin
gateway (`docker-compose.gateway.yml`) it is served at `/api/hub`.

### Endpoints

| Method | Path | What it does |
|---|---|---|
| GET | `/datasets` | List every dataset |
| GET | `/datasets/{datasetId}` | One dataset's metadata |
| GET | `/datasets/{datasetId}/resources` | List a dataset's resources (metadata only: `id, dataset_id, name, format, url, created`) |
| GET | `/datasets/{datasetId}/resources/{resourceId}/data` | The resource's raw data, for a process to fetch: live GeoJSON from PDOK for the boundary, the stored JSON otherwise (`application/geo+json` for format `geojson`), or a `307` redirect to `url` for a link-only resource |
| GET | `/datasets/{datasetId}/resources/{resourceId}/content` | The same data wrapped as `{"content": ...}` (used by the UI's map preview); `404` for link-only resources |
| POST | `/datasets/{datasetId}/resources` | Create a resource: `{name, format, content}` or, for a link-only one, `{name, format, url}` (`format` defaults to `geojson`; one of `content`/`url` is required, else `422`). Returns `201` with the new resource's metadata |
| DELETE | `/datasets/{datasetId}/resources/{resourceId}` | Delete one resource → `{"deleted": "<resourceId>"}` (used by the map preview's "Delete selected"); a seeded resource is refused with `409` |
| DELETE | `/datasets/{datasetId}/resources` | Demo reset: delete every resource in the dataset except the seeded ones → `{"deleted": <count>}` |

An unknown dataset or resource is a `404`; PDOK being unreachable is a `502`.

### Try it

```bash
curl -s http://localhost:8014/datasets
curl -s http://localhost:8014/datasets/ds-sample-polygon/resources/res-sample-polygon/data
# -> {"type": "Polygon", "coordinates": [[[0, 0], [0, 100], [100, 100], [100, 0], [0, 0]]]}
curl -s -o /dev/null -D - http://localhost:8014/datasets/ds-ahn-point-cloud-sample/resources/res-ahn-point-cloud-sample/data
# -> HTTP/1.1 307 Temporary Redirect, location: https://raw.githubusercontent.com/tudelft3d/3dfier/master/example_data/ahn3/ahn3_cropped_2.laz
#    (a GET; the endpoints don't answer HEAD, so `curl -I` gets 405)
curl -s http://localhost:8014/datasets/ds-pdok-rotterdam-boundary/resources/res-pdok-rotterdam-outline/data
# -> {"type": "MultiPolygon", "coordinates": [...]}  (fetched live from PDOK's WFS, every time —
#    takes ~10-15s: the service's CQL_FILTER is unreliable, so this pulls
#    the full ~30MB municipality collection and filters client-side)
```

### Upgrading an existing database

`resources.url` was added after the first deployments. On startup,
`app/db.py::migrate()` adds the column to an existing SQLite database if it's
missing, so a persisted volume keeps its saved results.

## 3. Limitations

- **Hardcoded seed datasets.** There is no create-dataset endpoint —
  registering a genuinely new dataset means adding it to `_seed()` in
  `app/main.py`.
- **No authentication**, same open-CORS sandbox posture as the rest of the
  stack (see `../../DECISIONS.md`, D11). Anyone who can reach the service
  can add resources, and delete any resource that is not seeded.
- **A data URL must be reachable by the process that receives it.** An
  external process (roofer, the Geolabs ZOO-Project server) can only fetch a
  `/data` URL on a publicly deployed stack, not on `localhost`.
- **The PDOK-backed resource has no offline fallback.** If PDOK is
  unreachable, its `/data` and `/content` endpoints return `502` rather than
  serving a cached copy — deliberate (see `app/pdok.py`'s docstring): the
  point is that this ingredient is always PDOK's current data, not a snapshot.
- **Every fetch of the PDOK resource takes ~10-15 seconds.** The WFS's
  `CQL_FILTER` is confirmed unreliable (silently ignored), so `app/pdok.py`
  pulls the entire ~30MB municipality collection and filters for "Rotterdam"
  client-side, on every call — a real, accepted cost of staying genuinely
  uncached, not a bug.
- **The AHN sample is only a pointer.** Nothing here checks that the linked
  file still exists or is a valid LAZ; roofer's staging processes don't
  download it either (they return fixture results).
