# OGC API Records Wrapper

## 1. What is it?

The catalog/discovery service for the nLDT Sandbox Stack. It implements
**OGC API - Records - Part 1: Core** (landing page, conformance, collections,
a collection's items, a single item, plus free-text search) as a genuine
**wrapper in front of a real CKAN instance** — CKAN is the actual datastore
(`services/records-wrapper/app/repository.py` translates every call into
CKAN's Action API); this service owns the OGC-conformant HTTP surface, not
the storage. There is one fixed collection, `recipes`, mapped to a CKAN
organization of the same name. See `../../DECISIONS.md`, D14.

Crucially, this service **does not store recipes themselves** — it stores
lightweight discovery metadata (title, description, keywords, timestamps) plus
a `links` entry pointing back to wherever the real recipe payload (its CWL
document) actually lives — in this stack, the Cookbook API Registry. That
separation ("catalog vs. the thing being catalogued") is deliberate — see
`../../DECISIONS.md`, D9.

Each record is one CKAN dataset ("package") in the `recipes` organization:
the record `id` is the package `name`, `description` is `notes`, `keywords`
are tags, and the fields CKAN has no column for are CKAN extras —
`record_type` (the record's `type`, default `recipe`), `cookbook_url` and
`cwl_media_type`. On the wire a record is a GeoJSON-style Feature whose
`links` include `self`, `collection` and, when `cookbook_url` is set, a link
with rel `http://www.opengis.net/def/rel/ogc/1.0/recipe-source` (type: the
record's `cwl_media_type`) to the recipe's CWL in the Cookbook API Registry.

## 2. How to use it

### Bring up CKAN and this service (Docker, from the repo root)

The CKAN organization and API token this service needs can only be created
once CKAN is actually running (its sysadmin user, `ckan_admin`, is created by
the CKAN image on first start) — they can't be baked into a docker-compose
env var ahead of time. So bring-up is two steps:

```bash
docker compose up --build
python services/records-wrapper/scripts/bootstrap_ckan.py   # one-time; safe to re-run
```

The second step mints an API token for `ckan_admin` (via `docker compose exec
ckan ckan user token add`, so run it from the repo root), creates the
`recipes` CKAN organization, and writes the token to
`./secrets/ckan_api_token.txt`. It takes CKAN's URL as an optional argument
(default `http://localhost:8020`). This service reads the token file lazily
(no restart needed — every CKAN-touching endpoint returns `503` until the
token exists, rather than crashing). Run it again after a
`docker compose down -v`, which wipes CKAN's database.

CKAN's own web UI is reachable directly at `http://localhost:8020` — useful
for seeing the real datasets this service's records translate to/from.

Configuration (environment variables):

| Variable | Default | Meaning |
|---|---|---|
| `CKAN_URL` | `http://ckan:5000` | CKAN base URL |
| `CKAN_ORGANIZATION` | `recipes` | CKAN organization records are written to; keep it `recipes`, since reads filter on the collection id |
| `CKAN_API_TOKEN_FILE` | `/secrets/ckan_api_token.txt` | File with the CKAN API token (in Docker Compose, `./secrets` is mounted at `/secrets`) |

In Docker Compose this is the `records-wrapper` service (published on port
8001); behind the single-origin gateway (`docker-compose.gateway.yml`) it is
served at `/api/records`, started with `uvicorn --root-path` so the links it
returns carry that prefix.

### Run locally (no Docker)

Requires a reachable CKAN instance (e.g. the `ckan` container from
`docker-compose.yml`, published at `http://localhost:8020`) and a token file
from `bootstrap_ckan.py`:

```bash
cd services/records-wrapper
python -m venv .venv
. .venv/Scripts/activate   # Windows Git Bash; use .venv/bin/activate on macOS/Linux
pip install -r requirements.txt
CKAN_URL=http://localhost:8020 CKAN_API_TOKEN_FILE=../../secrets/ckan_api_token.txt \
  uvicorn app.main:app --reload --port 8001
```

### Endpoints

| Method | Path | What it does | Spec status |
|---|---|---|---|
| GET | `/` | Landing page (links `self`, `conformance`, `data`, `service-desc`) | Core |
| GET | `/conformance` | Declared conformance classes (Common core/json, Records core/json) | Core |
| GET | `/collections` | List collections (always just `recipes`) | Core |
| GET | `/collections/{id}` | A collection's description | Core |
| GET | `/collections/{id}/items` | Search/list records as a FeatureCollection: `q` (free text), `limit` (default 10, max 100), `offset`; newest first | Core |
| GET | `/collections/{id}/items/{itemId}` | A single record | Core |
| POST | `/collections/{id}/items` | Register/replace a record (upsert by `id`) → `201` with the record. Body: `id`, `title` (required), `description`, `keywords`, `type` (default `recipe`), `cookbook_url`, `cwl_media_type` (default `application/cwl+yaml`) | **Extension** (see below) |
| DELETE | `/collections/{id}/items/{itemId}` | Remove a record → `204` | **Extension** (see below) |
| GET | `/openapi.json`, `/docs` | OpenAPI document and its HTML view (FastAPI) | — |

Errors are FastAPI `{"detail": ...}` bodies: `404` for an unknown collection
or record, `422` for an invalid body or query parameter, `502` when CKAN
fails, `503` until the CKAN token file exists.

### Try it

```bash
curl http://localhost:8001/
curl http://localhost:8001/conformance
curl http://localhost:8001/collections
curl http://localhost:8001/collections/recipes/items

# register a record (this is what the Cookbook API Registry does for real, on every POST /recipes)
curl -X POST http://localhost:8001/collections/recipes/items \
  -H "Content-Type: application/json" \
  -d '{"id":"recipe-add-multiply-demo","title":"Add then Multiply","description":"(a+b)*c demo recipe","keywords":["demo"],"cookbook_url":"http://localhost:8002/recipes/recipe-add-multiply-demo"}'

curl http://localhost:8001/collections/recipes/items/recipe-add-multiply-demo
```

Who actually calls this in the real stack: the **Cookbook API Registry**
publishes/retracts entries here on every `POST`/`DELETE /recipes`, and the
**UI** reads from here (via `GET /collections/recipes/items`) to power the
recipe catalogue's search/list views. Nothing here executes anything or
knows about tools/apps at all.

## 3. Limitations

- **`POST`/`DELETE` are not part of OGC API - Records - Part 1: Core.** Core
  is a read/discovery spec; it does not define a write interface at all.
  These two endpoints are a documented, pragmatic extension that exists
  purely so the Cookbook API Registry has somewhere to publish/retract a
  catalog entry — a general client should treat this service as read-only.
- **No authentication or authorization on those write endpoints either** —
  anything that can reach this service can register or delete any record.
  Fine for a no-auth sandbox (see `../../DECISIONS.md`, D11); not
  appropriate for a public deployment as-is.
  (This service's own CKAN sysadmin credentials, in `docker-compose.yml`,
  are placeholder values for the same reason — change before any real use.)
- **Only one, hardcoded collection** (`recipes`) — there is no way to create
  additional collections through the API.
- **No spatial capability.** Every record's `geometry` is always `null` — this
  is used purely as a non-spatial metadata catalog, despite OGC API Records
  being a geospatially-oriented family of specs. No bbox/spatial filtering.
- **No DCAT-AP-NL profile.** Records expose OGC API Records' own core
  properties only (title/description/keywords/created/updated) — mapping
  recipes onto a full DCAT-AP-NL profile is out of scope for now, listed
  under "Open items" in `../../DECISIONS.md`.
- **Search is a plain free-text `q` filter** over CKAN's own Solr-backed
  `package_search` — no extra faceting on top of it, `limit` capped at 100.
  Page with `offset`: the items response has only a `self` link, no
  `next`/`prev` links.
- **This service can't tell you whether a recipe "still works."** It only
  ever stores a title/description/keyword snapshot plus a link — the actual
  content (the CWL) and whether it's structurally valid or executes correctly
  live entirely in the Cookbook API Registry / Cook Orchestrator. A stale or
  broken `cookbook_url` link here is not something this service detects.
- **CKAN soft-deletes.** `DELETE` marks a record's underlying CKAN package as
  `deleted` (excluded from search/get, matching this service's own 404
  semantics) rather than purging it outright; re-publishing under the same id
  later revives it. `services/records-wrapper/app/repository.py` documents
  why this matters for the upsert path.
