# Cookbook API Registry

## 1. What is it?

The service that owns a **recipe**: it stores the raw **CWL (Common Workflow
Language) v1.2** document text for each recipe, serves it back verbatim, and
*derives* (never caches) two things from it on every request:

- a **JSON Schema** for the recipe's top-level inputs (`GET /recipes/{id}/schema`)
  — what the UI/API caller must supply to run it, and
- an **execution DAG** (`GET /recipes/{id}/dag`) — the topologically-sorted
  step list, each step's OGC API Processes `process_id`, and how each step's
  inputs are wired (to a workflow input, or to a previous step's output).
  Each step also carries two names: `label`, what the step does (its CWL
  step `label`, else its id), and `process_label`, the app that runs it (its
  Operation's own `label`, or `null`). The UI shows apps by `process_label`.
  This is exactly what the Cook Orchestrator reads to actually run a recipe.

It also publishes/retracts a discovery entry for each recipe into the OGC API
Records Wrapper (a link back to this service's own `GET /recipes/{id}`), so
the Records Wrapper never stores the CWL itself — only a pointer to it. See
`../../DECISIONS.md`, D9.

A recipe here is **not** a general-purpose CWL document — see the CWL subset
this service actually understands, under Limitations.

## 2. How to use it

### Run locally (no Docker)

```bash
cd services/cookbook-registry
python -m venv .venv
. .venv/Scripts/activate   # Windows Git Bash; .venv/bin/activate elsewhere
pip install -r requirements.txt
RECORDS_WRAPPER_URL=http://localhost:8001 COOKBOOK_PUBLIC_URL=http://localhost:8002 \
  uvicorn app.main:app --reload --port 8002
```

Settings, all environment variables:

| Variable | Default | What it is |
|---|---|---|
| `COOKBOOK_DB_URL` | `sqlite:///./cookbook.db` | Where recipes are stored |
| `RECORDS_WRAPPER_URL` | `http://records-wrapper:8000` | The OGC API Records Wrapper recipes are published to |
| `RECORDS_WRAPPER_TIMEOUT` | `5` s | Each publish/retract call to it |
| `COOKBOOK_PUBLIC_URL` | `http://cookbook-registry:8000` | This service's own address, written into each catalogue record's link to the recipe |
| `PUBLIC_TOOL_HOST` / `PUBLIC_TOOL_SCHEME` | `localhost` / `http` | Public address of this stack's tool services, `<scheme>://<host>:<port>`: the `nldt:processLink.href` written into a step when `toolOverrides` swaps its tool |
| `PUBLIC_TOOL_BASE` | (unset) | Instead of the above, one base URL with a path per tool (e.g. `https://host/api/tools` → `.../api/tools/add`), for the gateway |

### Run with Docker Compose

From the repo root: `docker compose up --build` brings up the whole stack,
this service on port **8002** (with the gateway overlay,
`docker-compose.gateway.yml`, at `/api/cookbook` instead). Recipes are kept
in the `cookbook_registry_data` volume. Then register the bundled recipes
with the seed script (see "Try it" below).

### Bundled recipes

`recipes/*.cwl` ships two kinds of bundled recipe, fixed demos and shared
playground slots, all registered by `scripts/seed_demo_recipe.py`:

- **`add-multiply-demo.cwl`** — the worked example: a real, complete recipe
  wired to the `tool-add`/`tool-multiply` services, useful as a reference for
  what a finished recipe looks like.
- **`rotterdam-buffer-demo.cwl`** — a real, complete recipe over geodata
  rather than arithmetic: one step, `buffer-geometry` (see
  `../tool-geo-buffer`), buffering a boundary by a distance. Its `geometry`
  input is a **data input** (`type: File`, `format:
  iana:application/geo+json` — see "Data inputs vs parameters" below): the UI
  offers it in the Wizard's Data Ingredients step, e.g. `../hub-datasets`'
  live PDOK-backed "PDOK Rotterdam Boundary Data", and the tool fetches it by
  reference. Only `bufferDistance` is a typed parameter.
- **`playground-1.cwl` … `playground-3.cwl`** — shared, self-documenting
  testing slots anyone may edit and save; Reset in the Orchestrator tab
  brings a slot back to its bundled starter:
  - `playground-1` starts as a **roofer** pipeline (validate point clouds →
    reconstruct buildings → convert format) against roofer's external
    staging processes; its `point_clouds` input is `File[]` of LAZ
    (`iana:application/vnd.laszip`), adapted to roofer's own `{kind: "url",
    url}` shape with a `valueFrom` object template.
  - `playground-2` starts as the **Geolabs** ZOO-Project sampler (Hello
    World services plus GDAL/OGR geometry operations) on Geonovum's testbed
    server; its `polygon` input is a GeoJSON `File`.
  - `playground-3` starts as **Varidian's Subsidence Analysis** process
    (where subsidence stays below a threshold) on Planspace's playground
    registry; its `geojson` input is a pasted GeoJSON FeatureCollection
    (`type: Any`), a parameter rather than a data input.

  Add more slots by dropping another `.cwl` file here and re-running the
  seed script — no script changes needed, since it discovers every
  `recipes/*.cwl` file and reads its `id`/`label`/`doc` directly.

### Extension fields (`nldt:` namespace)

Three things a recipe needs have no CWL field, so they are extension
fields. CWL requires extension fields to carry a namespace prefix declared in
`$namespaces`, so they live in the nLDT namespace:

```yaml
$namespaces:
  nldt: https://fi-group.github.io/nldt-tb2/ns#
```

| Field | Where | What it is |
|---|---|---|
| `nldt:processLink` | a step's inline `run` | Which concrete OGC API Process runs the step (`href` public, `internalHref` inside Docker) |
| `nldt:compatibleTools` | top level | Per step, which alternative cataloged tools a hub may swap in |
| `nldt:jsonSchema` | a workflow input | The exact JSON Schema of a parameter when CWL's types can't express it |

`cwl_parser.parse_cwl` also understands another prefix mapped to the same
namespace IRI, or the full IRI. The earlier un-namespaced names
(`x-process-link`, `x-compatible-tools`, `x-json-schema`) are rejected with an
error naming the replacement. All bundled recipes pass `cwltool --validate`.

### Data inputs vs parameters

A recipe tells data and parameters apart with standard CWL, no extension
field: a workflow input of type **`File`** (or `File?`, `File[]`,
`{type: array, items: File}`) with a **`format`** is a **data input** — a
dataset ingredient, picked from a catalogue when the recipe is set up. Every
other type (`float`, `string`, `enum`, `Any`, ...) is a **parameter**, typed
in when the recipe is run.

```yaml
$namespaces:
  iana: https://www.iana.org/assignments/media-types/
inputs:
  geometry:                       # data input
    type: File
    format: iana:application/geo+json
  bufferDistance: float           # parameter
```

- `format` is a media-type IRI. The prefix is expanded through the
  document's own `$namespaces`; an IRI under
  `https://www.iana.org/assignments/media-types/` becomes the bare media type
  (`iana:` also works without a `$namespaces` entry). Other IRIs (e.g. EDAM)
  are kept as-is but carry no media type.
- At run time a File value is a **reference**, never the data:
  `{"class": "File", "location": "<URL>", "format": "<media-type IRI>"}`. The
  Cook Orchestrator hands it to the process as an OGC API Processes
  by-reference input, `{"href": "<URL>", "type": "<media type>"}` — see
  `../cook-orchestrator/README.md`.
- `GET /recipes/{id}/schema` describes a File input as
  `{"type": "object", "required": ["class", "location"], "properties":
  {"class": {"const": "File"}, "location": {"type": "string", "format":
  "uri"}, "format": {"type": "string"}}, "x-cwl-type": "File",
  "x-media-type": "application/geo+json"}` (an array of those for `File[]`).
  It wins over an input's `nldt:jsonSchema`, which describes a value, not a
  reference.
- `GET /recipes/{id}/dag` (and `/effective`, `/validate`) lists them under
  `data_inputs` — always present, `{}` for a recipe with only parameters:

```json
"data_inputs": {
  "geometry": {"media_type": "application/geo+json", "format": "iana:application/geo+json",
               "array": false, "optional": false, "label": "Input boundary", "doc": "..."}
}
```

- A process that wants its data input in its own shape rather than as an OGC
  reference is adapted in the step's `in:` with a `valueFrom` object
  template, where `self` is the File (or list of Files):

```yaml
in:
  point_clouds:
    source: point_clouds
    valueFrom: '$(self.map(function(f){ return {"kind": "url", "url": f.location}; }))'
```

### Endpoints

| Method | Path | What it does |
|---|---|---|
| GET | `/` | Landing page (title and description) |
| GET | `/recipes` | List registered recipes (id + metadata) |
| GET | `/recipes/{id}` | Raw CWL document, verbatim (`application/cwl+yaml`) |
| GET | `/recipes/{id}/original` | The bundled, on-disk canonical CWL for this recipe, if it shipped with one |
| GET | `/recipes/{id}/schema` | JSON Schema for the recipe's top-level inputs — derived fresh, every call |
| GET | `/recipes/{id}/dag` | The execution graph the Cook Orchestrator walks — derived fresh, every call |
| POST | `/recipes/{id}/effective` | Body `{"toolOverrides": {stepId: toolId}}` → `{"schema", "dag"}` for a per-run tool-substituted variant — **not persisted**; `400` for an unknown step/tool or one the recipe's `nldt:compatibleTools` doesn't allow |
| POST | `/recipes/validate` | Body `{"cwl": "<text>"}`. Checks a CWL document without storing it (always `200`: `{"valid": true, "schema", "dag"}` or `{"valid": false, "error"}`) |
| POST | `/recipes` | Body `{"id", "title", "description"?, "keywords"?, "cwl"}`. Register/replace a recipe (same `id` = overwrite in place) — validates first (`400` if invalid), publishes to the catalog; `201` with `catalog_published`/`catalog_error` |
| DELETE | `/recipes/{id}` | Remove a recipe, retracts it from the catalog |
| GET | `/processes/fetch-description?url=<process URL>` | Fetches an external OGC API Process description server-side and returns it verbatim (so the UI can read it without CORS); `502` if it can't be fetched |

### Try it

```bash
# publish every bundled recipe under recipes/*.cwl — the demo recipes plus the
# "playground" slots (see recipes/playground-*.cwl) — also registering each
# one in the Records Wrapper. Safe to re-run any time (upserts by id); exits
# non-zero if a recipe was stored but could not be published to the catalog.
python scripts/seed_demo_recipe.py http://localhost:8002

curl http://localhost:8002/recipes
curl http://localhost:8002/recipes/recipe-add-multiply-demo
curl http://localhost:8002/recipes/recipe-add-multiply-demo/schema
curl http://localhost:8002/recipes/recipe-add-multiply-demo/dag

# check whether an edited CWL is acceptable, without saving it
curl -s -X POST http://localhost:8002/recipes/validate \
  -H "Content-Type: application/json" \
  -d @- <<'EOF'
{"cwl": "cwlVersion: v1.2\nclass: Workflow\nid: recipe-add-multiply-demo\ninputs: {}\noutputs: {}\nsteps: {}\n"}
EOF

# confirm it now shows up in the catalog too
curl http://localhost:8001/collections/recipes/items/recipe-add-multiply-demo

# retract it
curl -X DELETE http://localhost:8002/recipes/recipe-add-multiply-demo
```

### Calling the whole stack via API only (no UI)

Everything the browser UI does — search the catalogue, read a recipe's
parameters, run it — is just these same HTTP calls. This walks through the
full chain end to end with nothing but `curl`, assuming the stack is up via
`docker compose up` at the repo root with the default port mapping, and set
up and seeded as described in `../../docker-compose.yml`'s header (CKAN
bootstrap, then the seed script above):

| Service | Port |
|---|---|
| OGC API Records Wrapper (catalogue) | 8001 |
| Cookbook API Registry (this service) | 8002 |
| Cook Orchestrator Engine | 8003 |
| Tool service — add | 8010 |
| Tool service — multiply | 8011 |
| Tool service — multiply3 | 8012 |
| Tool service — geo-buffer | 8013 |
| Hub datasets (data ingredients) | 8014 |

**1. Discover a recipe through the catalogue:**

```bash
curl -s "http://localhost:8001/collections/recipes/items?q=multiply" | python -m json.tool
```

Each result's `links` array includes one with
`"rel": "http://www.opengis.net/def/rel/ogc/1.0/recipe-source"` — that `href`
is where the recipe's actual payload lives (this service).

**2. Inspect the recipe itself:**

```bash
RECIPE=recipe-add-multiply-demo
curl -s http://localhost:8002/recipes/$RECIPE                 # raw CWL text
curl -s http://localhost:8002/recipes/$RECIPE/schema | python -m json.tool   # what parameters it takes
curl -s http://localhost:8002/recipes/$RECIPE/dag    | python -m json.tool   # the execution graph
```

**3. Call each tool (app) directly — bypassing the recipe entirely:**

```bash
curl -s http://localhost:8010/processes/add-two-numbers | python -m json.tool
curl -s -X POST http://localhost:8010/processes/add-two-numbers/execution \
  -H "Content-Type: application/json" -d '{"inputs":{"a":2,"b":3}}'
# -> {"outputs":{"sum":5.0}}
```

**4. Run the full recipe — synchronous:**

```bash
curl -s -X POST http://localhost:8003/processes/cook/execution \
  -H "Content-Type: application/json" \
  -d '{"inputs":{"recipeId":"recipe-add-multiply-demo","parameters":{"a":2,"b":3,"c":4}}}' \
  | python -m json.tool
# -> {"result": {"result": 20.0}, "trace": [...]}   i.e. (2 + 3) * 4 = 20
```

**5. Run the full recipe — asynchronous, with job polling:**

```bash
curl -s -i -X POST http://localhost:8003/processes/cook/execution \
  -H "Content-Type: application/json" -H "Prefer: respond-async" \
  -d '{"inputs":{"recipeId":"recipe-add-multiply-demo","parameters":{"a":10,"b":5,"c":2}}}'
# -> HTTP/1.1 201 Created, Location: http://localhost:8003/jobs/<jobId>
JOB=<jobId from the Location header>
curl -s http://localhost:8003/jobs/$JOB
curl -s http://localhost:8003/jobs/$JOB/results
```

Nothing above is UI-specific — this is the complete interface any external
client (a script, another testbed participant's service, a CI job) would use
to discover, inspect, and run a recipe.

## 3. Limitations

### The CWL subset this registry actually accepts

`app/cwl_parser.py` is **a purpose-built reader, not a general CWL
processor** — there is no `cwltool`/schema-salad dependency. A document can be
perfectly valid CWL 1.2 by the spec and still be **rejected here** if it
doesn't fit this exact shape:

- Top level must be `class: Workflow`, `cwlVersion` starting with `v1.`, and
  must have `inputs`, `outputs`, and `steps` keys.
- `steps` must be **mapping-form** (`steps: {stepId: {...}}`), not CWL's
  alternative list-form.
- Each step's `in:` must also be **mapping-form**, and each value must be
  either a plain string (`a: a`) or `{source: ..., valueFrom: ...}` — no
  arrays of sources, no step-level `default`, no `scatter`/`when`.
- `valueFrom` is **recognised by pattern, never run as JavaScript** (there is
  no JS engine in the stack). Only these forms are accepted; anything else is
  rejected at validate/save time:
  - `$(self.a.b)` — pick a (nested) field;
  - `$(self.a.map(function(x){ return x.b; }))` — pick a field from every
    item of a list;
  - `$(self.map(function(x){ return {"k": x.field, "kind": "url"}; }))` —
    build one flat object per item (`self.a.map(...)` picks a list first);
  - `$({"k": self.field, "n": 3})` — build one flat object.

  Object values may be the item/`self` itself, a field path on it, or a
  string, number, `true`/`false`/`null` literal — no nesting, no operators.
- `File` and `File[]` inputs are understood (see "Data inputs vs parameters"
  above); `Directory`, `secondaryFiles` and File `contents` are not.
- Each step's `run:` must be an **inline `class: Operation`** block (CWL's own
  concept for "an abstract, non-executable step") with its own `id` — that
  `id` becomes the OGC API Processes process identifier the Cook Orchestrator
  dispatches to. No separate `CommandLineTool`/`ExpressionTool`, no external
  tool files, no `$import`/`$include`.
- Every workflow `outputs` entry must declare `outputSource`.
- Steps may not form a cycle (checked via topological sort).

If you outgrow this subset (e.g. you need `scatter`, real `CommandLineTool`
execution, or multi-file recipes), `cwl_parser.py` is the one module that
needs to grow — nothing else in the stack depends on CWL internals directly.

### `POST /recipes/validate` checks structure only — not reachability

Validation parses the CWL and derives its schema/DAG. It **never** calls out
to any process — it cannot tell you whether a step's target service exists,
is reachable, or will actually accept the inputs you're sending. A recipe
that validates (and saves) successfully can still fail the first time it's
*executed* by the Cook Orchestrator. See the Cook Orchestrator's README for
exactly what happens at execution time and what a step must look like on the
wire to actually work.

### Editing the recipe to point a step at a different app

This is fully supported and is exactly what "editing the recipe" means here:
`POST /recipes` with the **same `id`** replaces the stored CWL in place (and
re-publishes its catalog entry) — there's no separate "new version" concept,
just upsert-by-id. What you change inside that CWL to redirect a step is not
gated by this registry at all beyond the structural rules above:

- Change the step's `run.id` to the new process's identifier, and (this is
  what actually controls where the Cook Orchestrator calls) set
  `run.nldt:processLink.internalHref` to the new process's base URL. There is
  **no allowlist check here** against this — `nldt:processLink` is read back
  completely at face value, whatever you write. For a process outside this
  stack, give `href` the same URL as `internalHref`.
- Only the separate, optional **`nldt:compatibleTools`** field (a per-step
  allowlist for the UI's *per-run* tool-swap picker) is restricted to a small
  hardcoded `TOOL_CATALOG` — that restriction has no bearing on directly
  hand-editing and saving the CWL text itself, only on that one UI picker.
- Reusing the same input/output names as before, on a step whose neighbors
  reference them, avoids also having to rewire those neighbors — but if the
  new tool's input/output names differ, you must also update whichever other
  steps' `in:` (or the workflow's own `outputs:`) referenced the old names.

See the Cook Orchestrator's README, section 3, for the full mechanics of URL
resolution and exactly what the new target process must do to actually
respond correctly.

### Other limitations

- **No versioning / history.** Saving overwrites the stored CWL; only recipes
  that shipped with a bundled `.cwl` file under `recipes/` have a fixed
  "original" to reset back to (`GET /recipes/{id}/original`) — a recipe
  registered purely at runtime has no such fallback.
- **No ownership or access control.** Any client that can reach this service
  can overwrite or delete any recipe by id — there is no authentication.
- **Tolerant of the Records Wrapper being down.** `POST`/`DELETE /recipes`
  always persist/remove the recipe locally first; if publishing/retracting
  the catalog entry fails, the response reports `catalog_published: false` /
  `catalog_retracted: false` plus the error, rather than losing the recipe
  itself over a transient network issue.
- **SQLite-backed.** Fine for a small, single-writer catalog; not intended
  for high concurrent write throughput.
