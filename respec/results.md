# Results

In this chapter only the summaries of the participants are included. The full reports from the participants are included in the Annex.

## Adoption topic #1: 3DGI

3DGI added an OGC API – Processes interface to [Roofer Online](https://roofer-online.nl), which reconstructs 3D buildings from point clouds and building footprints. The contribution addresses Topic 1: exposing an existing calculation module through the nLDT architecture and making it usable by other vendors' clients.

There are two versions of the Roofer Online processes API.

- `v1`: A public demo that was developed for the testbed, and it uses fixture data. Live at [https://processes.staging.roofer-online.nl/ogcapi](https://processes.staging.roofer-online.nl/ogcapi).
    - [process catalogue](https://processes.staging.roofer-online.nl/ogcapi/processes)
    - [Swagger UI](https://processes.staging.roofer-online.nl/ogcapi/docs)
    - [OpenAPI document](https://processes.staging.roofer-online.nl/ogcapi/openapi.json)
- `v2`: The client-facing live Roofer Online processes API, which requires a Roofer Online account and authentication. Live at  [https://roofer-online.nl/ogcapi](https://roofer-online.nl/ogcapi).

|                | v1: public testbed demo                                                       | v2: live Roofer Online API                                                      |
|----------------|-------------------------------------------------------------------------------|---------------------------------------------------------------------------------|
| Purpose        | Let participants test discovery, execution, job handling and process chaining | Run building reconstruction within Roofer Online                                |
| Processing     | Deterministic fixture results and sample CityJSON/GeoPackage files            | Point-cloud ingestion, BAG selection, reconstruction and export                 |
| Access         | Public, no access restriction                                                 | Public discovery; authenticated execution, jobs, results and artifact downloads |
| Processes      | Separate validation, reconstruction and conversion processes                  | One reconstruction process incorporating preparation and requested exports      |
| Execution      | Synchronous and asynchronous                                                  | Asynchronous only                                                               |
| Testbed status | Tested                                                                        | Not tested because authentication is required                                   |

The reusable components and v1 implementation are public on GitHub, with Apache-2.0 licence: https://github.com/3DGI/roofer-online-processes


## Adoption topic #1: Clappform

## Adoption topic #2: GeoLabs

__Results at a glance__

| Question | Answer |
|---|---|
| Is the service available through OGC API - Processes? | Yes, at https://host1.tb.geonovum.geolabs.fr/ogc-api/ and https://host2.tb.geonovum.geolabs.fr/ogc-api/ |
| Does it pass the official OGC test suite (Part 1: Core 1.0)? | Yes: 3 of 3 conformance classes; 53 tests passed, 0 failed, 1 skipped for `host1` |
| Does it pass the Geonovum `ogc-checker`? | Yes: 0 diagnostics of any kind, with the version 1.0.0 rules on `host1` and with the version 2.0.0 rules on the second Server Instance `host2` |
| Does it support sync and async execution and job management? | Yes, on all three processes on the two server instances |
| Does it work with version 2.0 of the standard (draft)? | Yes, as far as the tools can tell: the `host2` Server Instance passes `ogc-checker` 2.0.0 with 0 diagnostics; available in the ZOO-Project-DRU Helm chart since version 0.10.5. However, some endpoints are not yet implemented. |
| Can other participants’ clients use the service? | Partly, they can discover, describe, and run its processes. One client could also display the route on a map; another had issues detecting the input data types/formats, as discussed in Section 5. |
| What did the testbed deliver beyond the service? | The routing service working as a process accessible from an OGC API - Processes - Part 1: Core Server Instance, three corrections merged into the official OGC schemas, Docker packaging merged into `ogc-checker`, two Server Instances for testing, and six recommendations (Section 9). |


## Adoption topic #3: Breinstein

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

## Adoption topic #3: Imagem

Implement an OGC API Processes client, make it function within the nLDT ecosystem and have it interoperate with software from other software vendors.

__Approach__

For IMAGEM, the approach was to continue to build on the progress made in the previous testbeds (2024 & 2025). In these testbeds, first explorations were done to work with OGC API Processes. Where it all started as a static implementation of OGC API Processes, a more complete implementation of the OGC API Processes (v2) was the aim for this testbed.

In this approach, some new features of the OGC API Processes were tested and implemented in the Digital Twin client (Planspace Simulator). On one side this meant an attempt to create a user interface based on the input and output descriptions of the OGC API Processes provided during this testbed. On the other hand a Job Management System had to be implemented to track the Async processes of this testbed (In previous testbeds, only Sync processes were part of the Adoption topics).

Going into detail, the approach can be divided in four steps:

- **Creating a catalogue with OGC API Processes**
- **Generating UI elements based on the process definition**
- **Creating the Job Management System in the client to manage the Async job executions**
- **Visualising the results of the OGC API Processes.**

__Client implementation__

The client is the OGC API Explorer in the Planspace Simulator. It is not tied to specific processes: the user selects an OGC API endpoint (Varidian's registry is the default, other endpoints can be added) and the explorer uses the conformance declaration to enable the parts the endpoint supports:

- **Collections** (OGC API - Features): browse collections, filter on queryables and add a collection as a layer to the map.
- **Processes** (OGC API - Processes): the input form is generated from the process description (JSON Schema), including GeoJSON inputs that can be drawn, uploaded or edited. A process can be executed synchronously or asynchronously, depending on its `jobControlOptions`.
- **Jobs**: asynchronous executions are listed and polled until they finish, with status, progress and timestamps. Jobs can be dismissed when the endpoint supports it, and the results of a finished job can be opened.
- **Results**: outputs are rendered read-only from the output schema. GeoJSON, GeoTIFF and feature collection outputs can be added to the map as a layer.

## Research topic #4: Collaboral

Collaborall investigated how a *recipe* — a combination of data sources and an ordered
list of processes — can be described, found and executed in a national digital-twin App
Store, using OGC API Processes, OGC API Records and DCAT-AP-NL. We built the answer on ANT,
our existing workflow platform, because that is the realistic case: an organisation adopts
these standards on the platform it already runs.

Our main findings and advice:

1. **A recipe needs its own place in DCAT-AP-NL.** It is neither a dataset nor a data
   service. We propose a small extension — two classes and six properties — that catalogues
   a recipe beside the datasets and services it uses, so a catalogue can answer *which
   recipes use this service or this dataset*. The extension validates against the published
   DCAT-AP 3.0 and DCAT-AP-NL 3.0 shapes.
2. **A process and a recipe differ in visibility, not in structure.** A process is a black
   box and is catalogued as an ordinary `dcat:DataService`; a recipe is a transparent
   composition whose steps can be inspected.
3. **Arazzo is not enough for recipes.** It describes a sequence of API calls and nothing
   else of a workflow. We moved to the Open Workflow Specification (OWS); another awardee
   independently left Arazzo as well. We advise Geonovum to choose one recipe language and
   the subset of it a recipe may use.
4. **No standard and no platform carries a value from one step to the next.** That wiring is
   described by the recipe language and has to be executed by whoever runs the recipe.
5. **A catalogue that conforms to the profile can still be rejected by a harvester.** The
   harvester behind data.europa.eu refuses our valid catalogue because of the links that
   make a recipe a recipe. An extension needs to be tested against real harvesters, not
   only against shapes.
6. **Several recipes ask for the same plan in different shapes.** A shared, published
   concept set for a *scenario* — an area and a building programme — would let one input
   serve many recipes. We built a proof of concept on an existing OGC keyword.

## Research topic #4: FutureInsight

We built a working, end-to-end App Store for recipes: a catalogue (OGC API Records over CKAN), a Cookbook Registry, a Cook that is itself an OGC API Process, and a web client. Recipes are written in CWL v1.2 and executed against our own processes and external testbed processes (roofer, Geolabs ZOO-Project, Varidian).

Our main conclusion: **CWL works as a recipe format, but not unextended.** CWL describes ingredients, order and wiring well. It cannot say where a step's OGC API Process lives, which alternative processes a hub may use, or describe process inputs as precisely as JSON Schema does. We added three small extension fields in a declared nldt: namespace to close those gaps; with them, all five bundled recipes pass the reference validator, cwltool --validate.

Other key findings:

- CWL's abstract Operation step maps one-to-one onto a remote OGC API Process.
- CWL's own File + format cleanly separates data ingredients from parameters, and maps onto OGC by-reference (href) inputs.
- OGC API Processes descriptions do not say machine-readably which inputs are datasets, so the recipe must declare it.
- Asynchronous execution with job polling is mandatory in practice for long-running processes.
- DCAT-AP-NL has no recipe concept yet; proposing the extension is the main open research item.
- Writing CWL by hand is hard for non-specialists; a guided editor is essential.
- Every part of the stack works from one plan: the Cookbook Registry turns a recipe into a DAG, and the editor, catalogue, Wizard, Status tab and Cook all ask it for that plan instead of reading the CWL themselves.
- An OGC API Process description already carries most of what a user needs to fill in a parameter (title, description, default, limits); the Wizard reads it when it shows the form, so recipes need not copy it.

## Research topic #4: Varidian

Varidian started in May 2026 with creating a registry. The initial goal of this registry was to provide a standardized
interface for connecting with multiple data sources. All communication would go through the registry and data
source-specific logic only has to exist inside this registry and its connected microservices instead of inside every
individual client. Quickly after the initial working version, the need arose to also be able to execute processes using
a standardized interface. Both registry implementations for these features were based on the OGC Features and OGC
Processes API’s; and after finalizing the initial implementation for the processes interface in the registry the need
for chaining processes became abundantly clear. This is when the overlap between the registry’s roadmap and *Research
topic #4: App-Store / Recipes* of the testbed was observed. We are building a catalog of collections and processes to
fill the gaps in information and analysis that our own solutions run into. This testbed lets us find out whether recipes
can be added to this catalog, where recipes are a combination of data-sources (ingredients) and operations in the form
of an ordered list of processes (like cooking instructions. An important aspect of experiencing whether recipes fit in
our catalog is to determine whether stating requirements about a recipe up front makes it possible to say something
about the quality of the results that come out. Without reliable outcome, the selection of the most applicable or
trustworthy recipe comes down to luck or expertise. Since we want to be able to use the results as information source
for our own solutions, needing either luck or expertise means it is not ready to be integrated. By researching which
metadata is required to enrich both the source data and the process’s inputs and outputs we hope to find a way to make a
recipe’s results readable and trustworthy, which is exactly the focus of this research topic.

## Research topic #5: ThePeopleGroup

The People Group implemented an exporter and an importer for Scene Context JSON (SCX) in its DigitalTwin platform and opened the exported scenes side by side in CesiumJS and ArcGIS. This report documents what we found, with the documents, code, measurements and service responses each finding is based on, and translates the findings into proposals for the SCX specification.

The main conclusions:

- **The camera position travels, the lens does not.** Position, heading and tilt were reproduced exactly in three engines. The visible area differed by almost a factor of two because each engine uses a different default and definition of the field of view. We added `fov` and propose projection type and clipping planes (1.2).
- **The nested `interval` structure is hard to implement and easy to get wrong.** It required workarounds in a typed environment and our own exporter produced output that does not validate. We propose a simple `{ start, end }` object (1.1).
- **A layer reference must be complete and typed unambiguously.** An incomplete WMS URL produced two different pictures from one document, and independently written exporter and importer code already disagreed on format strings. We propose that `url` is the complete request and a closed `type`/`format` table (1.4, 1.5).
- **The same 3D Tiles give different results per viewer.** All 1309 building tiles of one dataset contain invalid glTF that Cesium-based viewers accept and ArcGIS silently does not draw; heights stored as NAP but declared ellipsoidal cause a vertical offset of about 41 m in ArcGIS; instanced tree tiles are not supported by ArcGIS at all. We propose per-layer metadata for tile version, content type and vertical datum (1.6, 1.9).
- **Simulation results cannot be exchanged yet.** 21 of the 28 resources in the test scene, including every time-dependent simulation result, have no stable URL another viewer can request. The 4D part of the scene therefore cannot be exported today (2.3).
- **Results between implementations are only comparable with a shared status vocabulary** per layer (1.7).

## Research topic #5: uCrowds

Crowd simulation helps event organizers evaluate pedestrian movement and identify potential safety risks before an event takes place. Temporary event infrastructure, such as stages, barriers, entrances, and exits, is typically designed in CAD applications. Crowd simulation modelers often need to manually recreate walkable areas, obstacles, and other relevant features from these designs. This process is time-consuming, introduces opportunities for errors, and must be repeated when event designs change.

This research investigates how SCX, a lightweight format for exchanging scene information between applications, can be extended to support crowd simulation. The extension presented in this report adds semantic information to geographic data, allowing simulation applications to distinguish between features such as walkable areas, obstacles, entrances, exits, and queues.

The research was carried out by uCrowds and AniVizzion. AniVizzion implemented the export workflow in SCAD Re-Event, while uCrowds implemented the import workflow in SimCrowds. The demonstration showed that event designs can be transferred directly from CAD into SimCrowds, where the relevant simulation objects and a navigation mesh are created without manual redrawing.

The workflow automates construction of the simulation environment, although users must still connect simulation objects into pedestrian flows and configure simulation parameters. Further research could improve interoperability through shared semantic definitions, investigate applications in other simulation domains, and explore closer integration between CAD design and simulation.