# Topic 3: Breinstein

__A browser client for OGC API – Processes__

Geonovum nLDT Testbed 2026, Phase 2  
**Topic 3:** OGC API Processes client  
**Author:** Breinstein

---

## Abstract

OGC API – Processes lets a client discover, run and monitor computational
processes over a Web API. In the Dutch national digital twin architecture
(nLDT), a visualisation front end calls computational modules through this
standard. Existing conformance testing checks servers from outside the
browser, so it cannot show whether a web page can use them. Of the existing
open-source client libraries, most do not cover Processes. The one that does
reduces each response to its JSON body, so it loses the `Location` header that
asynchronous execution depends on.

We built a browser client in two layers:

- a runtime-neutral protocol core, published on npm;
- a web interface on top of it, which generates input forms and shows results
  on a map, so a user can run a process without writing any code.

The client speaks the 2.0 draft of the standard where a service declares it,
and falls back to 1.0 otherwise. With it, we tested six deployments: two
implementations run by the team throughout the testbed (pygeoapi and
ZOO-Project), and three services run by testbed parties. We recorded every
point at which a service's behaviour differed from the standard, from its own
declarations, or from what a browser allows: 72 filed findings.

The main results:

- **CORS decides whether a web page can use a service at all**, not OGC
  conformance. Three of the six deployments can be reached directly from a web
  page. Only one of those three lets a page read the `Location` header that
  names a new asynchronous job.
- **Declarations and behaviour diverge in both directions.** Capabilities
  that work are not declared, and capabilities that are declared or listed do
  not work.
- **Neither team-run implementation validates execute inputs**, and in 16
  findings a server answers with a success status while doing something other
  than what was asked.
- **The same request returns differently shaped answers** from different
  implementations.

We considered a server-side relay to work around these limits, and built one.
We decided not to deploy it publicly, for security reasons. Instead we
recommend that services configure CORS correctly, and that any access control
they need uses a documented scheme that a browser can send. We also propose
profile guidance, and identify four gaps in the standard itself.

---

## 1. Introduction

The nLDT architecture separates visualisation from computation. A viewer
finds a computational module through a catalogue and runs it through OGC API –
Processes [13, 14]. For this separation to work, any conformant viewer must be
able to drive any conformant computational module. In practice the viewer is
often a web application, so the client runs inside a browser, under the
browser's security rules.

Several general-purpose client libraries for OGC API – Processes exist
(section 2.4), but no mature client offers the standard a visual, easy-to-use
interface. QGIS, for example, supports OGC API – Features as a client, but its
documentation lists no support for OGC API – Processes [18]. To try a process,
a user must therefore turn to developer tools such as Swagger UI, Postman or
cURL. A client in the web browser lowers that barrier: it requires no
installation, runs on any platform, and can show results directly on a map.
Within the testbed, where adoption topics 1 and 2 provide the server side of
the standard, such a client is the counterpart that exercises those services.
It is deliberately independent of any single use case, so that every
participant's processes become a test of interoperability.

Topic 3 of the 2026 testbed asks for such a client. This report addresses
three questions:

- **RQ1.** Can a browser client use an OGC API – Processes service directly,
  without a server-side intermediary?
- **RQ2.** Where do implementations deviate from the standard, or from their
  own declarations, in ways that affect an interoperable client?
- **RQ3.** What should service operators and an nLDT profile do to close those
  gaps?

The report treats the services tested alike. Results are grouped by theme
rather than by service (section 5). Every filed finding is listed in Annex A.

---

## 2. Background

### 2.1 The standard

OGC API – Processes – Part 1: Core 1.0.0 (OGC 18-062r2) was approved in
August 2021 and published in December 2021 [1]. It builds on concepts from the
Web Processing Service (WPS) 2.0 standard, but replaces its XML operations with
a resource-oriented API using JSON and OpenAPI [1].

The standard defines:

- a process list (`/processes`) and a process description per process;
- **synchronous** execution, where the result comes back in the response;
- **asynchronous** execution, where the server creates a job and returns its
  address in the `Location` header;
- job status, results and dismissal (`/jobs/{jobID}`, `/results`, `DELETE`);
- optional callbacks to a subscriber URL.

A version 2 of Part 1 was put out for public comment in August 2026 [2]. The
client follows the draft of that version (section 3.2). Every clause cited in
this report refers to 1.0.0.

18-062r2 does not define an authentication scheme. It recommends access control
on the job list and on dismissal (Security Considerations), defines 401 and
403, and requires an access-controlled service that implements the OpenAPI 3.0
class to document its security scheme in its OpenAPI definition (Requirement
63) [1]. How a client authenticates is left to each deployment.

### 2.2 Conformance testing

The OGC validator runs an executable test suite (ETS) for Part 1 in TEAM
Engine. The suite was developed in OGC Testbed-17 [4]. It covers the Core,
OGC Process Description, JSON, HTML, OpenAPI 3.0 and Job list conformance
classes [3]. The tester names one echo process, which is used for the execute
tests [3].

Two properties of this approach matter here:

- **The test harness is not a browser.** Cross-origin rules (CORS) are
  enforced only by browsers. A server can pass every test and still be
  unreachable from a web page.
- **The Dismiss and Callback classes are not in the suite's list** [3]. They
  are also the classes that matter most to a client that monitors jobs.

### 2.3 Implementations

**pygeoapi** is an open-source Python server for the OGC API family. Its
documentation lists OGC API – Processes as "Compliant" in its standards
support matrix [5]. Processes are added as Python plugins. Asynchronous
execution is requested with `Prefer: respond-async` and needs a job manager
[6].

**ZOO-Project** is an OSGeo project: a C-based platform that implements WPS
1.0.0 and 2.0.0 as well as OGC API – Processes [16]. It ships several hundred
ready-made processes built on libraries such as GDAL, SAGA GIS and the Orfeo
Toolbox.

We ran both ourselves, pinned, for the whole testbed:

- **pygeoapi 0.21.0** is the server in the blocking continuous-integration
  lane. It is widely deployed, it implements callbacks, and its CORS can be
  switched on and off by configuration.
- **ZOO-Project** is the second implementation. It helps tell a server's
  deviation from an ambiguous clause in the specification, and its catalogue of
  more than 700 processes gives the form generator real variety.

We did not establish which releases were certified, so our observations are
not a statement about certification.

### 2.4 Existing clients

- **ogcapi-js** is a TypeScript library with a package for OGC API – Processes
  [7]. In our review, its shared request helper reduces a successful response to
  its JSON body, so headers such as `Location` and `Retry-After` never reach the
  caller.
- **ogc-client** is a TypeScript library for WMS, WFS, WMTS and OGC API
  Records and Features [8]. It reports when a service cannot be used because of
  CORS [8], but does not cover Processes.
- **OWSLib** is a Python client library for OGC services, including the OGC API
  family [9]. It runs outside the browser.

We found no browser client for OGC API – Processes that keeps the response
headers asynchronous execution depends on, or that records how each server had
to be reached.

### 2.5 Browser constraints

Under the WHATWG Fetch standard [10], a page may read a response from another
origin only when the server allows it with CORS headers. Two further rules
apply:

- Requests with a JSON body, a `Prefer` header, an `Authorization` header or the
  `DELETE` method need a **preflight**: an `OPTIONS` request that the server
  must also allow.
- Script can read only a small set of response headers. `Location` is not one
  of them, so the server must list it in `Access-Control-Expose-Headers`.

18-062r2 anticipates both problems. Section 7.6 of 18-062r2 recommends supporting
cross-origin requests for browser use (Recommendation 4) and exposing
`Location` (Recommendation 5) [1]. Both are recommendations, not requirements.

### 2.6 Contribution

| Existing work | What we take from it | What we add |
| --- | --- | --- |
| OGC 18-062r2 [1] and the 2.0 draft | The requirements and schemas each observation is checked against | Observations of behaviour the requirements leave open, and of recommendations that are not followed |
| OGC ETS for Part 1 [3, 4] | Testing against a running server | Testing from a real browser, and of the Dismiss and Callback classes |
| pygeoapi and ZOO-Project [5, 6, 16] | Two pinned open-source implementations, one in two CORS configurations | A record of where each departs from the standard and from its own declarations |
| ogcapi-js [7] | An inventory of operations and types, and test fixtures, corrected where needed | A response envelope that keeps status, headers and body as received |
| ogc-client [8] | Link-following, error handling, and reporting CORS failures to the user | The same discipline applied to Processes, including jobs and callbacks |
| OGC code sprints [12] | Reporting interoperability results back to standards editors | Findings graded on a fixed vocabulary, with the evidence published |

---

## 3. The client

In the absence of a reusable client, every viewer that is to call a
computational module must implement the protocol itself. This includes
discovery, conformance negotiation, paging, execution, polling and the
retrieval of results. It also includes tolerances for each server's deviations
from the standard (section 5), and an interface for the inputs and outputs of
every process. With N viewers and M modules, this amounts to N × M separate
integrations. A shared standard reduces them to N + M components, each of which
implements the standard once, so that any viewer can be paired with any module.
This is what the nLDT architecture asks for when it requires models and
visualisation tools to be reusable and exchangeable, and open standards to
prevent vendor lock-in [14]. The implementation presented here addresses it in two
layers, each of which can be used without the other: a protocol core
(section 3.1), and a web interface built on it (section 3.3).

Figure 1 shows these parts and how they depend on each other. A third part,
the relay, is optional and is discussed in section 6. The build enforces the
boundaries between the parts. The core may import no framework, no map library
and neither application, and within the web interface only the map module may
use MapLibre and Terra Draw.

<img src="./media/architecture.png" alt="The architecture of the client: web interface, protocol core and relay in one repository, another viewer embedding the core, and the services they call" width="900">

*Figure 1. The architecture of the client. The dashed outline marks the MIT-licensed repository, which holds three parts. The web interface (React, TypeScript, MapLibre) generates forms, follows jobs and shows results on a map; it uses the protocol core only through the core's public API. The protocol core (`@breinstein/oap-client` on npm) implements the protocol and depends on no framework or map library. It sends its HTTP requests directly from the browser to the services. The relay (dashed box) is optional and is not deployed beside the public interface: it would receive callbacks and reach services without CORS on the page's behalf (section 6). "Another viewer" stands for any web or Node application that installs the core from npm and embeds it, without our web interface. It shows the intended reuse; no such integration is known to exist yet. Solid arrows are the paths in use; dashed arrows are paths through the relay.*

### 3.1 Protocol core

The core is published on npm as `@breinstein/oap-client` [15]. Release 0.6.0
appeared on 18 November 2026, after seven earlier releases from 26 August. The
core is written in TypeScript and published as JavaScript with type
declarations, so it can be used from any JavaScript application, with or
without TypeScript.

It handles:

- discovery and conformance;
- process lists and descriptions;
- synchronous and asynchronous execution;
- polling, dismissal and results.

Four properties make it a basis rather than an application:

- **It depends on no framework and no map library.** Lint rules and
  dependency checks enforce this in the build.
- **It is runtime-neutral.** It uses no browser-only or Node-only API, and
  consumer smoke tests run the packed package in both kinds of environment.
- **`fetch` is passed in by the caller.** An embedding application can add
  its own headers, for example an API key, without changing the core. The core
  README shows the pattern.
- **It keeps evidence.** Every response is kept as it arrived (status,
  headers, media type, body) and classified by what arrived. Every deviation
  it tolerates is reported to the caller as an observation, not smoothed over.

The core is built to work with services that depart from the standard,
without hiding that they do:

- **It follows links rather than building paths.** Every address comes from a
  link the service advertises, resolved against the address the document was
  actually served from. Both the short and the long form of a link relation
  are accepted, because pygeoapi uses both on one landing page (0005).
- **It asks for JSON explicitly.** Every request sends `Accept:
  application/json`, and an HTML answer counts as a failure. A service that
  ignores the header is asked once more with `f=json`, and the route that
  worked is recorded (0007, 0036).
- **It treats a capability as advertised, assumed or neither.** Dismissal and
  callbacks have conformance classes of their own; synchronous and
  asynchronous execution do not, so the core can only assume them. A missing
  class never stops a request: pygeoapi supports dismissal and the job list
  without declaring either (0006).

Section 8.4 turns these choices into practices for other clients.

### 3.2 Version negotiation

The client speaks version 2 where a service supports it and falls back to 1.0
otherwise. "Version 2" means the draft OGC 18-062r3, pinned at commit
`756b659` of the standard's repository (20 October 2026), because version 2 is
not yet a published standard. All differences sit in one dated module, so a
change in the draft changes one file.

| The service declares | The client speaks |
| --- | --- |
| the 2.0 Core class, with or without 1.0 Core | the 2.0 draft |
| only the 1.0 Core class | 1.0 |
| neither, or no readable conformance | 1.0, the published standard |

**Fallback is a choice made before sending, never a retry.** Executing a
process is not idempotent, so a request sent as 2.0 and resent as 1.0 could
start two jobs.

**Release.** Version 2 support is in the npm release 0.6.0 and in the web
interface. We checked the published package against a simulated service:

| The simulated service declares | Version chosen | Request for both outputs as a document | Request for one output, raw | Request for two outputs, raw |
| --- | --- | --- | --- | --- |
| 2.0 and 1.0 Core | 2.0 draft, from the declaration | no `response` member; the server decides from the outputs requested | the one output listed, no `response` | refused before sending |
| 1.0 Core only | 1.0, from the declaration | `response: "document"` | `response: "raw"` | `response: "raw"` |
| nothing (conformance 404) | 1.0, by default | as 1.0 | as 1.0 | as 1.0 |

Asynchronous execution sends `Prefer: respond-async` in both versions. A
caller can pin a version; on a 2.0 service pinned to 1.0, the choice is
recorded as configured.

Two qualifications apply:

- **Evidence.** Weaver is the only server found that declares the 2.0 Core
  class. The core has completed synchronous and asynchronous runs against it
  from Node. No run has yet succeeded from the browser, because of Weaver's own
  limits: no CORS headers, a single runnable process, and a refusal of the
  draft's encoding of that process's inputs.
- **Elsewhere.** Of the services in this report, Roofer Online declares the
  2.0 Core class, but cannot be reached from a browser. pygeoapi (including
  0.24.0) and ZOO-Project declare 1.0 only.

### 3.3 Web interface

The web interface is a React application written in TypeScript, with MapLibre
GL JS for the map. It is built on the core's public API: 31 of its source files
import the package. The package exports only its public entry point, so the
interface cannot reach into the core's internals.
For a user it provides:

- **Generated forms.** Inputs are generated from each process description:
  text, numbers, choices, dates and files. Bounding boxes and geometries are
  drawn on the map with Terra Draw, a drawing library that works through
  adapters with MapLibre, OpenLayers, Leaflet and other map libraries [19]. A
  viewer built on another map library can therefore offer the same drawing
  tools. A schema the generator cannot render falls back to raw JSON input
  (section 5.11).
- **Job handling.** Synchronous and asynchronous runs, a job list, polling and
  dismissal.
- **Results on the map.** GeoJSON, GML and KML are drawn on a map. Results in
  RD New (EPSG:28992) are reprojected. Images are shown inline, tables as
  tables, JSON and text as they arrived, and anything else is offered as a
  download.
- **Example processes.** The start screen offers ready-made examples that open
  a process with one click, so a user can try the client without knowing a
  service address. The hosted interface offers five, from a demonstration
  service set up for the testbed: how green an area is, the feels-like
  temperature on a hot day, where the shade is, roof space for solar panels,
  and the age of the buildings. They are written for users without a technical
  background, such as policy makers. The demonstration service runs on the same
  server as the hosted interface; its code is not public.

A user of the hosted interface can connect
to a service, fill in a generated form and see the result on a map without
writing any code. A developer who embeds the core in their own viewer still
writes their own forms and rendering: those parts belong to the web
application, which is not published as a package. They are available as MIT
source in the repository.

### 3.4 Out of scope

- **Authentication.** The web interface has no setting for an API key or a
  token. 18-062r2 defines no authentication scheme (section 2.1), so nothing
  in the standard tells a client what to send. Through the core, a developer
  can add one with their own `fetch`.
- **Callbacks.** The hosted interface does not use callbacks; it polls
  (section 6).
- **Servers without CORS.** The hosted interface cannot reach them. Section 6
  explains why.

### 3.5 Walkthrough

This section follows one user through the web interface, from connecting to a
service to reading a result on the map. The screenshots were taken from client
release 0.6.0, run locally against the reference pygeoapi (sections 2.3 and
4.1). The hosted interface at https://oap.breinstein.nl works the same way, but
offers other example services on its start screen.

**1. Connect to a service.** The start screen asks for one thing: the address
of a service's landing page. The user can also pick a known service or start
from an example process (Figure 2).

<img src="./media/using-01-start.png" alt="The start screen: a service address, examples, and known services" width="900">

*Figure 2. The start screen.*

**2. Choose a process.** After connecting, the client lists the service's
processes. For each one it shows what the user will need to provide, read from
the process description: an area to draw, data to upload, or plain values
(Figure 3).

<img src="./media/using-02-processes.png" alt="The process list of the reference pygeoapi, with what each process needs" width="900">

*Figure 3. The processes a service offers, and what each needs.*

**3. Fill in the generated form.** Opening a process shows its description and
a form generated from the JSON Schema of each input (Figure 4). An area can be
typed as GeoJSON, loaded from a file, taken from the current map view, or
drawn. A checkbox runs the process in the background.

<img src="./media/using-03-form.png" alt="The form for "Buildings in an area", with the map beside it" width="900">

*Figure 4. A form generated from the process description.*

**4. Draw the area.** The drawing tools add an area or a box on the map. The
form fills in the GeoJSON as the user draws, and shows the size, here "about
170 m across", so the user can see it is within the process's limit of 1 km
(Figure 5). A place search moves the map to an address.

<img src="./media/using-04-draw.png" alt="An area drawn over the centre of Amersfoort" width="900">

*Figure 5. An area drawn on the map, in Amersfoort.*

**5. Read the result.** When the process finishes, the result appears on the
map in blue, beside the area the user sent, which is shown as a dashed outline
(Figure 6). Clicking a building shows its properties. The panel names the
format, offers a download, and repeats the inputs that were sent, so the user
can check what the service was asked.

<img src="./media/using-05-result.png" alt="The buildings returned by the process, drawn on the map" width="900">

*Figure 6. The buildings in the area, from Kadaster's BAG via PDOK.*

**6. Run a long process in the background.** With "Run in the background"
ticked, the service creates a job and the client follows it (Figure 7). The page
shows the job's status and progress, and gives a link that opens the same job
from any browser. It also offers to cancel the job, and says when the service
does not declare that it supports cancelling (finding 0006).

<img src="./media/using-06-background-job.png" alt="A background job, accepted by the service, with a link and a cancel button" width="900">

*Figure 7. A job running in the background, here on pygeoapi 0.24.0.*

**7. Find jobs later.** The jobs panel lists every background job started in
the browser, with its status, and keeps it after the page is reloaded
(Figure 8). From there the user can open the results or run the process again.

<img src="./media/using-07-my-jobs.png" alt="The jobs panel with one finished job" width="900">

*Figure 8. The jobs panel.*

**When a service hides the job.** Against pygeoapi 0.21.0, the client cannot
learn which job it started, because the service does not expose `Location` to
the page (finding 0039). The jobs panel then stays empty, and says why
(Figure 9). This is the limit that sections 5.3 and 8.1 describe, as a user
meets it.

<img src="./media/using-08-job-not-named.png" alt="The jobs panel against pygeoapi 0.21.0: no job can be listed" width="900">

*Figure 9. The same panel against a service that hides `Location`.*

---

## 4. Method

### 4.1 Services

| Service | Version | Run by | Role | Findings |
| --- | --- | --- | --- | ---: |
| pygeoapi, CORS on and off | 0.21.0, pinned | the team | reference server, blocking in continuous integration | 36 |
| ZOO-Project | pinned fork of upstream; 703 processes | the team | second implementation, non-blocking | 45 |
| ZOO-Project-DRU | hosted testbed deployment | third party | testbed service | 3 |
| Roofer Online | staging | third party | testbed service | 1 |
| Varidian registry | as of 27 and 31 October 2026 | third party | testbed service | none filed |
| Weaver | 6.16.0 plus master | the team | the only server found declaring 2.0 Core | recorded in the core's README |

13 findings cover both pygeoapi and ZOO-Project, so the counts add up to more
than the 72 filed findings.

ZOO-Project-DRU is a build of ZOO-Project that also implements the draft Part 2
of the standard, Deploy, Replace, Undeploy, with which users add, update and
remove processes through the API itself [17]. The client uses only Part 1, so
this deployment was tested as an ordinary OGC API – Processes service.

pygeoapi runs:

- the stock `hello-world` process;
- seventeen processes written for the testbed, each covering one case the stock
  process does not: binary output, several outputs, bounding-box and geometry
  inputs, inputs by reference, long-running jobs, single-mode execution and
  others.

Browser behaviour was tested in Chromium with Playwright. Protocol behaviour
was tested with contract tests and captured requests and responses.

### 4.2 Grading

A finding is recorded whenever a service's behaviour affects an interoperable
client. Each finding states:

- what was sent and what came back, with the captured payload;
- the clause, requirement or recommendation it was checked against;
- what the client does about it.

| Scale | Values |
| --- | --- |
| Outcome | `conformant`; `non-conformant` (deviates from a citable clause); `undeclared` (works but is not advertised); `declared-not-working` (advertised but does not work); `unsupported` (absent, and legitimately so); `blocked` (could not be tested) |
| Severity | `blocking` (a required capability cannot be delivered); `major` (a client doing the obvious thing breaks); `minor` (works, at a cost); `informational` |
| Confidence | `high` (reproduced against a running server and checked against the specification text); `medium` (one of the two); `low` (inferred, or the specification is ambiguous) |
| Client impact | `handled`, `degraded`, `blocked`, `none` |

The distinction between `undeclared` and `declared-not-working` is
deliberate. Both are invisible to a client that trusts the conformance
declaration, and conformance tests detect neither.

Citations to 18-062r2 are checked by tooling, so a requirement, clause or
figure that does not exist fails the build. We added this check after a review
on 23 September 2026 found four wrong references in five findings. Every claim
in a finding is marked as observed or inferred.

---

## 5. Results

Results are grouped by theme rather than by service. Each theme names the
services where a behaviour was seen. Finding numbers are in brackets, and
Annex A lists every finding.

### 5.1 Overview

| Service | Findings | blocking | major | minor | informational |
| --- | ---: | ---: | ---: | ---: | ---: |
| pygeoapi | 36 | 3 | 21 | 7 | 5 |
| ZOO-Project | 45 | 3 | 27 | 10 | 5 |
| ZOO-Project-DRU | 3 | – | 2 | 1 | – |
| Roofer Online | 1 | 1 | – | – | – |
| **All filed findings** | **72** | **7** | **42** | **17** | **6** |

13 findings cover both pygeoapi and ZOO-Project, so the rows add up to more
than 72.

The counts reflect how much each service was tested, not how well it
performs. The two team-run implementations were tested continuously from
August. The third-party services were tested at the plugfests and whenever they
were available.

### 5.2 Interoperability matrix

The matrix summarises, for each service, the capabilities the bid names.

- For execution, dismissal and callbacks, a cell describes what the service
  did, by whatever route it was reached (a browser, Node, or `curl`).
- The CORS row says whether a web page can reach it.
- Finding numbers are in brackets.

| Capability | pygeoapi 0.21.0 | ZOO-Project | ZOO-Project-DRU | Roofer Online | Varidian registry | Weaver ¹ |
| --- | --- | --- | --- | --- | --- | --- |
| Sync execution | yes, with deviations (0024, 0027, 0028) | yes, with deviations (0025, 0071, 0072) | yes; multi-output answers lose CORS (0067) | not tested ² | yes | yes, from Node |
| Async execution | yes; a page cannot name the job (0039) | declared; stops as capacity runs out (0044) | yes, through a `monitor` link (0069); multi-output results unreadable (0068) | not tested ² | yes | yes, from Node |
| Dismiss | yes, but not declared (0006); the job is deleted (0035) | yes; the job is deleted (0035) | not tested | not tested ² | yes | not tested |
| Callbacks | declared and working; unsafe when undeliverable (0047, 0048) | declared and working (0048) | not tested | not declared | not tested | not tested |
| CORS | `cors: true`: yes, but no header exposed (0002, 0057); `cors: false`: no (0049) | no (0009, 0050) | yes, except on multipart; no header exposed (0067, 0069) | no; every preflight 405 (0064) | yes, `Location` exposed | no |
| Version | 1.0 | 1.0 | not checked | 2.0 Core and 1.0 (0064) | 1.0 Core, plus one 2.0 class | 2.0 Core and 1.0 |
| Output CRS ³ | no CRS signal on process outputs; `Content-Crs` on linked items, hidden from a page | GML carries `srsName`; GeoJSON in RD New carries none | not tested | not tested | not tested | not tested |

1. **Weaver** was run by the team only to test version 2. The core completed
   synchronous and asynchronous runs against it from Node. No run has
   completed from a browser, because Weaver sends no CORS headers and refuses
   the draft's encoding of its one process's inputs (section 3.2).
2. **Roofer Online**: no request reached it from a page, and no execute was
   sent by any route (0064).
3. **Output CRS** was observed while building the client's result rendering,
   and is not yet filed as findings.

**"Not tested"** means what it says. It is not a polite "no": for most
third-party services, only what a page could reach was tested (section 7.5).

A finer matrix is generated from the findings' metadata. It lists about 50
capabilities, from link relations to poll pacing, against each service. It is
regenerated whenever a finding changes, and is kept with the finding records;
the version used for this report was generated on 13 November 2026.

### 5.3 Browser access

| Deployment | CORS | `Location` readable by a page | Page can name an async job | Usable from a web page |
| --- | --- | --- | --- | --- |
| pygeoapi 0.21.0, CORS on | yes (0040, 0057) | no (0002) | no: the `201` body is `null` (0004, 0039) | yes, except asynchronous execution |
| pygeoapi 0.21.0, CORS off | no | – | no | no (0049) |
| ZOO-Project | no (0009) | – | no | no (0050) |
| ZOO-Project-DRU | yes, except on multipart answers (0067) | no (0069) | yes, from a link in the `201` body | yes, with exceptions (0067, 0068) |
| Roofer Online | no; every preflight answered 405 (0064) | – | no | no |
| Varidian registry | yes, complete, including `Location`, `Link` and `Preference-Applied` | yes | yes | yes |

**Rates.**
- Usable directly from a web page: 3 of 6 deployments.
- `Location` readable by a page: 1 of the 3 that allow CORS.
- An asynchronous job a page can name: 2 of 6.

Two of the six deployments are configurations of the same server, so these
rates are indications, not a survey.

pygeoapi's hidden `Location` is a bug in releases 0.18.0 to 0.23.x: the
expose-headers setting is passed to the CORS library in a form the library
ignores. It is fixed in 0.24.0. We confirmed this in a browser on 0.21.0,
0.24.0 and the development branch.

### 5.4 Declarations

- **Under-declared.** pygeoapi supports dismissal and the job list, but
  declares neither (0006).
- **Over-declared.**
  - pygeoapi describes every process with the server's execution modes, not
    the process's own (0059).
  - ZOO-Project lists two processes it cannot describe (0020).
  - It also lists 104 Orfeo Toolbox processes that cannot run (0066), and
    advertises an input format its build cannot read (0070).
  - Its asynchronous capacity falls by about one worker per job until no job
    runs, while it still answers `201` (0044).

### 5.5 Inputs

- **The minimal request.**
  - ZOO-Project cannot parse a body carrying only `inputs`, which is a complete,
    conformant request (0025).
  - pygeoapi ignores the `outputs` block (0028).
- **Validation.** Neither team-run implementation validates inputs against the
  process description (0054).
  - pygeoapi turns an array sent to a single-valued input into Python text
    (0031).
  - ZOO-Project answers invalid or missing input with server errors, error
    pages or crashes (0016, 0031, 0055, 0062).
- **Inputs by reference.**
  - pygeoapi hands the process the link, unresolved (0058).
  - ZOO-Project runs the process with an empty input when the fetch fails
    (0053), and reuses a cached copy indefinitely (0061).
- **Qualified values.** pygeoapi hands the process the `{value, mediaType}`
  wrapper (0052).
- **Bounding boxes.** ZOO-Project discards the CRS sent with a box and
  relabels it with its own default (0051).

### 5.6 Responses

- **Naming a job.**
  - pygeoapi sends `Location` on every synchronous response, including errors
    (0024).
  - Its asynchronous `201` body is `null` (0004).
- **Response shapes.** The default for `response` in 1.0 is `raw`, and no
  implementation follows it fully:
  - pygeoapi wraps a `document` answer in a one-element array (0027).
  - ZOO-Project answers a results document where raw is the default (0072),
    frames its raw multipart wrongly (0073), returns values where references
    were asked for (0060), and once answered `200 {}` (0071).
  - ZOO-Project-DRU serves the results of a multi-output job in a form no
    client can read (0068).
- **Media types.**
  - ZOO-Project labels every raw result `application/json` (0026).
  - pygeoapi serves HTML for `*/*` on `/results` (0036), and labels a JSON
    dismissal `text/html` (0037).
- **Results of a failed job.** pygeoapi answers 400, as Requirement 46
  requires. ZOO-Project answers 200 (0041).

### 5.7 Jobs and callbacks

- pygeoapi never reports a job as `running` (0032).
- No team-run implementation sends `Retry-After` (0033).
- A failure is described only in prose on both (0034).
- Both delete a dismissed job, so it can never be read as `dismissed` (0035).
- pygeoapi accepts job-list filters and ignores them (0038).
- **Callbacks** are declared and honoured by both team-run implementations.
  - On pygeoapi, an unreachable callback address can stall a job or fail it,
    and the failure message publishes the callback URL (0047).
  - On neither does a success or failure callback identify its job (0048).
  - Callbacks were not checked on the third-party services.

### 5.8 Discovery and errors

- **Link relations** are written in both the short and the long OGC form
  (0005, 0011, 0029).
- **Paging.** pygeoapi stops the process list at ten entries with no `next`
  link (0018). ZOO-Project pages correctly, but with its own parameter (0019).
- **Links built from configuration.** ZOO-Project builds every link from a
  configured root URL. With the shipped configuration, every link leaves the
  service (0008).
- **Exceptions.**
  - Neither team-run implementation sends RFC 7807 problem documents
    correctly (0001, 0013).
  - ZOO-Project answers an unknown path with 400 (0014), and crashes on an
    unexpected content type (0015).

### 5.9 Silent deviations

In 16 filed findings a server answers with a success status while doing
something other than what was asked:

- pygeoapi: 0018, 0024, 0027, 0028, 0031, 0036, 0038, 0054 and 0058;
- ZOO-Project: 0041, 0051, 0053, 0054, 0060, 0061, 0071 and 0072.

0054 applies to both. A client cannot detect these from the response alone.

### 5.10 Version 2

- Roofer Online declares the 2.0 Core class alongside 1.0.
- The Varidian registry declares a 2.0 process-description class but not 2.0
  Core, so the client speaks 1.0 to it.
- Neither team-run implementation declares 2.0 (pygeoapi including 0.24.0).
- Weaver, run by the team for this purpose only, is the one server found
  that declares 2.0 Core (section 3.2).

### 5.11 Form generation

The bid proposed a catalogue of the process schemas that the form generator
cannot render. The client builds this catalogue as it is used. When it
describes every process of a service (the "process census"), it records, for
each input, which JSON Schema keywords the input's schema uses. It also records
every input that does not get a control of its own, with the reason. The
census was taken on 6 October 2026 in Chromium, against the two team-run
implementations, with the client as it then stood.

| Service | Processes described | Inputs | Inline `type` | `enum` | `$ref` | Composition ¹ | `format` | `contentMediaType` | Raw JSON fallbacks |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| pygeoapi 0.21.0 | 14 of 14 | 27 | 25 | 1 | 1 | 1 | 6 | 1 | 0 |
| ZOO-Project | 701 of 703 ² | 5,098 | 3,662 | 1,279 | 0 | 1,436 | 1,285 | 0 | 0 |

1. `oneOf`, `anyOf` or `allOf`. One schema can use several keywords, so the
   columns do not add up to the number of inputs.
2. ZOO-Project cannot describe two of the processes it lists (0020).

- **No input fell back to raw JSON.** Every input of the 715 processes
  described got a control of its own.
- **Contradictory schemas.** 457 ZOO-Project inputs are booleans whose `enum`
  lists the strings "true" and "false", which no value satisfies (0056). The
  generator follows `type`, shows a checkbox, and records each case.
- **Axis order.** ZOO-Project's `echo` process accepts a bounding box only in
  EPSG:4326, whose axis order is latitude first. The client swaps the axes of
  a box drawn on the map before sending it, and records that it did.
- **Rendered is not accepted.** A schema can be rendered and still not describe
  what the service accepts. ZOO-Project's OGR services declare a GML polygon,
  but accept one only deep inside a feature collection (0065).

These counts show that the generator covers the schemas of the two
implementations, not that it covers every schema in use. The census was not
taken against the third-party services, and the testbed processes on pygeoapi
were written by the team (section 9).

---

## 6. The relay

### 6.1 Motivation

A browser tab cannot do three things a desktop client can. The bid foresaw a
small server-side relay to bridge each:

- **Receive callbacks.** A tab has no address a server can call. The relay
  would give each job a token-protected callback URL, and pass notifications
  to the page over a live connection. Polling would stay the authority on job
  state.
- **Name asynchronous jobs.** Where `Location` is hidden, as on pygeoapi
  0.21.0, the relay can start the job and tell the page its address.
- **Reach services without CORS.** For a configured service only, and only
  after the user confirms, the relay can forward the page's read requests (the
  "read route"). The direct attempt is always made first and recorded, so the
  finding that the service is not usable from a browser is kept.

### 6.2 Implementation

The relay is in the repository and tested:

- per-endpoint configuration;
- session tokens;
- a guard against server-side request forgery (SSRF), which refuses private,
  loopback, link-local and metadata addresses and checks DNS answers and every
  redirect;
- rate limits per client and per endpoint;
- a mark on every response it produces, so its own refusals are never mistaken
  for the service's;
- polling reconciliation in the web interface. A callback only prompts the page
  to poll sooner. The job's state is always taken from the server's own status
  document. A duplicated, reordered or missed callback therefore changes
  nothing, and after a relay restart or a reconnect the page polls every
  unfinished job once, so no change of state is lost.

### 6.3 Security considerations

We decided not to run the relay beside the public web interface. The reasons
are security and operational risk:

- **It would be a proxy on our address.** Creating a session needs no
  credentials, so a session token proves only that someone asked for one.
  Restricting origins limits browsers, but a script ignores it. Rate limits
  bound how much traffic passes, not who sends it.
- **Third-party operators would see our traffic, not their users'.** A public
  relay sends requests to other organisations' servers from our address. That
  is acceptable only with each operator's agreement, and the relay's production
  configuration lists no endpoints.
- **The attack surface would last at least six months.** Any server that fetches
  on behalf of anonymous users is a target for SSRF. Mitigation is in place,
  but it would have to be maintained for the whole public-demo period.
- **Callbacks are unsafe on pygeoapi.** There, an
  undeliverable callback can stall a job or fail it, and the callback URL is
  published in the job's message (0047). A relay that is redeployed or briefly
  down would damage users' jobs.
- **The need fell.** By the second plugfest, many testbed services already
  sent CORS headers.

### 6.4 Consequences

- The hosted interface works with services that send CORS headers.
- It polls instead of using callbacks.
- Against pygeoapi before 0.24.0 it cannot run asynchronous jobs.

The relay stays in the repository. An operator who accepts these
responsibilities can run it for their own services.

---

## 7. Discussion

### 7.1 CORS as the gate

For RQ1 the answer is conditional. A browser client can use a service directly
only when the service enables CORS. Asynchronous execution, the mode intended
for long computations, also needs one exposed response header. The standard
already recommends both (§7.6 Recommendations 4 and 5). Half the deployments
tested meet the first, and one meets both. A conformance test run outside a
browser cannot observe either.

### 7.2 Declarations versus behaviour

Both team-run implementations differ from their own declarations:

- pygeoapi under-declares (0006) and over-declares (0059);
- ZOO-Project lists processes it cannot describe or run (0020, 0066, 0070).

A client that selects behaviour from the conformance document and process
list alone would disable capabilities that work, and offer ones that fail. The
client therefore treats declarations as hints, and records what each request
actually returned. This is the reason for the `undeclared` and
`declared-not-working` outcomes.

### 7.3 Silent deviations

The 16 silent deviations share a pattern. The request is accepted and a
plausible result is returned. The difference from what was asked is visible
only to someone who already knows what to expect. Because neither team-run
implementation validates inputs (0054), the checks in the generated form are
the only checks a user gets.

### 7.4 Divergent implementations

The `raw` default (§7.11), the results-document schema (Requirement 32) and the
status code of a failed job's results (Requirement 46) are all specified. Yet
different implementations answered the same request in different shapes
(section 5.6). A client written against one implementation fails against
another. A client written against the standard needs tolerances for each.

### 7.5 Limited test targets

The number of services that were fully functional from a browser was too
small to serve as a reference. In the absence of such a baseline, observed
failures could not readily be attributed to the client, the server or the
standard, which made shortcomings harder to locate.

**What "fully functional" means here.** A service a page can reach, that runs
processes synchronously and asynchronously, and whose results a page can read.

**Of the six deployments, only the Varidian registry met that bar.** The
others fell short:
- pygeoapi with CORS on cannot run asynchronous jobs from a page (0039).
- ZOO-Project-DRU loses CORS on multi-output answers (0067, 0068).
- ZOO-Project, pygeoapi with CORS off, and Roofer Online cannot be reached at
  all.
- Weaver, the only server declaring the 2.0 draft, sends no CORS headers and
  runs a single process.
- The services of several testbed parties could not be tested at all.

**Without a fully working service as a baseline, a failure has three possible
causes:**
- the client;
- the server;
- an ambiguity in the standard.

Telling them apart took a second implementation and a reading of the
specification text, finding by finding. Where both team-run implementations
behaved differently, as with the results of a failed job (0041), the standard
had to decide which one was right. Where both behaved the same way, as with
dismissed jobs (0035), it took a close reading to see that the gap was in the
standard.

**Some of the client's own shortcomings stayed hidden for the same reason:**
- **`Retry-After`.** A defect in the client's handling of the header went
  unnoticed, because no server ever sent one (0045).
- **Version 2.** The client's browser path has never completed a run against a
  version 2 server.
- **Callbacks.** They could not be checked against any third-party service.
- **Result formats.** The client renders only the formats services actually
  returned, so formats no tested service produced remain unexercised.

The findings in this report are therefore weighted towards what the two
team-run implementations do. A larger set of working testbed services would
be the most useful next step, for this client and for any other.

### 7.6 Gaps in the standard

| Gap | Finding |
| --- | --- |
| On dismissal, clause 13.3 requires 404 for a job that no longer exists, while Security Considerations III.C say a repeat dismissal returns 410. No requirement makes the `dismissed` status readable. | 0035 |
| Version 1.0 has no machine-readable cause for a failed job: the job status document has no `exception` member. The version 2 draft adds one. | 0034 |
| Nothing requires a job to be reported as `running`, or defines what `progress` must mean. | 0032 |
| Nothing defines what happens when a callback cannot be delivered, and no callback has to identify its job. | 0047, 0048 |

---

## 8. Recommendations

### 8.1 CORS configuration

A service meant for browser-based viewers should answer every response, errors
and multipart answers included, with headers along these lines:

```http
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Accept, Prefer
Access-Control-Expose-Headers: Location, Link, Preference-Applied, Retry-After, Content-Crs, Content-Disposition
```

- **Answer the preflight.** An `OPTIONS` request must get a 2xx with these
  headers. Roofer Online's 405 blocks every `POST` and `DELETE` (0064).
- **Expose `Location`.** Without it, a browser cannot use asynchronous
  execution (0002, 0039, 0069). The other headers carry paging, the applied
  preference, the polling interval, the coordinate system and the file name.
- **pygeoapi operators should run 0.24.0 or later** with `cors: true`. Earlier
  releases expose no headers at all.
- **Test from a browser.** `curl` and the OGC validator do not apply CORS. A
  page on another origin, or the hosted interface, does.

### 8.2 Access control

Some services need to know who calls them, to set quotas or to protect data.
An API key is the simplest scheme. If one is used:

- **Document it.** Put it in the OpenAPI definition, as Requirement 63 asks
  for access-controlled services [1].
- **Send it in a header, not the query string.** Query strings end up in logs
  and in the addresses of linked resources. The core deliberately does not
  carry query parameters from one resource to another.
- **Allow the header in CORS.** List it in `Access-Control-Allow-Headers`. An
  `Authorization` header must be named explicitly: the `*` wildcard does not
  cover it [10].
- **Treat a key in a web page as public.** Anyone who opens the page can read
  it. Use such a key to identify an application and limit its quota, not to
  protect data. Data that must be protected needs per-user authentication,
  such as OAuth 2.0 or OpenID Connect.
- **Keep the job list and dismissal access-controlled.** 18-062r2 recommends
  this [1].

**The client does not implement API keys today**, because 18-062r2 defines no
authentication scheme. If testbed services adopt one, it is a small addition:
a per-endpoint key setting in the web interface, kept only in the user's
browser. A developer using the core can already send a key through their own
`fetch`.

### 8.3 nLDT profile guidance

The following guidance is proposed to Geonovum for an nLDT profile of OGC API –
Processes. Each item **raises** an existing recommendation to a requirement,
**restates** a requirement that a tested implementation does not meet, or
**adds** a rule the standard does not have.

1. **Raises §7.6 Recommendation 4.** A service intended for browser clients
   SHALL support cross-origin requests, including preflights for `POST` and
   `DELETE`, on every response. *(0040, 0049, 0064, 0067)*
2. **Raises §7.6 Recommendation 5.** A service that supports asynchronous
   execution SHALL expose `Location`, and should carry a `monitor` link in the
   `201` body. *(0002, 0004, 0039, 0069)*
3. **Adds.** An access-controlled service SHALL use a scheme documented in its
   OpenAPI definition and sendable from a browser, and SHALL allow its header in
   CORS. *(section 8.2)*
4. **Restates Requirements 24 and 49.** Inputs SHALL be validated against the
   process description, and an invalid input SHALL be answered with 400.
   *(0031, 0054, 0016)*
5. **Restates Requirements 18 and 24.** An input by reference SHALL be resolved
   before the process runs, and a failed fetch SHALL fail the execution.
   *(0058, 0053)*
6. **Restates §7.11.** A body carrying only `inputs` SHALL be accepted.
   *(0025)*
7. **Restates Requirements 28 and 32.** A `document` response SHALL be an object
   keyed by output identifier. `*/*` on `/results` SHALL return the output's
   own media type. *(0027, 0036)*
8. **Restates Requirements 69 and 71.** Job-list parameters SHALL be honoured or
   rejected with 400. *(0038)*
9. **Restates §7.10.** A process description SHALL state the process's own
   execution and transmission modes, and a listed process SHALL be executable.
   *(0059, 0066)*
10. **Adds.** `Location` should be sent only with 201 or 202. *(0024)*
11. **Adds.** A job should be reported as `running` once it has begun. *(0032)*
12. **Adds, once the standard is resolved.** A dismissed job should remain
    readable as `dismissed` for a documented period. *(0035)*
13. **Adds.** Failing to deliver a callback SHALL NOT change a job's status, and
    callback requests should identify the job. *(0047, 0048)*
14. **Restates `/req/core/process-exception`.** Exceptions SHALL be RFC 7807
    problem documents. *(0001, 0013)*

### 8.4 Client development

For developers of other clients, the findings suggest the following practices.

- Treat the conformance declaration as a hint, and check what each request did
  (0006, 0059).
- Send `Accept` explicitly on every request, and parse before trusting a JSON
  label (0007, 0026, 0036).
- Follow `next` links rather than building `offset` URLs (0018, 0019).
- Read a job's outcome from its status, not from the status code of `/results`
  (0041).
- Choose the protocol version before sending, and never retry an execution in
  another version (section 3.2).
- Pace polling yourself, since no tested server sends `Retry-After` (0033).

---

## 9. Limitations and future work

- **Uneven evidence.**
  - Most findings come from the two implementations the team ran, which were
    tested continuously.
  - Four filed findings come from services run by others.
  - The services of several testbed parties could not be tested at all.
- **Process variety.**
  - pygeoapi's processes were written to cover cases, so they show how the
    framework behaves.
  - ZOO-Project's shipped catalogue shows how real processes are described.
- **Releases.** Later releases may behave differently. pygeoapi 0.24.0 already
  fixes the hidden `Location`, and moving the reference server to it is
  planned. Each finding names the release it was seen on.
- **Version 2.** It is supported against the pinned draft, released in 0.6.0,
  and tested against one real server, from Node only.
- **Browser.** Browser behaviour was verified in Chromium only.
- **Untested paths.** The client's `Retry-After` handling has never met a
  server that sends the header (0033, 0045).
- **Measurement conditions.** ZOO-Project's worker-pool decay was measured
  under emulation on Apple Silicon (0044).
- **Confidence.** 16 findings are below high confidence. Medium: 0004, 0005,
  0010, 0012, 0016, 0017, 0023, 0030, 0031, 0052, 0056, 0061, 0065, 0070 and 0071.
  Low: 0043. Each states what would raise it.

The bid named four risks. Three of them concern the services and the client.
The first two occurred; the third did not, in the services tested:

| Risk in the bid | Mitigation in the bid | Outcome |
| --- | --- | --- |
| Services lack callback support | Polling as the baseline; absence reported as a finding | Of the services tested, callbacks were declared and working on pygeoapi and ZOO-Project only. The hosted interface polls (section 6.4) |
| Services lack CORS headers | A proxy as a fallback; the direct attempt is always made and recorded | 3 of 6 deployments could not be used from a page (section 5.3). The proxy was built but not deployed (section 6.3) |
| The form generator cannot render a schema | A raw JSON fallback; failures catalogued | No input of the 715 processes described fell back (section 5.11) |

---

## 10. Conclusion

We built a browser client for OGC API – Processes:

- a protocol core that other viewers can embed;
- a web interface that turns any reachable service into forms and map results
  without code.

Testing it against six deployments shows that conformance as tested today does
not imply usability from a browser:

- CORS decides whether a page can reach a service at all.
- An unexposed `Location` decides whether asynchronous jobs can be used.
- Declarations and behaviour diverge in both directions.
- Implementations answer the same request in different shapes.
- Many deviations are silent.

A relay could hide some of this, at a security cost we chose not to take on
for a public demonstration. The more durable fix is on the service side. Most
of the proposed guidance restates requirements or raises existing
recommendations, which makes it a modest ask of implementers, and one a
profile can check.

---

## Availability

The client is available in three forms:

| What | Where |
| --- | --- |
| Web interface | https://oap.breinstein.nl |
| Source code, MIT licence | https://github.com/ITBreinstein/oap-client |
| Protocol core on npm | https://www.npmjs.com/package/@breinstein/oap-client (`@breinstein/oap-client`, latest release 0.6.0) |

- **Licences.** This report is published under the Creative Commons
  Attribution 4.0 International licence (CC BY 4.0). The software is published
  under the MIT licence.
- **Uptake in an app store.** The tender asks that the component be ready for
  uptake in an app store. The installable unit is the npm package. It carries
  its own type declarations and exports a single entry point, and its README
  documents the public API: discovery, processes, execution, jobs and versions.

---

## References

1. OGC (2021). *OGC API – Processes – Part 1: Core*, version 1.0.0, OGC
   18-062r2. B. Pross and P. A. Vretanos (eds.).
   https://docs.ogc.org/is/18-062r2/18-062r2.html
2. OGC (2026). *OGC Seeks Public Comment on Proposed OGC API – Processes
   Standard Version 2, Parts 1 and 2.*
   https://www.ogc.org/requests/ogc-api-processes-standard-version-2-public-comment/
3. OGC. *OGC API – Processes – Part 1: Core Conformance Test Suite.*
   https://cite.ogc.org/teamengine/about/ogcapi-processes-1.0/1.0/site/
4. OGC (2021). *OGC Testbed 17: CITE Engineering Report*, OGC 21-044.
   L. Bermudez (ed.). https://docs.ogc.org/per/21-044.html
5. pygeoapi. *Introduction* (documentation, release 0.24.0).
   https://docs.pygeoapi.io/en/stable/introduction.html
6. pygeoapi. *Publishing processes via OGC API – Processes.*
   https://docs.pygeoapi.io/en/stable/publishing/ogcapi-processes.html
7. H. Yu. *ogcapi-js: a lightweight and modular JavaScript library for OGC
   APIs.* https://github.com/haoliangyu/ogcapi-js
8. Camptocamp. *ogc-client: a TypeScript library for interacting with
   OGC-compliant services.* https://npmjs.com/package/@camptocamp/ogc-client
9. OSGeo. *OWSLib.* https://www.osgeo.org/projects/owslib/
10. WHATWG. *Fetch Standard*, CORS protocol. https://fetch.spec.whatwg.org/
11. M. Nottingham and E. Wilde (2016). *Problem Details for HTTP APIs*, RFC 7807;
    R. Fielding, M. Nottingham and J. Reschke (eds.) (2022). *HTTP Semantics*,
    RFC 9110.
12. OGC (2023). *2023 Open Standards and Open Source Software Code Sprint
    Summary Engineering Report*, OGC 23-025.
    https://docs.ogc.org/per/23-025.html
13. M. Grothe and E. Koomen (2025). *Verkenning interoperabiliteit van
    rekenmodellen en digitale tweelingen.* Amersfoort: Geonovum.
14. Geonovum. *nLDT Architectuur.* https://geonovum.github.io/NLDT-Architectuur/en/
15. Breinstein. *@breinstein/oap-client* (npm package) and *oap-client*
    (source repository).
    https://www.npmjs.com/package/@breinstein/oap-client ·
    https://github.com/ITBreinstein/oap-client
16. OSGeo. *ZOO-Project.* https://www.osgeo.org/projects/zoo/
17. ZOO-Project. *Optional DRU support* (documentation).
    https://zoo-project.github.io/docs/kernel/dru.html
18. QGIS. *QGIS User Guide*, version 3.44, "OGC client support".
    https://docs.qgis.org/latest/en/docs/user_manual/working_with_ogc/ogc_client_support.html
19. OSGeo. *Terra Draw.* https://www.osgeo.org/projects/terra-draw/

---

## Annex A. Findings

| id | server | area | outcome | severity | confidence | client impact | title |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0001 | pygeoapi | errors | non-conformant | major | high | handled | pygeoapi exception bodies are not RFC 7807 problem documents |
| 0002 | pygeoapi | cors | non-conformant | blocking | high | blocked | pygeoapi with CORS on does not send Access-Control-Expose-Headers, hiding Location from browsers |
| 0003 | pygeoapi | jobs | conformant | minor | high | handled | The job document's `type` member is "process", colliding with RFC 7807's `type` |
| 0004 | pygeoapi | execution | non-conformant | minor | medium | handled | pygeoapi returns a `null` body with the async 201, not a job status document |
| 0005 | pygeoapi | links | non-conformant | major | medium | handled | pygeoapi advertises conformance in the short form and processes in the long OGC URI form, on the same landing page |
| 0006 | pygeoapi | conformance | undeclared | major | high | handled | pygeoapi supports dismiss and job-list but declares neither conformance class |
| 0007 | pygeoapi | negotiation | conformant | major | high | handled | pygeoapi answers a browser-like Accept header with HTML at 200, and `*/*` with JSON |
| 0008 | zoo-project | links | conformant | major | high | none | ZOO-Project builds every advertised href from a configured root URL and never consults the request |
| 0009 | zoo-project | cors | unsupported | blocking | high | degraded | ZOO-Project sends no CORS headers for any origin, including the one its own configuration allows |
| 0010 | zoo-project | errors | non-conformant | major | medium | handled | ZOO-Project answers the landing page without its trailing slash with 400 and a WPS 1.0 XML exception report |
| 0011 | zoo-project | links | conformant | informational | high | handled | ZOO-Project writes conformance and processes in the long OGC URI form, the mirror image of pygeoapi |
| 0012 | zoo-project | negotiation | non-conformant | minor | medium | handled | ZOO-Project ignores Accept entirely and answers the standard f=json parameter with 400 |
| 0013 | zoo-project | errors | non-conformant | minor | high | handled | ZOO-Project exception bodies are RFC 7807 shaped but the type is a bare token on every exception except NoSuchProcess |
| 0014 | zoo-project | errors | non-conformant | major | high | degraded | ZOO-Project answers an unknown path under the API with 400, not 404 |
| 0015 | zoo-project | errors | non-conformant | major | high | handled | ZOO-Project segfaults on a POST carrying a content type it does not expect |
| 0016 | zoo-project | execution | non-conformant | major | medium | none | ZOO-Project reports an input its own service rejected as 500, not 400 |
| 0017 | zoo-project | links | non-conformant | minor | medium | none | ZOO-Project process descriptions advertise an execute link but no self link |
| 0018 | pygeoapi | links | non-conformant | major | high | degraded | pygeoapi cuts /processes at ten with no next link, and silently ignores offset |
| 0019 | zoo-project | links | non-conformant | minor | high | handled | ZOO-Project pages the process list with `skip`, not the `offset` Common defines |
| 0020 | zoo-project | errors | declared-not-working | major | high | degraded | ZOO-Project lists two processes whose descriptions answer 500 with an Apache HTML page |
| 0021 | pygeoapi, zoo-project | links | conformant | informational | high | none | Both servers advertise a self link on each process list entry, including ZOO |
| 0022 | zoo-project | execution | undeclared | minor | high | handled | ZOO-Project carries `extended-schema` and `raw_schema1` alongside `schema` on 28% of inputs |
| 0023 | pygeoapi, zoo-project | execution | conformant | informational | medium | none | A bounding-box input is an inline object with `format: "ogc-bbox"`, not a $ref |
| 0024 | pygeoapi | execution | non-conformant | major | high | handled | pygeoapi sends a Location header on every synchronous execution, including on 400s |
| 0025 | zoo-project | execution | non-conformant | blocking | high | degraded | ZOO-Project cannot parse an execute body that carries only `inputs` |
| 0026 | zoo-project | results | non-conformant | major | high | handled | ZOO-Project labels raw-mode results `application/json` whatever they actually are |
| 0027 | pygeoapi | results | non-conformant | major | high | none | pygeoapi answers `response: "document"` with the process's own answer inside a one-element `outputs` array |
| 0028 | pygeoapi | execution | non-conformant | minor | high | none | pygeoapi silently ignores the `outputs` block, including modes it never declared |
| 0029 | pygeoapi, zoo-project | links | conformant | informational | high | handled | Both servers advertise the execute endpoint only as the long OGC relation URI |
| 0030 | pygeoapi, zoo-project | negotiation | conformant | informational | medium | none | Neither server varies the execute response by Accept, including for a browser's header |
| 0031 | pygeoapi, zoo-project | execution | non-conformant | major | medium | degraded | An array sent for a single-valued input leaks a Python traceback from ZOO and is stringified by pygeoapi |
| 0032 | pygeoapi | jobs | non-conformant | major | high | handled | pygeoapi reports a job as accepted for its entire execution and never as running |
| 0033 | pygeoapi, zoo-project | jobs | unsupported | minor | high | handled | Neither reference server sends Retry-After on any job status response |
| 0034 | pygeoapi, zoo-project | jobs | non-conformant | major | high | degraded | Neither server sends an exception member on a failed job; the failure is prose in message |
| 0035 | pygeoapi, zoo-project | jobs | non-conformant | major | high | handled | Both servers delete a dismissed job outright rather than reporting status dismissed |
| 0036 | pygeoapi | negotiation | non-conformant | major | high | handled | pygeoapi's job results endpoint content-negotiates and answers HTML for Accept */* |
| 0037 | pygeoapi | negotiation | non-conformant | minor | high | handled | pygeoapi returns a JSON job document from DELETE under Content-Type text/html |
| 0038 | pygeoapi | jobs | non-conformant | major | high | handled | pygeoapi accepts processID and status filters on the job list and silently ignores them |
| 0039 | pygeoapi | cors | blocked | blocking | high | degraded | A browser cannot name the job it just started against pygeoapi, on either port |
| 0040 | pygeoapi, zoo-project | cors | non-conformant | major | high | degraded | Job dismissal needs a CORS preflight, which only the CORS-enabled pygeoapi port answers |
| 0041 | pygeoapi, zoo-project | results | non-conformant | major | high | handled | ZOO answers /results for a failed job with 200 and an exception body; pygeoapi answers 400 |
| 0042 | pygeoapi | links | non-conformant | minor | high | handled | pygeoapi job documents carry no self link, and a failed job carries no links at all |
| 0043 | zoo-project | jobs | non-conformant | minor | low | degraded | ZOO intermittently closes the connection with no response when dismissing a running job |
| 0044 | zoo-project | jobs | declared-not-working | major | high | none | ZOO asynchronous capacity decays about one worker per job run and never recovers |
| 0045 | pygeoapi, zoo-project | jobs | unsupported | major | high | handled | With no server sending Retry-After, a parser defect that inverts its meaning went undetected |
| 0047 | pygeoapi | execution | declared-not-working | major | high | degraded | pygeoapi lets an undeliverable callback stall the job, or turn a successful one into failed |
| 0048 | pygeoapi, zoo-project | execution | conformant | major | high | handled | Neither server's success or failure callback names the job; only ZOO's in-progress callback does |
| 0049 | pygeoapi | cors | unsupported | blocking | high | degraded | pygeoapi with cors false is blocked in a browser for every operation; only the relay's opt-in read route, which proxies it, makes it usable |
| 0050 | zoo-project | cors | unsupported | blocking | high | degraded | ZOO-Project cannot be used from a browser at all — no execute, no read; only the relay's opt-in read route, which proxies it, makes it usable |
| 0051 | zoo-project | execution | non-conformant | major | high | handled | ZOO-Project discards the CRS sent with a bounding box and relabels the box with its own default, and accepts three coordinates |
| 0052 | pygeoapi | execution | non-conformant | major | medium | degraded | pygeoapi hands a qualified input value to the process as the wrapper object, not its value |
| 0053 | zoo-project | execution | non-conformant | major | high | none | ZOO-Project runs the process with an empty input when a by-reference input cannot be fetched, and never says the fetch failed |
| 0054 | pygeoapi, zoo-project | execution | non-conformant | major | high | handled | Neither server validates execute inputs against the process description; ZOO checks only that required inputs are present |
| 0055 | zoo-project | errors | non-conformant | minor | high | degraded | ZOO-Project answers a crashed SAGA process with Apache's HTML error page, including for an input inside its declared range |
| 0056 | zoo-project | execution | non-conformant | minor | medium | handled | 457 of ZOO-Project's SAGA inputs are booleans whose enum lists the strings "true" and "false", a schema no value satisfies |
| 0057 | pygeoapi | cors | conformant | informational | high | none | pygeoapi with cors true grants every origin and every request header a preflight asks for, and exposes no response header |
| 0058 | pygeoapi | execution | non-conformant | major | high | none | pygeoapi hands a by-reference input to the process as the link, unresolved |
| 0059 | pygeoapi | execution | declared-not-working | minor | high | handled | pygeoapi describes every process with the server's execution modes and transmission modes, not the process's own |
| 0060 | zoo-project | results | non-conformant | major | high | none | ZOO-Project answers a raw request for outputs by reference with the value itself (one output) or a multipart whose links are in the part bodies (two), never 204 with Link headers |
| 0061 | zoo-project | execution | non-conformant | major | medium | none | ZOO-Project reuses its cached copy of a by-reference input across executions, and never asks whether it changed |
| 0062 | zoo-project | errors | non-conformant | major | high | handled | ZOO-Project's kernel segfaults on a base64 raster sent without `"encoding": "base64"` |
| 0063 | zoo-project | execution | non-conformant | minor | high | handled | ZOO-Project puts a character set (`utf-8`, `UTF-8`, `ascii`) in `contentEncoding` |
| 0064 | roofer-online | cors | unsupported | blocking | high | degraded | Roofer Online (staging) sends no CORS headers and answers every preflight 405, so a web page can reach it only through the relay's read route |
| 0065 | zoo-project | execution | non-conformant | major | medium | none | ZOO-Project's OGR services declare a GML polygon schema, but accept a polygon only five levels deep inside a feature collection |
| 0066 | zoo-project | execution | declared-not-working | major | high | none | The ZOO-Project image points OTB at a directory it does not contain, so every OTB process it lists answers 500 |
| 0067 | zoo-project-dru | cors | non-conformant | major | high | blocked | A hosted ZOO-Project-DRU drops every CORS header from its synchronous multipart answer, so a browser cannot read a foreground run of a process with two or more outputs |
| 0068 | zoo-project-dru | results | non-conformant | major | high | degraded | A hosted ZOO-Project-DRU serves the results of a job with two or more outputs as `application/json` whose body opens with leaked CGI headers and then a multipart |
| 0069 | zoo-project-dru | cors | non-conformant | minor | high | handled | A hosted ZOO-Project-DRU allows any origin but exposes no response header, so a page cannot read `Location`; the 201 body's `monitor` link still names the job |
| 0070 | zoo-project | errors | declared-not-working | major | medium | none | ZOO-Project advertises a LAS input for `SAGA.pointcloud_tools.4` that its SAGA build cannot read, and the kernel segfaults on it |
| 0071 | zoo-project | execution | non-conformant | major | medium | degraded | ZOO-Project answers a synchronous `SAGA.shapes_polygons.5` with `200 {}`, with no output and no exception |
| 0072 | zoo-project | results | non-conformant | major | high | none | ZOO-Project answers a request that omits `response` with a results document, for one output or several, although the default is `raw` |
| 0073 | zoo-project | results | non-conformant | major | high | none | ZOO-Project's raw multipart answer for outputs by value has no line break before each boundary, and puts `Content-Disposition` in the part body |

Number 0046 is retired; it was folded into 0044.
