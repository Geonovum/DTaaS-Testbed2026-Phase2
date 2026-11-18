# Results

In this chapter only the summaries of the participants are included. The full reports from the participants are included in the Annex.

## Adoption topic #1: 3dgi

## Adoption topic #1: Clappform

## Adoption topic #2: GeoLabs

## Adoption topic #3: Breinstein

## Adoption topic #3: Imagem

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

Our main conclusion: **CWL works as a recipe format, but not unextended.** CWL describes ingredients, order and wiring well. It cannot say where a step's OGC API Process lives, which alternative processes a hub may use, or describe process inputs as precisely as JSON Schema does. We added three small extension fields in a declared `nldt:` namespace to close those gaps; with them, all five bundled recipes pass the reference validator, `cwltool --validate`.

Other key findings:

* CWL's abstract `Operation` step maps one-to-one onto a remote OGC API Process.  
* CWL's own `File` \+ `format` cleanly separates data ingredients from parameters, and maps onto OGC by-reference (`href`) inputs.  
* OGC API Processes descriptions do not say machine-readably which inputs are datasets, so the recipe must declare it.  
* Asynchronous execution with job polling is mandatory in practice for long-running processes.  
* DCAT-AP-NL has no recipe concept yet; proposing the extension is the main open research item.  
* Writing CWL by hand is hard for non-specialists; a guided editor is essential.  
* Every part of the stack works from one plan: the Cookbook Registry turns a recipe into a DAG, and the editor, catalogue, Wizard, Status tab and Cook all ask it for that plan instead of reading the CWL themselves.  
* An OGC API Process description already carries most of what a user needs to fill in a parameter (title, description, default, limits); the Wizard reads it when it shows the form, so recipes need not copy it.

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