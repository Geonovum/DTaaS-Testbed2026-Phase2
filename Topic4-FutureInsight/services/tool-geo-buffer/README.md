# Tool Service — Geo Buffer

## 1. What is it?

A minimal **OGC API - Processes - Part 1: Core** service exposing one process,
`buffer-geometry`: buffers a GeoJSON geometry by a distance in meters, using
[Shapely](https://shapely.readthedocs.io/) and
[pyproj](https://pyproj4.github.io/pyproj/) to reproject into RD New
(EPSG:28992) for the buffer operation itself (so the distance genuinely means
meters, not degrees) and back to WGS84 for the result. Input geometries must
be WGS84 (EPSG:4326, longitude/latitude). The result is a GeoJSON Feature,
`bufferedGeometry`, with the distance used in `properties.buffer_distance_m`.

A Polygon or MultiPolygon is buffered along its **boundary line**, not as an
area: the result is a band of width 2 × `distance` straddling the outline,
rather than the polygon grown outward by `distance`. That makes the distance
visible on a map at city scale. Points and lines are buffered directly.

Same "deliberately simple leaf tool" allowance as `../tool-service` (see
`../../DECISIONS.md`, D1) — but its own standalone codebase, not one more
entry in that service's `OPERATIONS` dict, because that service's whole
contract is hard-coded numeric (`float()` coercion, `"type": "number"`
throughout) and this one's inputs/outputs are GeoJSON geometries.

This is the tool the "Rotterdam Boundary Buffer" recipe's one step calls (see
`../cookbook-registry/recipes/rotterdam-buffer-demo.cwl`).

`geometry` is a data input, and accepts every way OGC API Processes allows
one to be given:

- **by value** — a GeoJSON geometry, Feature, or FeatureCollection (its
  features' geometries merged);
- **as a qualified value** — `{"value": <GeoJSON or GeoJSON text>,
  "mediaType": "application/geo+json"}`;
- **by reference** — `{"href": "<URL>", "type": "application/geo+json"}`,
  which this service fetches itself (redirects followed; a `{"content":
  ...}` envelope is unwrapped). This is how the Cook Orchestrator sends a
  recipe's data ingredient. The environment variable
  `GEOMETRY_FETCH_TIMEOUT` (seconds, default `60`) bounds the fetch; a
  failed fetch is a `400` naming the URL.

`distance` is a number in meters (plain, or as a qualified value), and must
not be negative.

## 2. How to use it

### Run locally (no Docker)

```bash
cd services/tool-geo-buffer
python -m venv .venv
. .venv/Scripts/activate   # Windows Git Bash; use .venv/bin/activate on macOS/Linux
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8013
```

In Docker Compose this is the `tool-geo-buffer` service (published on port
8013); behind the single-origin gateway (`docker-compose.gateway.yml`) it is
served at `/api/tools/geo-buffer`, started with `uvicorn --root-path` so the
links it returns carry that prefix.

### Endpoints

| Method | Path | What it does |
|---|---|---|
| GET | `/` | Landing page (links to conformance, processes, and the OpenAPI document as `service-desc` / `service-doc`) |
| GET | `/conformance` | Declared conformance classes (`core`, `json`, `oas30`) |
| GET | `/processes` | List (always one entry: `buffer-geometry`) |
| GET | `/processes/{processId}` | Process description (its inputs/outputs) |
| POST | `/processes/{processId}/execution` | Synchronous execution → `{"outputs": {...}}` |
| GET | `/jobs` | Always an empty job list (`{"jobs": [], ...}`): execution is synchronous, so there are never jobs |
| GET | `/openapi.json`, `/docs` | OpenAPI document and its HTML view (FastAPI) |

Errors are OGC API Processes exception documents,
`{"type", "title", "status", "detail"}`: `404` with type
`.../ogcapi-processes-1/1.0/no-such-process` for an unknown process id, `400`
for a missing or invalid input, an unreachable `href`, or a malformed request
body.

### Try it

```bash
curl -s -X POST http://localhost:8013/processes/buffer-geometry/execution \
  -H "Content-Type: application/json" \
  -d '{"inputs":{"geometry":{"type":"Point","coordinates":[4.48,51.92]},"distance":500}}'
# -> {"outputs":{"bufferedGeometry":{"type":"Feature","geometry":{"type":"Polygon", ...},"properties":{"buffer_distance_m":500.0}}}}

# the same, with the geometry given by reference (Rotterdam's boundary from
# ../hub-datasets). The URL must be reachable from this service: localhost:8014
# works when both run outside Docker; inside Docker Compose use
# http://hub-datasets:8000/... instead (the Cook Orchestrator rewrites
# public hub URLs to that address itself, see its LOCATION_REWRITES).
# Takes ~10-15 s, as the hub fetches the boundary live from PDOK.
curl -s -X POST http://localhost:8013/processes/buffer-geometry/execution \
  -H "Content-Type: application/json" \
  -d '{"inputs":{"geometry":{"href":"http://localhost:8014/datasets/ds-pdok-rotterdam-boundary/resources/res-pdok-rotterdam-outline/data","type":"application/geo+json"},"distance":500}}'
```

## 3. Limitations

- **Synchronous execution only**, same reasoning as `../tool-service`.
- **One hardcoded operation.** Unlike `../tool-service`'s env-var-selected
  operations, this service always serves `buffer-geometry` — its only setting
  is `GEOMETRY_FETCH_TIMEOUT`.
- **Buffers in RD New (EPSG:28992) specifically** — appropriate for the
  Netherlands-local geometries this stack actually deals with (Rotterdam's
  boundary); not a general-purpose "correct local UTM zone" implementation.
- **No authentication**, same open-CORS sandbox posture as the rest of the
  stack (see `../../DECISIONS.md`, D11).
- **Minimal validation.** Checks presence, that `distance` is a non-negative
  number, and that `geometry` parses as a GeoJSON geometry (via Shapely's
  `shape()`) — no further domain checks (self-intersection, coordinate
  bounds, etc.).
- **No SSRF protection** on by-reference inputs: whatever `href` it is given
  is fetched — fine for this no-auth sandbox, not for untrusted callers.
