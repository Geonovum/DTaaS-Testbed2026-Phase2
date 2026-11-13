# Tool Service (generic numeric operation)

## 1. What is it?

The smallest possible **OGC API - Processes - Part 1: Core** service — a
"leaf" tool that a recipe's step actually calls to do real work. It is **one
codebase**, instantiated multiple times (once per docker-compose service:
`tool-add`, `tool-multiply`, `tool-multiply3`), with each instance's identity
and behavior selected entirely by environment variables:

- `PROCESS_ID` (required) — the OGC API Processes process id this instance
  serves. Must match whatever a recipe step's `run.id` (and, if used, its
  `run.nldt:processLink`) names, for that step to resolve to this service.
- `PROCESS_TITLE` — human-readable title, shown in its self-description.
  Defaults to `PROCESS_ID`.
- `OPERATION` (required) — `add`, `multiply`, or `multiply3` — selects the
  input/output names and the actual computation. Any other value stops the
  service at startup.

This is deliberately the one place in the whole stack allowed to stay this
simple (see `../../DECISIONS.md`, D1) — it exists to be an
interchangeable, disposable example of
"some real OGC API Process a recipe step calls," not a demonstration of everything OGC API Processes can do. A
production recipe step would call a real, independently-built process
service — possibly nothing like this one internally — as long as it honors
the same execution contract (see Limitations, and the Cook Orchestrator's
README).

## 2. How to use it

### Run locally (no Docker)

```bash
cd services/tool-service
python -m venv .venv
. .venv/Scripts/activate   # Windows Git Bash; use .venv/bin/activate on macOS/Linux
pip install -r requirements.txt
PROCESS_ID=add-two-numbers PROCESS_TITLE="Add two numbers" OPERATION=add \
  uvicorn app.main:app --reload --port 8010
```

In Docker Compose the three instances are published on ports 8010-8012 (see
the table below); behind the single-origin gateway (`docker-compose.gateway.yml`) the three instances are
served at `/api/tools/add`, `/api/tools/multiply` and `/api/tools/multiply3`,
each started with `uvicorn --root-path` so the links it returns carry that
prefix.

### Endpoints

| Method | Path | What it does |
|---|---|---|
| GET | `/` | Landing page (links to conformance, processes, and the OpenAPI document as `service-desc` / `service-doc`) |
| GET | `/conformance` | Declared conformance classes (`core`, `json`, `oas30`) |
| GET | `/processes` | List (always one entry: this instance's `PROCESS_ID`) |
| GET | `/processes/{processId}` | Process description (its inputs/outputs) |
| POST | `/processes/{processId}/execution` | Synchronous execution → `{"outputs": {...}}` |
| GET | `/jobs` | Always an empty job list (`{"jobs": [], ...}`): execution is synchronous, so there are never jobs |
| GET | `/openapi.json`, `/docs` | OpenAPI document and its HTML view (FastAPI) |

Errors are OGC API Processes exception documents,
`{"type", "title", "status", "detail"}`: `404` with type
`.../ogcapi-processes-1/1.0/no-such-process` for an unknown process id, `400`
for a missing or non-numeric input or a malformed request body.

### Try it

```bash
curl -s http://localhost:8010/processes/add-two-numbers
curl -s -X POST http://localhost:8010/processes/add-two-numbers/execution \
  -H "Content-Type: application/json" -d '{"inputs":{"a":2,"b":3}}'
# -> {"outputs":{"sum":5.0}}
```

The three configured instances in `docker-compose.yml` and their operations:

| Service | Host port | `PROCESS_ID` | Inputs | Output |
|---|---|---|---|---|
| `tool-add` | 8010 | `add-two-numbers` | `a`, `b` | `sum` |
| `tool-multiply` | 8011 | `multiply-two-numbers` | `x`, `y` | `product` |
| `tool-multiply3` | 8012 | `multiply-three-numbers` | `x`, `y`, `z` | `product` |

## 3. Limitations

- **Synchronous execution only** (`jobControlOptions: ["sync-execute"]`) — no
  async path; `/jobs` exists only to answer with an empty list, and there is
  no `/jobs/{jobId}`. That's appropriate for a computation this trivial; job
  management for a whole recipe is the Cook Orchestrator's job, not each leaf
  tool's.
- **Only three hardcoded operations** (`add`/`multiply`/`multiply3`), defined
  in a Python dict (`OPERATIONS` in `app/main.py`). Adding a new kind of
  computation means editing that dict and rebuilding the image — it is *not*
  something you can configure purely via environment variables (only which
  *existing* operation an instance runs, and its process id/title, is
  env-configurable).
- **Scalar numeric inputs/outputs only.** Every declared input is coerced via
  `float()`; there is no support for complex types, arrays, geometries, or
  file/reference inputs. A non-numeric input returns `400`.
- **No authentication.** Any client that can reach the base URL can invoke
  the process — matches the rest of the stack's no-auth, open-CORS sandbox
  posture (see `../../DECISIONS.md`, D11).
- **Minimal validation.** Only presence and number-coercion are checked — no
  range/domain checks. Inputs not in the process description are ignored.
- **Not a template to imitate for real processes.** A genuinely useful OGC
  API Process a recipe wants to call does not need to resemble this
  service's internals at all — it only needs to satisfy the wire contract at
  `POST {baseUrl}/processes/{id}/execution` that the Cook Orchestrator
  expects of every step (JSON `{"inputs": {...}}` in; a synchronous result or
  an async job out) — see `../cook-orchestrator/README.md`, section 3, for
  that contract and its own limits (no auth, no retries, time limits, etc.).
