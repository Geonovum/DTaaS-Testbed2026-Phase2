# nLDT Sandbox Stack UI

## 1. What is it?

A static-file, no-build-step browser UI for the **Geonovum Testbed 2026 nLDT
Sandbox Stack**. The browser calls the actual backend services directly
(`js/sandboxApi.js`) — Records Wrapper, Cookbook API Registry, Cook
Orchestrator, Hub Datasets, and each tool service's own OGC API Processes
self-description. Recipes, apps and datasets shown here are real, live, and
genuinely executable.

`js/sandboxApi.js` holds every backend call; `js/data.js` maps the results onto
the shapes the catalogue views read. The only static files under `data/` are
the ones the Sandbox Stack has no API for:
the nLDT Sandbox Hub itself (`hubs.json`), its participant list
(`participants.json`), and a fallback stub of the "Sandbox Stack Recipe
Results" dataset (`datasets.json`) shown when Hub Datasets isn't reachable.

### Parameters and data inputs

A recipe's inputs come in two kinds, and the recipe's own CWL says which is which —
nothing in the UI is configured per recipe:

- **Parameters** — a value the person running the recipe types in (a number, a
  text, a JSON object): any CWL type other than `File`. Shown on the Wizard's
  **Parameters** step, generated from the recipe's JSON Schema. Where the
  recipe leaves them out, a parameter's title, description, default and
  limits are filled in from the OGC process description of the app (step) it
  feeds (`js/views/recipeWizard.js`, `effectiveParamProps`).
- **Data inputs** — a dataset they pick from the Data Catalogue: a CWL input of
  `type: File` (or `File?`, `File[]`) with a `format:` media type, e.g.
  `format: iana:application/geo+json`. The Cookbook Registry lists them as
  `data_inputs` in the recipe's DAG; `js/data.js` (`ingredientsFromDag`) turns
  them into the Wizard's **Data Ingredients** step. `js/dataFormats.js` maps each
  media type onto the catalogue formats that fit it (GeoJSON → `geojson`, `wfs`;
  LAZ → `laz`), which is how the resource picker filters.

A picked resource is never downloaded by the browser. Deploy sends a CWL File —
`{"class": "File", "location": "<the resource's URL>", "format": "<media type IRI>"}` —
and the Cook Orchestrator hands it to the OGC API Process as a by-reference input
(`{"href": ..., "type": ...}`), so the process fetches the data itself. The URL is
the resource's own link for a link-only resource (e.g. a point cloud hosted
elsewhere), otherwise Hub Datasets' `/datasets/{id}/resources/{id}/data` endpoint
(`sandboxApi.resourceDataUrl`).

In **Edit Recipe → Orchestrator**, the Guided builder and the diagram make this
automatic: a tool input that takes data (a `File` in the step's `run.inputs`, or —
for a step added from a pasted process URL — a process input whose schema has a
`contentMediaType`, `format: uri`/`binary`, or an `{href}` variant) becomes a data
input of the same format when you choose *Ask the user when the recipe runs*. Any
recipe input can also be switched between parameter and data input by hand, with
a format picker (GeoJSON, JSON, LAZ/LAS point cloud, GeoTIFF, CityJSON, GML/XML or
a custom media type) — needed for a process like roofer's, whose description only
says "a URL to a LAZ file" in prose. Marking an input as data writes `type: File`
and `format:` into the CWL and adds the `iana` entry to `$namespaces` if missing.

## 2. How to use it

### Run it

```bash
# via docker-compose, from the repo root (also brings up the backend services):
docker compose up --build
# then open:
http://localhost:8000/#/recipes
```

The `ui` container (`UI/Dockerfile`) is a plain nginx static file server —
there is no build step; the files under `UI/` are served as-is. You can also
serve `UI/` with any static file server (e.g. VS Code Live Server) — see
"Backend URLs" below for which backend it then talks to.

The same `UI/` folder is published to GitHub Pages by
`.github/workflows/pages.yml` on every push to `main` that touches `UI/**`;
that copy talks to the deployed stack at `https://nldt-tb2.clearly.app`.

### Walkthrough

1. Go to **Recipes** — real recipes should be listed: "Rotterdam Boundary
   Buffer", "Add then Multiply" and Playground Recipes 1–3 — seed them first if
   empty (see the Cookbook Registry's README, `scripts/seed_demo_recipe.py`).
   The playground slots start as three example recipes anyone may overwrite
   (**Reset** brings the starter back): 1 is roofer's building reconstruction
   (validate point clouds → reconstruct → convert, on roofer's external staging
   processes), 2 is a sampler of Geolabs' ZOO-Project processes, and 3 calls
   Varidian's external Subsidence Analysis process.
2. Open one, go to **Edit Recipe → Orchestrator** (the default tab) to see and
   edit its actual CWL text, or go to its detail page and run it directly to
   see the real Cook Orchestrator execute it and show the step-by-step trace.
3. In the Orchestrator tab: **Validate CWL** checks your edit (parses it,
   shows the derived inputs/step order) without saving anything; **Save Recipe**
   is disabled until a validation call comes back valid, and re-disables itself
   the moment you touch the text again; **Reset** reloads the bundled,
   on-disk canonical CWL for that recipe, discarding in-editor changes (with
   a confirmation prompt).
4. **Rotterdam Boundary Buffer** has a real data input — `geometry`, a GeoJSON
   `File`: on its **Wizard** tab's Data Ingredients step, pick "Rotterdam
   Municipal Outline" (from the "PDOK Rotterdam Boundary Data" dataset — sourced
   live from PDOK on every use, see `../services/hub-datasets`; any other GeoJSON
   resource fits too), fill in a buffer distance on the Parameters step, then
   Deploy from its Status tab. The buffer tool receives the outline's URL and
   fetches it itself. Playground 1 (roofer) takes a LAZ point cloud the same way
   (the "AHN Point Cloud Sample" dataset), Playground 2 (Geolabs) a GeoJSON
   polygon (the "Sample Polygon" dataset). Every successful run is saved
   automatically as a real resource on the "Sandbox
   Stack Recipe Results" dataset — open the Data Catalogue (or the nLDT
   Sandbox Hub's Datasets tab) and click **Preview** on that dataset's card to
   see every saved result on a real Leaflet map (`js/hubPreview.js`), each as
   its own togglable layer. A result that links to a CityJSON model (roofer's
   reconstruction) is drawn as its building footprints (`js/cityJson.js`).

### Backend URLs

`js/sandboxApi.js` derives every backend URL from where the page itself is
served:

| Page served from | Backends used |
|---|---|
| A URL with an explicit port (e.g. `http://localhost:8000`) | Port mode — same host, one port per service: Records Wrapper `8001`, Cookbook API Registry `8002`, Cook Orchestrator `8003`, tool services `8010`–`8013`, Hub Datasets `8014` |
| Port 80/443 behind the gateway (`docker-compose.gateway.yml`) | Path mode — same origin, `/api/records`, `/api/cookbook`, `/api/orchestrator`, `/api/hub`, `/api/tools/*` |
| GitHub Pages (`fi-group.github.io`) or Live Server (`:5500`–`:5505`) | Path mode against the deployed stack, `https://nldt-tb2.clearly.app` |

Override per page load with `?apiBase=https://host`, `?apiMode=path|port` or
`?apiHost=host` (or the matching `window.NLDT_API_*` globals). See
`../deploy/README.md` for the two deployment shapes.

## 3. Limitations

- **Static file server, no build.** Plain ES modules loaded directly by the
  browser — no bundler, no framework, no server-side rendering.
- **The browser calls services directly, not through Docker.** Even when the
  UI itself runs in a container, the browser it's loaded into calls the
  backends itself (see "Backend URLs" above) — never through the Docker
  network — so those URLs must be reachable from the machine running the
  browser.
- **No authentication anywhere**, matching the backend's open-CORS, no-auth
  design (see `../DECISIONS.md`) — fine for a sandbox, not for real use
  as-is.
- **"Alternative tools" is not a general tool-swap mechanism.** The
  per-step alternatives a recipe owner can allow (stored as
  `nldt:compatibleTools`), and so the tools a hub can swap in on the Wizard's
  Tool & Engine step, are limited to the Cookbook Registry's small hardcoded
  catalog of this stack's own tools. To wire a step to a new, external OGC API
  Process, add it by its process URL in the Guided builder or the diagram, or
  edit the CWL text directly — see `../services/cookbook-registry/README.md`
  and `../services/cook-orchestrator/README.md` for exactly what that
  requires and what it can/can't reach.
- **No client-side reachability/behavior checking.** "Validate CWL" only
  calls the Cookbook Registry's structural check — the UI has no way to
  confirm a step's target process is reachable or will respond correctly
  before you actually execute the recipe.
- **The hub-datasets Preview map is a narrow slice, not a Digital Twin
  viewer.** `js/hubPreview.js` shows a Hub Datasets dataset's resources as
  togglable layers over an OpenStreetMap basemap: GeoJSON as-is, and CityJSON
  only as 2D building footprints (heights in the popup). Link-only resources
  such as the LAZ point cloud have nothing to draw. The sidebar's "Digital
  Twin" and "Connect" sections are empty out-of-scope pages, and the
  datasets' Info/Reviews buttons only show a notice — no general
  dataset-detail page or Digital Twin viewer exists.
