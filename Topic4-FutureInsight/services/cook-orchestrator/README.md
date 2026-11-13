# Cook Orchestrator Engine

## 1. What is it?

An **OGC API - Processes - Part 1: Core** service that exposes exactly **one**
process, `cook`. Given a `recipeId` and `parameters`, it:

1. Fetches that recipe's execution DAG from the **Cookbook API Registry**
   (`GET /recipes/{id}/dag`, or `POST /recipes/{id}/effective` when the
   request carries `toolOverrides`) — the step order, each step's OGC API
   Processes `process_id`, and how each step's inputs are wired (from the
   caller's parameters, or from a previous step's output).
2. Calls each step's tool **in dependency order** (independent steps in
   parallel, see "Parallel steps" below), over plain HTTP, exactly like any
   other OGC API Processes client would.
3. Pipes each step's declared output into whichever later step's input
   references it, and returns the recipe's final declared output(s) plus a
   step-by-step `trace`.

This is the whole "recipe execution" concept in the nLDT Sandbox Stack: a
recipe is not run by some special workflow engine — it is run by making
ordinary OGC API Processes `POST .../execution` calls, one per step, in the
order the CWL's wiring requires. See `../../DECISIONS.md`, D6, for how this
replaced OGC API Processes Part 3 (Workflows/Chaining).

Supports both **sync** execution (the answer comes back in the same HTTP
response) and **async** execution (`Prefer: respond-async` → `201` + a
`Location` header, backed by an in-memory job store you poll).

## 2. How to use it

### Run locally (no Docker)

```bash
cd services/cook-orchestrator
python -m venv .venv
. .venv/Scripts/activate   # Windows Git Bash; .venv/bin/activate elsewhere
pip install -r requirements.txt
COOKBOOK_URL=http://localhost:8002 \
TOOL_REGISTRY_JSON='{"add-two-numbers":"http://localhost:8010","multiply-two-numbers":"http://localhost:8011"}' \
  uvicorn app.main:app --reload --port 8003
```

`TOOL_REGISTRY_JSON` only applies to steps without a process link. The
bundled recipes' steps all carry an `nldt:processLink.internalHref`, which
wins (see section 3), and for this stack's own tools that points at a Docker
service name (`http://tool-add:8000/...`) that a process outside Docker
cannot resolve. To run those recipes end to end, use Docker Compose.

### Run with Docker Compose

From the repo root: `docker compose up --build` brings up the whole stack,
this service on port **8003**. With the gateway overlay
(`docker-compose.gateway.yml`) it is served at `/api/orchestrator` instead
(started with `uvicorn --root-path /api/orchestrator`, so the links it writes
carry that prefix), e.g. `https://nldt-tb2.clearly.app/api/orchestrator/`.

Settings, all environment variables: `COOKBOOK_URL` (the Cookbook API
Registry, default `http://cookbook-registry:8000`), `TOOL_REGISTRY_JSON` and
`LOCATION_REWRITES` (see section 3), and the time limits in "Async steps,
time limits and cancelling".

### Endpoints

| Method | Path | What it does |
|---|---|---|
| GET | `/` | Landing page (links to the OpenAPI document `/openapi.json` and its HTML view `/docs`) |
| GET | `/conformance` | Declared conformance classes: Part 1 `core`, `json`, `oas30`, `job-list`, `dismiss` |
| GET | `/processes` | Process list (always just `cook`) |
| GET | `/processes/cook` | Process description (its `recipeId`/`parameters`/`toolOverrides` inputs) |
| POST | `/processes/cook/execution` | Execute a recipe — sync by default |
| GET | `/jobs` | List all jobs this orchestrator instance has run |
| GET | `/jobs/{jobId}` | Job status (`accepted`/`running`/`successful`/`failed`/`dismissed`) |
| GET | `/jobs/{jobId}/results` | Job result, once `successful`; before that `404` (`result-not-ready`), and for a failed job `500` with its error |
| DELETE | `/jobs/{jobId}` | Dismiss a job |

Errors follow OGC API Processes' exception format: `{"type", "title", "status", "detail"}`, with OGC's own `type` URIs for `no-such-process`, `no-such-job` and `result-not-ready`. Checked with OGC's official test suite (TEAM Engine, `ets-ogcapi-processes10` 1.3); the only failures left are its execute tests, which expect OGC's `echo` test process.

### Try it (once the Cookbook Registry has the demo recipe and both tool services are up)

```bash
# synchronous execution: (2 + 3) * 4 = 20
curl -s -X POST http://localhost:8003/processes/cook/execution \
  -H "Content-Type: application/json" \
  -d '{"inputs":{"recipeId":"recipe-add-multiply-demo","parameters":{"a":2,"b":3,"c":4}}}'
# -> {"result": {"result": 20.0}, "trace": [...]}
#    `result` holds the recipe's workflow outputs by id; `trace` has one entry
#    per step: {step, label, process_id, resolved_via, inputs, outputs}

# asynchronous execution (201 Created, Location: http://localhost:8003/jobs/<jobId>)
curl -s -i -X POST http://localhost:8003/processes/cook/execution \
  -H "Content-Type: application/json" -H "Prefer: respond-async" \
  -d '{"inputs":{"recipeId":"recipe-add-multiply-demo","parameters":{"a":10,"b":5,"c":2}}}'
# then poll the Location header's URL, e.g.:
curl -s http://localhost:8003/jobs/<jobId>
curl -s http://localhost:8003/jobs/<jobId>/results
```

`inputs.toolOverrides` (optional, `{stepId: toolId}`) runs a per-request,
non-persisted substitution of one or more steps' tools — see "Two separate
substitution mechanisms" below.

## 3. Limitations, and pointing a step at a different process

**Editing a recipe so that a step calls a different process works, if you
point the edited step at its new process correctly and that process behaves
the way this orchestrator expects on the wire. Both conditions are explained
below.**

### How a step's process URL is actually resolved

For each DAG step, `app/engine.py::_execution_url()` decides where to `POST`,
in this order:

1. **The step's own `run.nldt:processLink.internalHref`**, if the recipe's CWL
   declares one (a custom, non-standard field — see the Cookbook Registry's
   README). The orchestrator calls `POST {internalHref}/execution` directly.
   Nothing else about that step matters for URL resolution — not its
   `run.id`, not any registry.
2. Otherwise, the step's `run.id` is looked up in **`TOOL_REGISTRY`** — a
   static, hardcoded `{process_id: base_url}` map, seeded from
   `_DEFAULT_TOOL_REGISTRY` in `app/engine.py` and extendable via the
   `TOOL_REGISTRY_JSON` environment variable at container start. If the id
   isn't in there either, execution fails with `400 No tool service
   registered for process '<id>'`.

So: **editing the recipe's CWL to add/change a step's
`run.nldt:processLink.internalHref` to `http://example.com/processes/app` is
enough by itself** — no code change, no registry update, no redeploy of the
Cook Orchestrator. Saving that edited CWL through the Cookbook Registry (same
recipe `id` → it's upserted in place) is exactly "editing the one existing
recipe." The alternative path — relying on `TOOL_REGISTRY` instead of a link —
*does* require a config change (`TOOL_REGISTRY_JSON`) and a restart, since
that map is only read once, at process start.

Set `internalHref` to the process's own address (`.../processes/app`): the
orchestrator appends `/execution` itself (a link that already ends in
`/execution` is accepted too). So `internalHref:
http://example.com/processes/app` makes it call `POST
http://example.com/processes/app/execution`. For a process outside this
stack, set `href` to the same URL as `internalHref`; that is how the Cook
tells an external process from one of this stack's own (see
`LOCATION_REWRITES` below).

### What the target process must do, to actually work

Whatever URL is resolved, the orchestrator does exactly this (`engine.call_tool`):

```
POST {url}/execution
Content-Type: application/json
Prefer: respond-async
{"inputs": {<resolved input values, by name>}}
```

and accepts either answer OGC API Processes Part 1: Core allows:

- **sync** — HTTP `200` with the results right away, or
- **async** — HTTP `201`/`202` with a job (`Location` header, or a status
  body with a `self`/`monitor` link or `jobID`; a relative job address is
  resolved against the process's URL), which is then polled until it's
  `successful` and its results fetched (see "Async steps, time limits and
  cancelling" below).

The results may be `{"outputs": {<name>: <value>, ...}}` (this stack's own
tool services), a standard results document (`{<name>: <value>}` or
`{<name>: {"value": ...}}`), ZOO-Project's multipart text for several
outputs, or — for a process with one output — the bare value. The output names must match whatever the DAG's wiring expects (the
step's own `out:` list, and any later step's `in:` or the workflow's
`outputs:` that reference `thisStep/thatOutputName`).

Nothing about this is recipe- or CWL-specific from the target process's
point of view: any OGC API Processes server can be a recipe step.

### What will *not* work / is not supported

- **Authentication.** There's no way to attach an API key, bearer token, or
  client certificate per step. Only unauthenticated endpoints work.
- **Rich OGC API Processes input/output encodings.** No bbox inputs, no
  content negotiation beyond the CWL `format`s below. By-reference inputs
  are only produced from a recipe's data inputs (CWL Files, see below); an
  `{"href": ...}` *output* is passed on as-is, never dereferenced. Complex
  input/output validation is entirely the target process's own problem, not
  something this orchestrator checks.
- **Retries.** There is no retry or circuit-breaking — one failed step call
  fails the whole recipe execution (surfaced as `400` from
  `/processes/cook/execution`, or a `failed` job on the async path).

- **No reachability check at save/validate time.** The Cookbook Registry's
  `POST /recipes/validate` (and `POST /recipes`) only check that the CWL
  *parses* — they never call the target process. A recipe can validate and
  save successfully and still fail the first time it's actually executed,
  if the URL is wrong, unreachable, or returns an unexpected shape.
- **No SSRF protection.** Whatever URL ends up in `internalHref` (or
  `TOOL_REGISTRY`) is called directly by the orchestrator process at
  execution time — treat this as an open trust boundary, appropriate for a
  no-auth sandbox, not for a deployment exposed to untrusted recipe authors.

### Parallel steps

A step starts as soon as every step it takes input from has finished, so
steps that don't depend on each other run at the same time (at most
`COOK_MAX_PARALLEL`); a plain chain still runs one step after another. If one
step fails, the steps still running alongside it are stopped (their remote
jobs dismissed) and the run fails with that first error.

### Input and output formats

A CWL `format` on a step's `run.inputs` / `run.outputs` entry (conventionally
`iana:<media type>`, with `$namespaces: {iana:
https://www.iana.org/assignments/media-types/}`) changes what is sent:

- an **input** with a format is sent as an OGC qualified value,
  `{"value": ..., "mediaType": "<format>"}` (unless it already is one, or a
  `{"href": ...}` link) — e.g. a GeoJSON geometry for a process that also
  accepts GML;
- an **output** with a format is requested in it, via the execute request's
  `outputs: {<name>: {"format": {"mediaType": "<format>"}}}`.

Without any formats the execute request is plain `{"inputs": {...}}`. See
`../cookbook-registry/recipes/playground-2.cwl` for both (its `centroid` and
`area` steps), against Geonovum's ZOO-Project testbed server.

### Data inputs: CWL Files, sent by reference

A recipe's data inputs are CWL `File` workflow inputs (see
`../cookbook-registry/README.md`, "Data inputs vs parameters"). The caller
passes each as a reference, never the data itself:

```json
"parameters": {
  "geometry": {"class": "File",
               "location": "https://nldt-tb2.clearly.app/api/hub/datasets/ds-pdok-rotterdam-boundary/resources/res-pdok-rotterdam-outline/data",
               "format": "https://www.iana.org/assignments/media-types/application/geo+json"},
  "bufferDistance": 250
}
```

After a step input is resolved (and any `valueFrom` applied), a File value —
or a list of them — is handed to the process as an OGC API Processes
by-reference input, and the **process fetches the data itself**:

```json
{"inputs": {"geometry": {"href": "http://hub-datasets:8000/datasets/.../data", "type": "application/geo+json"}, "distance": 250}}
```

- `type` is the step's own declared input `format` (what the process says it
  accepts) if any, else the File's own `format`, else omitted.
- A `valueFrom` sees the File itself (`self.location`, ...): a recipe uses an
  object template to hand a process the data in that process's own shape —
  e.g. roofer's `[{"kind": "url", "url": ...}]` — and such a reshaped value
  is sent as-is, not as a reference.
- **`LOCATION_REWRITES`** — a File's `location` is the URL the *browser*
  used to reach the data (a published port, or the gateway's public origin),
  which a container can't always reach. For this stack's own tools (a step
  whose `nldt:processLink` has an `internalHref` different from its `href`, or
  no link at all) the Cook swaps a matching public prefix for an internal
  one, longest prefix first: env `LOCATION_REWRITES`, a JSON object
  `{"<public prefix>": "<internal prefix>"}`. docker-compose.yml sets it for
  hub-datasets' published port, the gateway overlay for its public
  `/api/hub` origin. External processes always get the public URL, so the
  data must be reachable from the internet for them.
- The step's `trace` shows the inputs exactly as sent — the reference, not
  the File.
- A tool fetching a reference does so within the execute request, so
  docker-compose.yml raises `TOOL_REQUEST_TIMEOUT` to 90s for synchronous
  tools.

### Async steps, time limits and cancelling

Every step is requested with `Prefer: respond-async`. A process that answers
`200` with its result (this stack's own tool services) is used as-is; one that
answers `201`/`202` with a job is polled until it finishes, then its results
are fetched — accepting both `{"outputs": {...}}` and a standard results
document. Limits, all environment variables on this service:

| Variable | Default | Limits |
|---|---|---|
| `TOOL_REQUEST_TIMEOUT` | `10` s | each single HTTP call to a tool |
| `TOOL_JOB_TIMEOUT` | `300` s | how long one step's remote job may run |
| `COOK_TIMEOUT` | `900` s | one whole recipe run, all steps together |
| `TOOL_JOB_POLL_INTERVAL` | `2` s | how often a remote job is polled |
| `COOK_MAX_PARALLEL` | `4` | how many independent steps may run at the same time |

`DELETE /jobs/{jobId}` cancels a running cook job: the engine stops within one
poll interval (or before the next step), and dismisses the step's remote job
too (`DELETE` on its job URL, best effort). A step that hits
`TOOL_JOB_TIMEOUT` or `COOK_TIMEOUT` is dismissed remotely the same way.

A job's status document (`GET /jobs/{jobId}`) carries, besides the standard
`status`/`progress`/`message`, a `steps` list — one entry per recipe step:
`{id, label, processId, status, remoteStatus, remoteProgress, message, errorSource}`,
where `status` goes `pending` → the remote job's `accepted`/`running` →
`successful` / `failed` / `dismissed`.

A failed job (and a failed step) also carries `errorSource` — where the error
came from, so a caller can tell the Cook's own failures from a tool's:
`{source, processId?, url?, step?, stepLabel?}`, with `source` one of `cook`
(this orchestrator: a missing parameter, a time limit, a bug), `registry`
(the Cookbook API Registry) or `tool` (the step's OGC API Process answered
with an error, its job failed or timed out, or it couldn't be reached).

### Two separate substitution mechanisms — don't conflate them

- **Hand-editing the CWL's `run.nldt:processLink`** (above) is unrestricted:
  point a step at any process you want, by editing text and saving.
- **`toolOverrides`** (picked in the UI's recipe Wizard, Tool & Engine step,
  and sent as `POST /processes/cook/execution`'s `toolOverrides` input, which
  the Cook applies through the registry's `POST /recipes/{id}/effective`) is a
  *narrower*, non-persisted, per-run substitution restricted to a small
  hardcoded `TOOL_CATALOG` in the Cookbook Registry, further gated per-recipe
  by an `nldt:compatibleTools` allowlist (edited under a step's "Alternative
  tools" in the Orchestrator editor). It cannot target an arbitrary
  external URL — only tools the registry already knows about. Wiring in a
  genuinely new external process always means editing the CWL text directly,
  not this picker.

### Other limitations

- **Jobs are in-memory only.** An orchestrator restart loses all job history
  and any in-flight job — there is no persistence (see `../../DECISIONS.md`,
  "Open items").
- **Implements OGC API Processes Part 1: Core (v1.0)**, not the Part 3
  Workflows/Chaining draft — chaining is achieved entirely via the CWL-derived
  DAG described above, which is a deliberate, spec-legitimate substitution
  (see `../../DECISIONS.md`, D6).
