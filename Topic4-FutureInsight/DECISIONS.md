# Decision log — nLDT Sandbox Stack (Geonovum Testbed 2026, Research Topic #4)

The decisions that shaped this stack, oldest first. Each entry says what was decided,
why, and what followed from it. A decision is never edited after the fact: when one
was changed, a later entry says so and the earlier one is marked **Superseded**.

How each component works today is described in the READMEs (the root
[`README.md`](README.md) and one per service). The final report's Appendix A
summarises this log.

Entries are numbered (D1, D2, …) so that code comments and READMEs can refer to them.

| # | Date (2026) | Decision | Status |
|---|---|---|---|
| D1 | 8 Sep | The infrastructure is the real system; only the apps may stay trivial | Standing |
| D2 | 8 Sep | Start with the smallest recipe that exercises the whole chain: (a + b) × c | Standing |
| D3 | 8 Sep | CWL as the recipe format | Standing |
| D4 | 8 Sep | Each step is an inline CWL `Operation`, one per OGC API Process | Standing |
| D5 | 8 Sep | Recipes are read by a purpose-built parser, not a general CWL engine | Standing |
| D6 | 8 Sep | OGC API Processes Part 1: Core 1.0; chaining is done by CWL inside the Cook | Standing |
| D7 | 8 Sep | The Cook is itself an OGC API Process, `cook` | Standing |
| D8 | 8 Sep | Python and FastAPI for every service | Standing |
| D9 | 8 Sep | The Registry owns the recipe; the catalogue only describes it | Standing |
| D10 | 8 Sep | Recipes carry their own process link; a static table is only a fallback | Standing |
| D11 | 8 Sep | Open CORS and no authentication: a sandbox, by design | Standing |
| D12 | 8 Sep | Validation is a gate: validate before Save, re-validate on Save | Standing |
| D13 | 9 Sep | Shared playground recipe slots instead of a recipe-creation UI | Standing |
| D14 | 8 Sep → 10 Sep | Catalogue backend: real CKAN 2.11 behind the Records Wrapper | Standing (supersedes a purpose-built store) |
| D15 | Sep–Oct | The Cook always asks for asynchronous execution; independent steps run in parallel | Standing |
| D16 | 16 Oct | In the editor, the CWL text is the single source of truth | Standing |
| D17 | 22 Oct | One public address behind a gateway; the UI also on GitHub Pages | Standing |
| D18 | 22 Oct | The repository contains only the testbed | Standing |
| D19 | 22 Oct | Data ingredients are declared with standard CWL `File` + `format`, passed by reference | Standing |
| D20 | 22 Oct | Process-specific input shapes are handled in the recipe with `valueFrom` | Standing |
| D21 | 22 Oct | `nldt:jsonSchema`: an optional bridge for parameters CWL cannot describe | Standing |
| D22 | 22 Oct | Extension fields live in a declared `nldt:` namespace | Standing |
| D23 | 22 Oct | The point-cloud sample is a 1.2 MB crop of real AHN3 data | Standing |
| D24 | 27 Oct | A failed run says whose failure it is | Standing |
| D25 | 27 Oct | Remote job addresses are resolved against the process's own address | Standing |
| D26 | 28 Oct | One naming rule: an app by its Operation label, a step by its step label | Standing |
| D27 | 28 Oct | The parameter form is completed from each app's process description | Standing |
| D28 | 28 Oct | The services are tested with OGC's official test suite, and fixed | Standing |
| D29 | 28 Oct | `internalHref` is a deployment detail in the recipe; we recommend dropping it | Open |
| D30 | 28 Oct | Authentication, delegated access and pricing are the main gaps to real use | Open |

Open items that are not decisions are listed at the end.

---

## D1 · 8 Sep — The infrastructure is the real system; only the apps may stay trivial

**Decision.** The Records Wrapper, Cookbook Registry and Cook Orchestrator are built as
the real system, standards-conformant and meant to last, not as a mock-up to be thrown
away. Only the apps a recipe calls (our own numeric and buffer tools) may stay
deliberately simple.

**Why.** The infrastructure is the deliverable. The apps are interchangeable by design:
that is the point of a recipe architecture.

## D2 · 8 Sep — Start with the smallest recipe that exercises the whole chain

**Decision.** The first recipe is `recipe-add-multiply-demo`: add two numbers, then
multiply the sum by a third, `(a + b) × c`.

**Why.** It is the smallest recipe that still exercises the whole chain: discovery in the
catalogue, retrieving the recipe, parameters, two steps, one step's output piped into the
next, and the result. The plumbing was proven on it before real geodata and external
processes were added (`recipe-rotterdam-buffer-demo` and the playground recipes, D13).

## D3 · 8 Sep — CWL as the recipe format

**Decision.** Recipes are written in the Common Workflow Language (CWL v1.2), one of the
options the tender names, rather than Arazzo or a format of our own.

**Why.** CWL is a mature, externally governed standard for composing a workflow from
discrete steps, which is what a recipe is. A format of our own would need its own tooling
and governance.

**Consequence.** CWL describes what to run, not where, and its type system is weaker than
JSON Schema. We added three extension fields for these gaps (D10, D21, D22).

## D4 · 8 Sep — Each step is an inline CWL `Operation`, one per OGC API Process

**Decision.** A recipe is a CWL `Workflow` whose steps each `run` an inline
`class: Operation`, CWL's own abstract, non-executable step. The Operation's `id` is the
OGC API Process identifier.

**Why.** `Operation` is CWL's own concept for "a step that runs somewhere else", which is
exactly what every recipe step is. Using its `id` needs no extension field.

## D5 · 8 Sep — Recipes are read by a purpose-built parser, not a general CWL engine

**Decision.** The Cookbook Registry reads recipes with its own parser
(`services/cookbook-registry/app/cwl_parser.py`), which understands the CWL our recipes
use: a single-document `Workflow`, mapping-form `steps` and `in`, inline `Operation`
steps. It derives the recipe's input JSON Schema and its execution DAG.

**Why.** We only need to read a recipe's structure, not run arbitrary CWL. A general CWL
engine would be a large, mostly unused dependency for a small service.

**Consequences.** Unsupported features are rejected (for example `CommandLineTool`
steps) or ignored (`scatter`, `when`, `$import`). CWL expressions are JavaScript; the
parser recognises a fixed set of `valueFrom` patterns and never executes JavaScript
(D20). The parser checks structure and wiring, not types: the reference validator,
`cwltool --validate`, later caught a type error it had accepted (D22).

## D6 · 8 Sep — OGC API Processes Part 1: Core 1.0; chaining is done by CWL inside the Cook

**Decision.** The Cook and our tools implement OGC API - Processes - Part 1: Core,
version 1.0. Chaining is not done with Part 3 (Workflows) nested execution: the Cook
reads the recipe's DAG and calls each step's process itself.

**Why.** We first intended v2.0 with Part 3, since the tender encourages v2 and Part 3 is
about chaining. Part 3 is a draft whose conformance classes we could not verify; Part 1
is stable. CWL already describes the chain, and nothing in Part 1 restricts what a
process does internally.

## D7 · 8 Sep — The Cook is itself an OGC API Process, `cook`

**Decision.** The Cook Orchestrator is an OGC API Processes service with one process,
`cook`, which takes a recipe id, parameters and optional app swaps. It reads the recipe's
plan from the Registry fresh on every run.

**Why.** Any OGC API Processes client can then run any recipe without knowing CWL, and a
newly saved recipe needs no redeployment.

**Consequence.** A recipe never appears as a process of its own, with its own typed
inputs: clients only see `cook`.

## D8 · 8 Sep — Python and FastAPI for every service

**Decision.** All backend services are written in Python with FastAPI and Pydantic.

**Why.** One consistent stack, and FastAPI generates an OpenAPI document from the code,
which both OGC APIs rely on.

**Consequence, found later.** FastAPI generates OpenAPI 3.1, while the services declare
the `oas30` conformance class. Geonovum's OGC checker accepts only OpenAPI 3.0 and could
not read our documents (final report, section 10). Serving a 3.0 document is a
recommendation, not yet done.

## D9 · 8 Sep — The Registry owns the recipe; the catalogue only describes it

**Decision.** The Cookbook Registry stores each recipe's CWL and is its single source.
The catalogue (Records Wrapper) holds a record with discovery metadata and a link to the
CWL. Saving a recipe stores it first, then publishes its record; if the catalogue is
unreachable, the recipe is still stored and the answer says `catalog_published: false`
with the error. Deleting works the same way.

**Why.** The two are separate services. One being briefly unreachable must not lose a
recipe, and a recipe that is stored but not yet published is a visible, recoverable
state, not a silent inconsistency.

**Consequence.** The Registry derives a recipe's schema and DAG fresh on every request
and never caches them, so every client sees the recipe as it is stored at that moment.

## D10 · 8 Sep — Recipes carry their own process link; a static table is only a fallback

**Decision.** A step's `run` may carry a process link, today `nldt:processLink`
(D22): `{rel, type, href, internalHref}`. The Cook calls `internalHref`; `href` is the
public address for people reading the recipe. A static table in the Cook
(`TOOL_REGISTRY`, extendable with `TOOL_REGISTRY_JSON`) is used only for a step without a
link. There is no discovery service.

**Why.** At first the Cook looked every process up in the static table, so every new app
meant a code change. With the link in the recipe, a recipe can call any OGC API Process,
ours or another party's.

**Evidence.** With the link in place, we replaced the multiply step's process with a
divide process through the UI, without changing any code: `(2 + 3) / 4 = 1.25`, with the
trace showing the new process was called. (The divide tool was later replaced by
`multiply-three-numbers`, which the Wizard now offers as a swap.)

**See also** D29: the second address, `internalHref`, turned out to be a deployment
detail that should not be in the recipe.

## D11 · 8 Sep — Open CORS and no authentication: a sandbox, by design

**Decision.** Every service allows all origins, methods and headers, and nothing needs a
login.

**Why.** The browser-based UI calls the services directly, from any origin (GitHub
Pages, a local server). This is a sandbox for a testbed, and authentication was out of
scope. It is not suitable for a deployment with real users: see D30.

## D12 · 8 Sep — Validation is a gate: validate before Save, re-validate on Save

**Decision.** The Registry has a check-only endpoint, `POST /recipes/validate`, which
always answers 200 with `valid: true` or `false` and stores nothing. In the editor, Save
is enabled only after a successful Validate, and editing the text disables it again.
`POST /recipes` re-validates on the server, and nothing is stored unless a DAG can be
built. A Reset button reloads the recipe's bundled original
(`GET /recipes/{id}/original`) into the editor, without saving.

**Why.** A recipe that cannot be turned into a plan must never be stored, and authors
need an explicit check before saving rather than a failed save.

## D13 · 9 Sep — Shared playground recipe slots instead of a recipe-creation UI

**Decision.** For the plugfests, three bundled recipe slots (`playground-1` to `-3`)
were added that anyone can open, edit, validate, save and run, instead of building a
"new recipe" flow.

**Why.** Every mechanism participants needed already existed (edit, validate, save, run
against any OGC API Process). The only gap was not enough recipes to hand out.

**Consequences.** Anyone can overwrite a slot, and there is no ownership or version
history (finding 21 in the final report). Reset and re-seeding bring a slot back to its
bundled version. The slots now hold the roofer pipeline, the Geolabs ZOO-Project sampler
and Varidian's subsidence analysis.

## D14 · 8 Sep → 10 Sep — Catalogue backend: real CKAN 2.11 behind the Records Wrapper

**First decision (8 Sep), superseded.** The Records Wrapper stored its records itself, in
SQLite, behind a small repository interface.

**Decision (10 Sep).** The Records Wrapper stores its records in a real CKAN 2.11
instance (with its own Postgres, Solr and Redis) and translates OGC API Records requests
into CKAN Action API calls.

**Why.** The tender's architecture names CKAN as the catalogue's store, and a wrapper in
front of a real catalogue is closer to how a hub would actually run. The switch touched
only the wrapper's repository module (`app/repository.py`): its API and its clients did
not change, which confirmed the design.

**Lessons from running CKAN.**
- The `ckan-base` 2.9 and 2.10 images ship a uWSGI without plugins and fail to start;
  2.11 works.
- CKAN's environment variables do not configure it early enough for its own database
  setup, so the compose file writes the settings into `ckan.ini` with
  `ckan config-tool` before CKAN starts.
- CKAN initialises its datastore even when the plugin is not listed, so it needs a real
  database (`services/ckan/postgres-init`).
- CKAN soft-deletes packages, so re-publishing a deleted id must revive it rather than
  create it.
- CKAN already has a `type` field; our record type is stored as the extra
  `record_type`.

**Consequence.** CKAN needs an API token and an owning organisation before the wrapper
can write, and both can only be created once CKAN runs. A one-time script,
`services/records-wrapper/scripts/bootstrap_ckan.py`, creates them.

## D15 · Sep–Oct — The Cook always asks for asynchronous execution; independent steps run in parallel

**Decision.** The Cook calls every step's process with `Prefer: respond-async`. A process
that answers at once is used as is; one that returns a job is followed until it is done
(polled every 2 seconds), its progress shown in the step's status. Steps whose inputs are
ready start at once, at most four at a time (`COOK_MAX_PARALLEL`), so independent steps
run in parallel. For its own callers, the Cook supports both synchronous and asynchronous
execution; the App Store UI always uses asynchronous execution.

**Why.** The first roofer recipe (28 Sep) failed on a 10-second synchronous timeout:
real processes outlive any HTTP or proxy timeout, so asynchronous execution is
mandatory in practice (finding 12 in the final report). The same attempt showed that the
Cook cannot pass credentials to a process, the first sign of the access problem in D30.

**Consequence.** The Cook's job store is in memory, so a restart loses its jobs.

## D16 · 16 Oct — In the editor, the CWL text is the single source of truth

**Decision.** The recipe editor shows the CWL text and a diagram side by side, kept in
sync. A guided builder is an optional help: it adds a process from its URL and generates
the step from the process description. Nothing is wired automatically.

**Why.** We first made the guided builder the default, but people arrive with CWL to
paste, and automatic wiring connects things behind their backs. The builder answers the
first plugfest's main usability finding: writing a recipe required knowing how we had
structured the CWL.

**Consequence.** The editor displays `valueFrom` reshaping but does not write it; that is
still done in the text.

## D17 · 22 Oct — One public address behind a gateway; the UI also on GitHub Pages

**Decision.** The deployed stack serves everything under one address,
`https://nldt-tb2.clearly.app`, through an nginx gateway: the UI at `/`, each service
under `/api/<service>` (`docker-compose.gateway.yml`, `deploy/`). The UI is also
published on GitHub Pages, calling the same services.

**Why.** Cloudflare's proxy forwards only a fixed list of ports, so per-service ports
could not work behind TLS. The UI has no server logic and can run anywhere.

**Consequence, found on 28 Oct.** Behind the gateway, the services built links without
their `/api/<service>` prefix and with `http`. Fixed by starting each service with its
public prefix (`uvicorn --root-path`) and trusting the gateway's forwarded headers
(D28).

## D18 · 22 Oct — The repository contains only the testbed

**Decision.** The code moved to its own repository for the testbed, and everything that
was not the nLDT Sandbox Stack was removed: earlier demo environments, mock-only flows
(vendor binding, semantic alignment, partner pricing) and fixture data. The UI always
shows the live stack; `UI/data/` keeps only what has no backend API (the hub, its
participants, and a fallback description of the results dataset).

**Why.** The deliverable should show what the testbed actually demonstrates, and nothing
that only ever existed as a mock-up.

## D19 · 22 Oct — Data ingredients are declared with standard CWL `File` + `format`, passed by reference

**Decision.** A recipe declares a data input with CWL's own type for data, `type: File`
(or `File[]`), plus a `format` (a media type). Every other input is a parameter. The
Wizard offers only datasets of a matching media type and sends a CWL File, a link to the
data; the Cook hands it to the process as an OGC by-reference input,
`{"href": …, "type": …}`, and the process fetches the data itself.

**Why.**
- Before, the UI knew a recipe's data inputs from a list hard-coded per recipe, so a
  recipe saved in a playground slot could never have one: the roofer recipe looked as if
  it ran without data.
- A new extension field would duplicate a concept CWL already has.
- Inferring data inputs from process descriptions is impossible: they do not say
  machine-readably that an input is a dataset (roofer says so only in prose; finding 11
  in the final report).
- `File` + `format` is standard CWL and maps one-to-one onto OGC by-reference inputs.

**Consequences.**
- Data must be reachable from the process, not only from the browser. External
  processes receive the public Hub Datasets address, so Hub Datasets is publicly
  reachable. Only for our own tools does the Cook rewrite that address to the internal
  network (`LOCATION_REWRITES`).
- LAZ has no IANA-registered media type; we use the common `application/vnd.laszip`.

## D20 · 22 Oct — Process-specific input shapes are handled in the recipe with `valueFrom`

**Decision.** When a process wants an input in its own shape (roofer wants
`[{"kind": "url", "url": …}]` rather than an OGC `href`, and the id fields of earlier
steps' results), the recipe reshapes it with standard CWL `valueFrom`. The Cook
recognises four patterns (a field path, a map picking a field, a map building an object,
and an object template) and never runs JavaScript.

**Why.** The adaptation belongs to the recipe that uses the process, not to the Cook.
CWL expressions are JavaScript; a small cook either embeds a JavaScript engine or, like
ours, supports a subset (finding 5 in the final report).

## D21 · 22 Oct — `nldt:jsonSchema`: an optional bridge for parameters CWL cannot describe

**Decision.** A recipe input uses its CWL type wherever that is precise enough, and the
Registry derives its JSON Schema. Only where CWL cannot express the process's input
(`oneOf`, `const`, `pattern`, value limits) does the input carry the process's own JSON
Schema in `nldt:jsonSchema`, which the Registry publishes instead. It is descriptive
only: the client builds its form from it; the Cook does not validate against it.

**Why.** Every OGC API Process describes its inputs in JSON Schema; CWL has its own,
weaker type system. Roofer is the process with the richest inputs, but any process with
structured inputs needs the same bridge.

**Consequence.** The schema is a copy pasted from the process description and goes stale
if the process changes. D27 removes most of the need for it.

## D22 · 22 Oct — Extension fields live in a declared `nldt:` namespace

**Decision.** Our three extension fields are named in our own namespace, declared in
every recipe (`nldt: https://fi-group.github.io/nldt-tb2/ns#`): `nldt:processLink`,
`nldt:compatibleTools` and `nldt:jsonSchema`. They were first named with the OpenAPI
convention (`x-process-link`, `x-compatible-tools`, `x-json-schema`); a recipe using the
old names is now rejected with an error naming the replacement.

**Why.** CWL allows extension fields only with a prefix declared in `$namespaces`. The
reference validator, `cwltool --validate`, rejected every bundled recipe because it read
the `x-` fields' contents as CWL. With the `nldt:` names, all five pass. Silently ignoring
the old names would have dropped a step's process link and failed only at run time.

**What the validator found.** The roofer recipe wired an `enum` list (`gpkg`, `cityjson`)
into a step input declared as `string[]`. Our parser had accepted it, since it does not
check types (D5); the step input now has the same `enum` type.

**Consequence.** Deploying a format change means re-storing every recipe: after this
change, the bundled recipes were re-seeded. The namespace IRI does not resolve yet
(it returns 404), which CWL does not require.

## D23 · 22 Oct — The point-cloud sample is a 1.2 MB crop of real AHN3 data

**Decision.** The Hub Datasets point-cloud sample used by the roofer recipe links a small
crop of real AHN3 data in Delft (tile `c_37en2`, 1.17 MB, LAZ, RD New), published as
example data of TU Delft's 3dfier, instead of a full 8.5 GB AHN4 tile.

**Why.** Opening the full tile's link, or its Hub Datasets data address, would start an
8.5 GB download, and a production roofer would have to fetch all of it for one demo run.

**Consequence.** Roofer's staging service returns fixture results and does not download
the point cloud, so the sample proves the plumbing, not a reconstruction.

## D24 · 27 Oct — A failed run says whose failure it is

**Decision.** A failed cook job, and each failed step, carries an `errorSource`: `tool`
(the step's process failed, timed out, could not be reached, or answered unreadably),
`registry` (the Registry could not be reached or did not know the recipe) or `cook` (the
Cook itself). The Status tab shows it, for example "Error source: external tool
`buffer-geometry` during step …".

**Why.** A recipe calls processes the hub does not control. Users could not tell a fault
of the platform from one of a third party.

## D25 · 27 Oct — Remote job addresses are resolved against the process's own address

**Decision.** When a process answers with a job, the Cook resolves the job's address
(its `Location` header or links) against the process's own address.

**Why.** Some servers answer with a relative `/jobs/{jobID}`, which broke polling.
Chaining processes from different vendors surfaces small differences like this.

## D26 · 28 Oct — One naming rule: an app by its Operation label, a step by its step label

**Decision.** Every screen names an app by the CWL Operation's `label` (passed on by the
Registry as `process_label`), falling back to our own tool's name, the title in the
process description, and the process id. A step is named by its own `label`, else its
key.

**Why.** Each screen showed whatever name was nearest: the step's key on one, the remote
description's title on another, and the recipe's own app name nowhere. Once apps can be
swapped, the step and its app need separate names: the step stays, the app changes.

## D27 · 28 Oct — The parameter form is completed from each app's process description

**Decision.** The Wizard reads the OGC API Process description of each step's app at
display time and, for every recipe parameter, fills in what the recipe leaves out:
title, description, default and limits. The recipe always wins, and nothing is written
back to it.

**Why.** At the second plugfest, a user facing someone else's process did not know what
to enter, while the process description already said it, in standard fields. Copying it
into the recipe goes stale; reading it at display time does not.

## D28 · 28 Oct — The services are tested with OGC's official test suite, and fixed

**Decision.** Our OGC API Processes services (the Cook and the four tools) were tested
with OGC's own test suite (TEAM Engine, `ets-ogcapi-processes10`), and the gaps it found
were fixed:
- errors are OGC exception documents with OGC's type URIs;
- landing pages link to the API definition (`service-desc`) and documentation
  (`service-doc`);
- process and job lists carry their required links, and a job's status carries no null
  values;
- results of an unfinished job answer 404 `result-not-ready`;
- the tools have a (always empty) job list;
- behind the gateway, every link carries the service's public prefix (D17).

**Why.** Until then the services had only been checked by hand and with our own clients,
which were lenient.

**Consequence.** Most remaining failures are the suite's execute tests, which need OGC's
`echo` test process; a service with specific inputs cannot replace it. Results per
service are in the final report, section 10, together with the Geonovum OGC checker's
findings (D8).

## D29 · 28 Oct — `internalHref` is a deployment detail in the recipe; we recommend dropping it (open)

**Finding.** A process link carries two addresses: the public `href` and the
`internalHref` the Cook calls (D10). For our own tools, `internalHref` is an address on
the stack's private Docker network, which means nothing to someone reading the recipe or
to another cook running it elsewhere.

**Recommendation, not yet done.** Keep only the public `href` in the recipe, and let each
cook map known public addresses to faster internal ones in its own configuration, as it
already does for data (`LOCATION_REWRITES`, D19).

## D30 · 28 Oct — Authentication, delegated access and pricing are the main gaps to real use (open)

**Finding.** Out of scope by design (D11), but every step of the build assumed open, free
apps. In a recipe, the Cook calls each app on the user's behalf, so with authenticated
apps it would need delegated access to each of them for the length of a run; and cooks
are only interchangeable once that access can be delegated in a trusted, standard way.
Commercial apps also need a price and a way to pay.

**Recommendation.** Research delegated access for chains of OGC API Processes (for
example building on OAuth 2.0 Token Exchange) and pricing in recipe metadata, together
with OGC (final report, findings 23–25 and section 12).

---

## Open items

- **Recipe metadata in DCAT-AP-NL.** The catalogue carries discovery metadata only. The
  final report (section 8.3) proposes a DCAT-AP-NL recipe module; it is not implemented.
- **Persistent job store.** The Cook's jobs are kept in memory and lost on a restart.
- **Execution mode per recipe.** A recipe cannot declare whether it should run
  synchronously or as a job; the UI always runs recipes as jobs (D15).
- **Tool swaps beyond our own tools.** `nldt:compatibleTools` is checked against a
  built-in catalogue of our four tools, and a swap maps inputs by position, not by
  meaning (final report, section 5.2).
- **Versioning, ownership and authentication** for recipes, and protection against
  server-side requests to arbitrary URLs (process links and the Registry's
  description-fetch endpoint).
