# Topic 1: Clappform

__Implementing OGC API - Processes 2.0 on top of a calculation module__

**Geonovum DTaaS Testbed 2026, phase 2, adoption topic 1: implementation report**

Clappform B.V. | Version 1.0 (draft) | 20 November 2026

## Document control

| Item               | Detail                                                                  |
| ------------------ | ----------------------------------------------------------------------- |
| Report title       | Implementing OGC API - Processes 2.0 on top of a calculation module     |
| Programme          | Geonovum DTaaS Testbed 2026, phase 2, adoption topic 1                  |
| Implementing party | Clappform B.V.                                                          |
| Version            | 1.0 (draft)                                                             |
| Status             | Draft for review                                                        |
| Date               | 20 November 2026                                                        |
| Source code        | <https://github.com/ClappFormOrg/ogc-api-processes> (EUPL-1.2)          |
| Public endpoint    | <https://api.ogc-digital-twin.clappform.com> (Part 1 classes; Part 3 `nested-processes` not yet deployed there) |

*Table 1. Document control.*

**Standards in scope**

| Standard | Version we implement | Status of the standard |
| --- | --- | --- |
| OGC API - Processes - Part 1: Core | 2.0 draft ([18-062r3](https://docs.ogc.org/DRAFTS/18-062r3.html)) in the Go server; 1.0 (18-062r2) in the pygeoapi plugin | Draft (2.0), adopted (1.0) |
| OGC API - Processes - Part 3: Workflows and Chaining | `nested-processes` class only ([21-009](https://docs.ogc.org/DRAFTS/21-009.html)) | Candidate SWG draft, conformance URIs at version `0.0` |
| OpenAPI | 3.0.3 for `/api` | Adopted |
| Common Workflow Language | v1.2 `Workflow`, as the recipe definition in our console | Adopted |

*Table 2. Standards we worked against.*

**A note on terminology.** OGC API - Processes, shortened to *Processes* in this report, is an
OGC standard for running a calculation over HTTP. A server lists its *processes*, describes
each process's inputs and outputs with JSON Schema, and runs a process on request. A run is
either *synchronous* (the answer comes back in the response) or *asynchronous* (the server
creates a *job* that the client polls). A *recipe* is a chain of processes where the outputs
of one step feed the inputs of the next. *BAG* is the Dutch national register of buildings
and addresses, which PDOK publishes as open data.

## Executive summary

### What we were asked to do

Topic 1 asks participants to put an OGC API - Processes interface on top of an existing
calculation module, following the [nLDT reference
architecture](https://github.com/Geonovum/NLDT-Architectuur), and to make it work with software
from other vendors. The kickoff named sync and async execution, job management and full
compliance with the specification as the bar.

### What we built and validated

We took a Clappform calculation that existed as a Python notebook: it matches a housing-plan
plot (*kavel*) against BAG buildings and scores how much of each building lies inside the
plot. We ported it to Go and exposed it through a Processes server in three forms:

1. **One call, caller supplies the buildings** (`plot-bag-matching`).
2. **One call, the server fetches the buildings from the PDOK BAG WFS** (`plot-bag-matching-pdok`).
3. **Five step processes** that a recipe chains together, with every intermediate value visible.

We started on Processes 1.0 and moved the server to the 2.0 draft halfway through the testbed.
We then added the `nested-processes` class of Part 3, so a client can send the whole five-step
recipe as one request. Last, we built a browser console with no dependencies. It reads the
process descriptions, generates input forms, follows async jobs, and runs the recipe from a
CWL `Workflow` document, either step by step or as one nested request.

In parallel we built the same matching as a Python plugin for pygeoapi, which implements
Processes 1.0. Section 1.5 describes the plugin and section 5.8 what we fixed before it ran.

We measured both recipe routes against live PDOK data. Each returned a `match_result`
identical to the single call. 199 automated tests cover the server, among them a test that
asserts the chained steps and the single call agree across 7 cases.

### What we found

1. **2.0 is a major version, so 1.0 clients break.** The job status object, the execute
   request and the sync response shape all changed. A 1.0 client cannot read a 2.0 server.
   Section 2 lists each change.
2. **A validator can pass a document it never checked.** The Geonovum `ogc-checker` parses
   OpenAPI 3.0 only. It skipped every rule on our OpenAPI 3.1 document and reported it as
   valid. A 3.0 copy of the same document produced 21 errors.
3. **The response shape depends on how many outputs you ask for.** Zero outputs give
   `204`, one gives the raw value, several give a results document of `{"value": …}`
   wrappers. Every client, and every recipe step, needs both code paths.
4. **The protocol lives in headers a browser hides by default.** `Location`,
   `Preference-Applied`, `Link` and `OGC-Output-Values-Count` are invisible to a browser
   client unless the server lists them in `Access-Control-Expose-Headers`.
5. **Part 3 nesting is a tree, not a graph.** When one step feeds two others, the nested
   request contains that step twice and the server runs it twice. The standard has no way
   to refer to a sibling's output.
6. **Splitting a calculation into steps changes its numbers unless you control rounding
   and projection.** We had to move rounding out of the overlap step and keep geometry
   repair in lon/lat before the split reproduced the single call exactly.
7. **Neither Processes nor Part 3 carries values between steps for you.** Our console does
   that wiring from the CWL document.
8. **The 1.0 schema allows neither bilingual titles nor type arrays.** Our pygeoapi plugin
   had to fall back to plain strings and `nullable`. Section 5.8 has the details.

### Our recommendation in one line

Processes 2.0 is a sound base for a digital-twin calculation layer. Pin down the response
shape, add sibling references to Part 3, and make the validators fail loudly on input they
cannot read.

## 1. What we built

### 1.1 Shape of the system

```
 Browser console              OGC API - Processes server (Go)                  Open data
 (web/index.html)       ┌──────────────────────────────────────────────┐
                        │ /  /conformance  /api (OpenAPI 3.0.3)        │
 Processes tab ───────► │ /processes  /processes/{id}                  │
 Jobs tab      ───────► │ /processes/{id}/execution ── Prefer ──┐      │
 Recipe tab (CWL) ────► │   │  nested-processes resolver (Part 3) │      │
 Service tab   ───────► │   ▼                                     ▼      │
                        │ process registry ──► sync response   job store │
                        │   ├ plot-bag-matching            (in memory, │
                        │   ├ plot-bag-matching-pdok ──────┐  TTL 48 h)│
                        │   └ 5 step processes ────────────┤           │
                        │ /jobs  /jobs/{id}  /jobs/{id}/results[/{out}]│
                        └──────────────────────────────────┼───────────┘
                                                           ▼
                                              PDOK BAG WFS 2.0 (bag:pand)
```

*Figure 1. Components.*

The server ships as a container with a `docker compose` file. The console is a single HTML page
that you open from disk or from any static host.

### 1.2 The calculation module

The module answers one question for a municipality's housing plan: *which BAG buildings
stand on this plot, and is the plot built?*

1. Take the plot polygon in WGS84 and repair it if it intersects itself.
2. Take the BAG buildings around it (`bag:pand` polygons).
3. Project both to RD New (EPSG:28992) and compute, per building, the share of its area
   inside the plot.
4. Drop buildings below `min_overlap_ratio` (default 0.05). Classify the rest as `full`
   (at or above `full_match_threshold`, default 0.95) or `partial` (0.05 ≤ overlap ratio < 0.95).
5. Flag the plot when it has no building inside (`geen_bag_object_binnen_kavel`) or only
   partial matches (`alleen_partiele_match`).

We kept the notebook's inputs, outputs, defaults and flag reasons, so existing consumers of the
notebook output read the process output unchanged.

### 1.3 Process catalogue

| Process | Inputs | Outputs | Calls PDOK |
| --- | --- | --- | --- |
| `plot-bag-matching` | `plot`, `bag_buildings`, `min_overlap_ratio` and `full_match_threshold` | `match_result` | no |
| `plot-bag-matching-pdok` | `plot`, `min_overlap_ratio` and `full_match_threshold` | `match_result`, `bag_query` | yes |
| 1 `plot-geometry-prepare` | `geometry` | `geometry`, `geometry_report` | no |
| 2 `plot-bbox` | `geometry` | `bbox` | no |
| 3 `bag-panden-fetch` | `bbox` | `bag_buildings`, `bag_query` | yes |
| 4 `plot-bag-overlap` | `geometry`, `bag_buildings`, `min_overlap_ratio` | `overlaps`, `skipped` | no |
| 5 `bag-match-classify` | `overlaps`, `plan_dataid`, `full_match_threshold` | `match_result` | no |

*Table 3. The plot to BAG processes. All support sync and async execution and dismissal.*

`bag_query` reports the WFS URL, the bounding box, the feature count, the number of requests
and a `truncated` flag. It exists because an empty `match_result` has two causes: there is no
building on the plot, or the WFS returned nothing. Without `bag_query` a client cannot tell them
apart.

### 1.4 The web console

<img src="./media/Processes.png" alt="Processes tab" width="900">

*Figure 2. Processes tab: the input form is generated from the process description.*

The console has four tabs:

- **Processes** lists the processes, generates a form from each input's JSON Schema, lets you
  pick the outputs and the `Prefer` mode, and shows the raw request and response with the
  OGC headers.
- **Jobs** filters the job list by process, status and time, fetches results and dismisses jobs.

  <img src="./media/Jobs.png" alt="Jobs tab" width="900">

  *Figure 3. Jobs tab.*
- **Recipe** reads a CWL `Workflow` document, draws the flow from it, and runs it. Each task
  lights up as it runs, shows its own timing, and opens to show the exact request and response.
  **Compare** runs the single-call process on the same plot and diffs the two results.

  <img src="./media/Recipe%20CWL.png" alt="Recipe tab driven by CWL" width="900">

  *Figure 4. Recipe tab. The diagram and the run order come from the CWL document.*
- **Service** shows the landing page, the conformance classes and the API definition.

A recorded walkthrough is in [`plot-bag-matching-process.mp4`](https://github.com/Geonovum/DTaaS-Testbed2026-Phase2/raw/refs/heads/main/Topic1-Clappform/plot-bag-matching-process.mp4).

### 1.5 A second implementation: a pygeoapi plugin

We also turned the notebook into a Python plugin for [pygeoapi](https://pygeoapi.io), which
implements Processes 1.0.

In the notebooks, the matching logic depended on the Clappform platform and on live PDOK
requests. We first cut it loose from both. The result is a standalone function behind a fixed
`execute()` interface:

- **Input:** the plot geometry and the BAG buildings around it. The caller supplies the
  buildings, as with `plot-bag-matching`.
- **Output:** the matched BAG IDs, each with an overlap score, and a flag for plots without a
  full match.

The overlap score is the share of each building inside the plot, as in section 1.2. We chose
this over intersection over union. With intersection over union, the plot's own area dilutes
the score, so a small building on a large plot falls far short of a full match. With our measure it
scores 1.0.

## 2. The conversion from 1.0 to 2.0

We built the first version against Processes 1.0 (18-062r2) in March 2026. On 30 September we
moved it to the 2.0 draft (18-062r3) for the `core`, `ogc-process-description`, `json`,
`job-list`, `callback` and `dismiss` classes.

### 2.1 What changed for a client

| Area | 1.0 | 2.0 draft |
| --- | --- | --- |
| Job status | `jobID`, `type: "process"`, bare `processID` | `id`, `processingEntityType: "ogc-api-processes"`, absolute process URL as `processID` |
| Execute request | `response: raw \| document`, `transmissionMode` | Both removed. The number of requested outputs decides the shape |
| Sync response | Chosen by `response` | `204` for no outputs, the raw value for one, a results document plus a `Link: …ogc-results; rel="profile"` for several |
| Conformance URIs | `http://…/1.0/conf/…` | `https://…/2.0/conf/…` |

*Table 4. Changes in the standard that break a 1.0 client.*

OGC keeps minor versions backwards compatible and saves breaking changes for a major version,
so 2.0 does not have to work with 1.0 clients. 2.0 also adds features that break nothing, such
as `/jobs/{id}/results/{outputId}` with an `OGC-Output-Values-Count` header, and a `DELETE` that
removes a finished job.

We had one client, our own console, so we changed both at once. A provider with external
consumers needs to run both versions side by side, on separate base URLs, for a migration period.

The move also made us fix 2 deviations in our own 1.0 server, which were not changes in the
standard:

- **A failed sync run returned `200` with an `error` output.** It now returns `400` for invalid
  input, `502` for an upstream failure and `500` otherwise, as `application/problem+json`.
- **A `Prefer` mode the process could not honour returned `501`.** 1.0 already asked the server
  to fall back to the mode the process supports. Ours now does, and omits `Preference-Applied`.

### 2.2 What changed in the server

- **Inputs are validated against their full JSON Schema.** 1.0 checked the top-level type.
  2.0 makes the description the contract, so we validate nested `required`, `properties`,
  `items`, `enum`, `minimum`/`maximum`, `oneOf` and type arrays. Qualified values
  (`{"value": …, "mediaType": …}`) are unwrapped first.
- **Every input declares `valuePassing: ["byValue"]` and an explicit `minOccurs`.** We do not
  support `{"href": …}` inputs, and we reject them with a clear message instead of
  fetching the URL.
- **Process functions return `(outputs, error)`.** The error carries the HTTP status, so a PDOK
  outage reaches the client as `502` and bad input as `400`.
- **Callbacks.** With a `subscriber`, the server posts the job status to `inProgressUri` and
  `failedUri`, and the results document to `successUri`, with a 30 second timeout.
- **`/api` serves an OpenAPI 3.0.3 document** whose bodies reference the official 2.0 schemas.

### 2.3 Validation

We validated with the Geonovum [`ogc-checker`](https://geonovum.github.io/ogc-checker/), rule set
`ogc-api-processes` 2.0.0, against our `/api`:

```bash
npx @geonovum/ogc-checker@latest validate --standard ogc-api-processes --version 2.0.0 \
  --input http://localhost:8080/api
```

On 30 September the checker reported no requirement failures. Its remaining `invalid-ref`
errors come from broken `$ref`s inside the draft's own `processes-core/value.yaml` and
`valueNoObject.yaml` (to `cql2.yaml`, `geometryGeoJSON.yaml` and missing CQL2 definitions).
Section 5.1 describes how we got there.

## 3. From one process to a recipe

### 3.1 Five steps that reproduce the single call exactly

We split `plot-bag-matching-pdok` into five step processes (table 3). Chaining all five
reproduces `plot-bag-matching-pdok`. Skipping steps 2 and 3 and supplying `bag_buildings`
reproduces `plot-bag-matching`. Both single-call processes now run on the same functions as
the steps, so the two routes cannot drift apart.

The split pays for itself in two places:

- **Threshold sweeps.** Step 4 computes the overlaps once. Step 5 reclassifies them at any
  `full_match_threshold` in 3 to 4 ms, without a PDOK request or any geometry work.
- **Reuse.** Step 3 fetches the BAG buildings for an area once, and several plots in that area
  reuse them.

| `full_match_threshold` | Full matches | Partial matches | Step 5 time |
| --- | ---: | ---: | ---: |
| 0.50 | 24 | 7 | 4.1 ms |
| 0.80 | 17 | 14 | 2.9 ms |
| 0.95 (default) | 14 | 17 | 3.0 ms |

*Table 5. Threshold sweep over one set of overlaps: a test plot in Utrecht, 34 BAG buildings
fetched, 31 candidates.*

### 3.2 Part 3: the whole recipe in one request

With `nested-processes`, an input value may itself be an execution request: an object with a
`process` key. The server runs that process first and puts its output in place of the input.
The five steps then become one POST, and the intermediate values stay on the server.

```json
{ "inputs": {
    "plan_dataid": "utrecht-demo",
    "overlaps": { "process": "plot-bag-overlap",
      "inputs": {
        "geometry": { "process": "plot-geometry-prepare",
                      "inputs": { "geometry": { "type": "Polygon", "coordinates": [ … ] } },
                      "outputs": { "geometry": {} } },
        "bag_buildings": { "process": "bag-panden-fetch",
                           "inputs": { "bbox": { "process": "plot-bbox",
                                                 "inputs": { "geometry": { … } } } },
                           "outputs": { "bag_buildings": {} } } },
      "outputs": { "overlaps": {} } } },
  "outputs": { "match_result": {} } }
```

*Listing 1. The five-step recipe as one nested request to `bag-match-classify`.*

Rules our server applies where the draft leaves room:

| Situation | Our behaviour |
| --- | --- |
| Nested process with several outputs | You must request exactly one; otherwise `400` naming the outputs available |
| Bare process ID (`"plot-bbox"`) | Resolved against this server, as a relative URI |
| Absolute URI to another server | `400`: that is the `remote-core-processes` class, which we do not implement |
| Failure inside a nested step | Keeps its own status; a PDOK outage in step 3 is still `502` |
| Nesting deeper than 8 | `400`; a cycle between processes shows up as this error, not a hang |
| Top-level `process` key | Ignored, as the draft requires |

*Table 6. Nested execution rules.*

### 3.3 CWL as the recipe definition

The console's Recipe tab reads a [Common Workflow Language](https://www.commonwl.org/)
`Workflow` document in its JSON encoding. The diagram, the run order and the execution all come
from that document, so editing `steps` changes what runs. CWL is the definition only: the steps
are OGC processes, so `run` names a process ID (`ogc:plot-bbox`).

```json
"steps": {
  "prepare": { "run": "ogc:plot-geometry-prepare", "in": { "geometry": "geometry" },
               "out": ["geometry", "geometry_report"] },
  "bbox":    { "run": "ogc:plot-bbox", "in": { "geometry": "prepare/geometry" }, "out": ["bbox"] },
  "fetch":   { "run": "ogc:bag-panden-fetch", "in": { "bbox": "bbox/bbox" },
               "out": ["bag_buildings", "bag_query"] },
  "overlap": { "run": "ogc:plot-bag-overlap",
               "in": { "geometry": "prepare/geometry", "bag_buildings": "fetch/bag_buildings" },
               "out": ["overlaps", "skipped"] },
  "classify":{ "run": "ogc:bag-match-classify",
               "in": { "overlaps": "overlap/overlaps", "plan_dataid": "plan_dataid" },
               "out": ["match_result"] } }
```

*Listing 2. The steps of the recipe document.*

The console sorts the steps topologically from the `in`/`out` graph and reports a cycle
instead of running it. It accepts `in` bindings as a source string, `{"source": …}` or
`{"default": …}`. It rejects `valueFrom` instead of ignoring it, because dropping an expression
would change what the workflow means.

The same document runs two ways:

| Mode | What happens | Trade-off |
| --- | --- | --- |
| Step by step | One request per step, sent from the browser | You see every intermediate value; a shared step runs once |
| One nested request | The console compiles the graph into one Part 3 request | One round trip, intermediates stay on the server; a shared step runs twice |

*Table 7. Two execution modes from one CWL document.*

### 3.4 Measured results

We ran the three routes against live PDOK from a laptop, with the server on localhost, 5 runs
each, on 20 November 2026.

| Route | Requests from client | Median | Min | Max | Same `match_result` as single call |
| --- | ---: | ---: | ---: | ---: | --- |
| `plot-bag-matching-pdok`, one call | 1 | 117 ms | 81 ms | 165 ms | (reference) |
| Five steps, one by one | 5 | 128 ms | 109 ms | 192 ms | yes |
| Five steps, one nested request | 1 | 152 ms | 118 ms | 240 ms | yes |

*Table 8. Recipe timings. The PDOK fetch (about 100 ms) dominates every route.*

On localhost a round trip costs almost nothing, so the nested request is not faster here. It
does extra work, because it runs `plot-geometry-prepare` twice. The nested form wins when the
client sits on a slow or distant network, where it saves 4 round trips and the transfer of the
BAG features to the client and back.

## 4. What we learned from building the console

We built the console to test our own server from the position of a client vendor. It surfaced
more interoperability questions than the server work did.

### 4.1 A process description is almost enough to build a form

The console turns each input's JSON Schema into a control: a text field, a number field with
the schema's `minimum` and `maximum`, or a select for a boolean or an `enum`. Objects, arrays, `oneOf` and untyped schemas get a JSON
editor with a *Skeleton* button that builds a starting value from the schema. That covers
every input we have. Two gaps remain:

- **A GeoJSON polygon is "an object".** The schema does not tell a generic client to offer a
  map. We supply example payloads in the console for structured inputs. GeoLabs reports the
  same gap in topic 2 and proposes a way to describe GeoJSON inputs.
- **`null` in a type array is a modifier, not a type.** `["number", "null"]` should render as
  an optional number field. The console picks the first non-null type to drive the control.

### 4.2 The client needs two code paths for every response

Ask for one output and you get the raw value. Ask for two and you get
`{"a": {"value": …}, "b": {"value": …}}`. A recipe that passes outputs along has to know which
shape it asked for and unwrap `.value` in the second case. `plot-bag-matching-pdok` declares two
outputs, so a client that omits `outputs` gets the document form even when it only wants
`match_result`. Our console always requests outputs explicitly and unwraps by the count it
requested.

### 4.3 The protocol is in the headers, and a browser hides them

`Location` (where the job lives), `Preference-Applied` (whether the server honoured sync or
async), `Link` (the results profile) and `OGC-Output-Values-Count` are all response headers. A
browser script reads none of them on a cross-origin call unless the server lists them in
`Access-Control-Expose-Headers`. A browser client against a server that forgets this still
works for sync runs, and fails on async runs because it cannot find the job. Our CORS layer
exposes all four and allows the `Prefer` and `X-Api-Key` request headers.

### 4.4 Browser failures look like a server that is down

Three different mistakes produced the same bare "network error":

- **A base URL typed without a scheme** (`api.example.nl`). The browser resolved it as a path
  relative to the page. From a `file://` page that path does not exist. The console now adds
  `https://` (or `http://` for localhost) and shows the URL it used.
- **Mixed content.** An `https` page cannot call an `http` API. The browser blocks the request
  before it leaves.
- **A page opened from disk sends `Origin: null`.** The server has to allow `null`, or `*`.

The console names each cause in its error message. A client vendor should expect these on any
Processes deployment behind a browser.

### 4.5 `Prefer` is a request, not an instruction

2.0 lets the server fall back to the mode a process supports. A client that sends
`Prefer: respond-async` may get `200` with a result instead of `201` with a job. The console
decides from the status code and from `Preference-Applied`, never from what it asked for.

### 4.6 Nobody wires the steps for you

Processes defines how to run one step. Part 3 nesting defines how to put one step's output into
another's input, as a tree. Neither defines a recipe with shared steps, named intermediate
results or a reusable definition. Our console fills that gap with CWL. Collaborall reached the
same conclusion for recipes in topic 4 and chose the Open Workflow Specification. The testbed
now has two recipe languages for the same job.

## 5. Problems we ran into

### 5.1 The validator passed a document it could not read

Our first 2.0 `/api` was OpenAPI 3.1. The `ogc-checker` parses 3.0.x only. It skipped every rule
and reported the document as valid. When we fed it a 3.0 copy of the same document it reported
21 errors: responses without schemas, the missing `/jobs/{jobId}/results/{outputId}/0` path, and
an `outputs` query parameter without `style: form` and `explode: false`. We moved `/api` to
OpenAPI 3.0.3, fixed the 21 errors and do not claim the `oas30` class, because we have not
validated against it.

**Lesson:** a green result from a validator proves nothing until you have seen it fail on your
document.

### 5.2 The 2.0 schemas have no stable home

`schemas.opengis.net` does not publish the 2.0 schemas yet. Our OpenAPI document references them
on the `master` branch of `opengeospatial/ogcapi-processes`. That branch moves, so a document that
validates today may not validate next month. Two of the draft's own schema files carry broken
`$ref`s, which every 2.0 implementation inherits as `invalid-ref` errors. GeoLabs fixed several
missing schemas upstream during the testbed.

### 5.3 Go values are not JSON values

Over HTTP, a step's output becomes JSON and the next step parses it back. Inside a nested request
no HTTP happens. `plot-bbox` returns a Go `[4]float64`, and the next step's validator expects the
`[]any` that JSON parsing produces, so it rejected the bbox as "must be an array". We now
round-trip every nested output through JSON before it becomes an input. A chained request then
behaves like a chain of requests.

### 5.4 Rounding and projection decide whether a split is exact

- **Rounding.** The single call compares the unrounded overlap with the threshold, then rounds to
  4 decimals. When step 4 rounded first, buildings near 0.95 crossed the threshold. Step 4 now
  returns the unrounded ratio and step 5 rounds after classifying.
- **Projection.** Step 1 has to output GeoJSON, and our RD New transform runs one way only. Step 1
  therefore repairs geometry in lon/lat, where the single call repairs it in RD New. For valid
  plots both agree exactly. For a self-intersecting plot the repaired parts can differ in the last
  decimals. Areas and overlaps use RD New in both routes.

### 5.5 Our port and the notebook disagree on broken polygons

The notebook repaired a self-intersecting "bowtie" with shapely's `buffer(0)`, which kept one of
the two lobes. Our repair splits the polygon at its self-intersections and keeps both lobes. We
consider ours correct for a plot boundary, and `plot-geometry-prepare` reports every repair in
`geometry_report`. A user comparing old notebook output with the process output will see this
difference.

### 5.6 PDOK limits shape the process

- PDOK serves `verblijfsobject`, `ligplaats` and `standplaats` as points. Overlap is a share of
  area, so a point never matches. We query `bag:pand` only.
- The WFS pages 1,000 features per request. We cap a run at 20,000 features and set
  `truncated: true` in `bag_query` when a plot hits the cap.
- Querying the plot's bounding box loses no candidate, because every building that overlaps the
  plot also overlaps its bounding box.

### 5.7 Smaller findings

- **`405` needs an `Allow` header.** 2.0 asks for it and generic clients use it.
- **Problem types for bad input.** The draft defines exception types for missing processes and
  jobs, not for invalid input. We return `urn:ogc-api:exception:invalid-input`,
  `…:upstream-failure` and `…:process-failed` for process failures. Schema validation failures
  still carry `about:blank`. A shared vocabulary would let clients act on the type.

### 5.8 The pygeoapi plugin: schema, bad input and registration

- **The 1.0 schema rejected our process description.** We validated the description against the
  official Processes 1.0 schema. That schema allows no bilingual `title` or `description`
  objects, and no type arrays such as `["integer", "null"]`. We replaced the bilingual objects
  with plain strings and the type arrays with `nullable: true`. Our Go server's 2.0 descriptions
  use type arrays, for example `["object", "null"]` (section 2.2).
- **Bad input crashed the plugin and left no trace.** A review of the plugin found unhandled
  exceptions on a non-numeric threshold, an unreadable geometry and a self-intersecting polygon.
  The logs showed nothing. The plugin now validates its inputs and returns a process error for
  each case. It repairs invalid polygons itself and logs every rejection.
- **pygeoapi registers a plugin only once Python can import it.** We added the package to the
  Python path.

We then started a pygeoapi server and sent a request to the execution endpoint. The whole chain,
from request to match result, worked.

## 6. Where the effort went

Relative effort, not measured hours.

| Area | Effort | Why |
| --- | --- | --- |
| Porting the calculation (notebook to Go) | Medium | Geometry without a geometry library: projection, area, self-intersection repair |
| Processes 1.0 to 2.0 | Medium | Many small breaking changes, each simple |
| OpenAPI document and validation | High | The 3.1 false pass, unpublished schemas and broken upstream `$ref`s took the longest to attribute |
| Splitting into exact steps | Medium | Rounding order and projection direction, found through an equality test |
| Part 3 nested processes | Low | The JSON round trip was the only surprise |
| Browser console | Medium | Most of the interoperability lessons in section 4 came from here |
| pygeoapi plugin (Python, Processes 1.0) | Medium | Fitting the description to the 1.0 schema, input validation and error handling, plugin registration |

*Table 9. Relative effort.*

Implementing the standard was the smaller part. Validating that we had implemented it, and
making a generic client work against it, took more.

## 7. Assessment of the standard

### 7.1 What works well

- **Discovery is enough for a generic client.** The console knows nothing about plots or BAG.
  It reads `/processes`, generates forms and runs every process on the server.
- **Sync and async share one endpoint.** `Prefer` plus the status code lets one client handle
  both, and the fallback rule removes a class of `501` errors.
- **The job list filters cover monitoring.** `status`, `processID` and duration filters gave us
  a job dashboard without extra endpoints.
- **Problem details.** `application/problem+json` with a status and a detail gives every client
  the same error path.
- **Part 3 nesting is small.** One rule, that an input may be an execution request, is enough
  to chain processes on the server.

### 7.2 What we would change

1. **Make the response shape independent of the output count.** Let a client ask for the
   document form explicitly, or always return it when `outputs` names one output. Today a
   recipe cannot pass outputs along without knowing how many it requested.
2. **Let Part 3 refer to a sibling output.** A reference such as `{"$output": "prepare/geometry"}`
   would turn the tree into a graph. Without it, a shared step runs once per consumer.
3. **Publish the 2.0 schemas at a versioned, stable URL**, and fix the broken `$ref`s in
   `value.yaml` and `valueNoObject.yaml` before adoption.
4. **Standardise an exception type for invalid input and one for upstream failure.**
5. **State in the standard which response headers a browser client needs**, so servers expose
   them by default.

## 8. Recommendations

### 8.1 To Geonovum and the testbed programme

- Have the `ogc-checker` fail, or warn loudly, when it receives an OpenAPI version it cannot
  parse.
- Run the Topic 3 clients against every Topic 1 and 2 server and publish the matrix. Validation
  against the API definition says little about whether a client can use a server.
- Choose one recipe language for the national digital twin. CWL and the Open Workflow
  Specification both came up in this testbed.

### 8.2 To implementers

- Build a client before you call your server done. Most of our interoperability findings came
  from the console, not from the validator.
- Expose `Location`, `Preference-Applied`, `Link` and `OGC-Output-Values-Count` through CORS.
- Write an equality test between a split recipe and its single-call version. Ours caught a
  rounding difference no review would have.
- Report what the upstream returned (our `bag_query`) next to the result, so an empty answer is
  never ambiguous.

## 9. Status, limitations and next steps

**Done**

- Processes 2.0 draft: `core`, `ogc-process-description`, `json`, `job-list`, `callback`,
  `dismiss`.
- Part 3 `nested-processes`.
- Plot to BAG matching as 2 single calls and 5 chainable steps, verified equal against live PDOK.
- Browser console with CWL-driven recipes, step-by-step and nested.
- Plot to BAG matching as a pygeoapi plugin on Processes 1.0, with input validation, polygon
  repair and logging.
- Hardened container image and `docker compose` deployment; 199 automated test cases.

**Limitations**

- Jobs live in memory and disappear on restart. Production needs a persistent store.
- Async jobs run as goroutines without a queue. That fits processes that finish in seconds.
- We do not implement Part 2 (deploy, replace, undeploy) or the other seven Part 3 classes,
  among them `remote-core-processes` and `cwl-workflows`.
- Inputs pass by value only; `href` inputs are rejected.

**Next steps**

- Deploy the Part 3 `nested-processes` build to the public endpoint.
- Rerun `ogc-checker` and the OGC beta ETS on the final build and attach the output.
- Replace the in-memory job store with a persistent one.
- Follow Part 3 as it moves from version `0.0`, and update the conformance URIs.

## 10. Reproducing our results

```bash
cd ogc-api
docker compose up --build          # API on http://localhost:8080
```

Open `ogc-api/web/index.html` in a browser, set the base URL to `http://localhost:8080` and press
**Connect**. Or call the API directly:

```bash
curl -X POST http://localhost:8080/processes/plot-bag-matching-pdok/execution \
  -H "Content-Type: application/json" -H "Prefer: respond-sync" \
  -d '{"inputs": {"plot": {"plan_dataid": "utrecht-demo", "geometry": {"type": "Polygon",
        "coordinates": [[[5.1214,52.0907],[5.1230,52.0907],[5.1230,52.0918],[5.1214,52.0918],[5.1214,52.0907]]]}}},
       "outputs": {"match_result": {}}}'
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Listening port |
| `BASE_URL` | `http://localhost:<PORT>` | Public base URL used in links |
| `JOB_MAX_AGE_HOURS` | `48` | Evict jobs not accessed for this long |
| `CORS_ALLOWED_ORIGINS` | `*` | Allowed browser origins; `null` allows `file://` pages |
| `PDOK_BAG_WFS_URL` | `https://service.pdok.nl/lv/bag/wfs/v2_0` | BAG WFS, or a mirror or test double |

*Table 10. Configuration.*

## 11. References

### 11.1 Standards

- OGC API - Processes - Part 1: Core 2.0 draft, [18-062r3](https://docs.ogc.org/DRAFTS/18-062r3.html)
- OGC API - Processes - Part 3: Workflows and Chaining, [21-009](https://docs.ogc.org/DRAFTS/21-009.html)
- OGC API - Processes schemas, [opengeospatial/ogcapi-processes](https://github.com/opengeospatial/ogcapi-processes)
- Common Workflow Language v1.2, [commonwl.org](https://www.commonwl.org/)
- RFC 9457, Problem Details for HTTP APIs

### 11.2 Testbed

- [Geonovum ogc-checker](https://geonovum.github.io/ogc-checker/)
- [Discussion #4: Testing with ogc-checker](https://github.com/Geonovum/DTaaS-Testbed2026-Phase2/discussions/4)
- [Topic 2, GeoLabs](../Topic2-GeoLabs/Topic2.md): describing GeoJSON inputs and outputs
- [Topic 4, Collaborall](../Topic4-Collaboral/Topic4.md): recipes and value wiring between steps

### 11.3 Data

- [PDOK BAG WFS 2.0](https://service.pdok.nl/lv/bag/wfs/v2_0)
