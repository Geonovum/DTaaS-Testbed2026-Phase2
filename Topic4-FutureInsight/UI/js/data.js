// Data access layer for the Geonovum Testbed UI. Recipes, apps and datasets
// come from the live nLDT Sandbox Stack (see ../../services/) via
// sandboxApi.js, fetched fresh on every call. The only static files left
// under /data are the ones the Sandbox Stack has no API for: the hub itself
// (hubs.json), its participant list (participants.json), and a fallback stub
// of the results dataset (datasets.json) shown when hub-datasets isn't
// reachable.
import * as sandboxApi from "./sandboxApi.js";
import { findTool } from "./toolCatalog.js";
import { catalogueFormatsFor } from "./dataFormats.js";

let cache = null;

// Why the last fetch of a live list came back empty, if it failed — read by
// the catalogue views so an unreachable backend isn't shown as "nothing
// matches your filters".
const lastFetchError = { recipes: null, apps: null };

export function getLastFetchError(kind) {
  return lastFetchError[kind];
}

async function loadAll() {
  if (cache) return cache;
  const [hubsRes, participantsRes, datasetsRes] = await Promise.all([
    fetch("data/hubs.json"),
    fetch("data/participants.json"),
    fetch("data/datasets.json"),
  ]);
  if (!hubsRes.ok || !participantsRes.ok || !datasetsRes.ok) {
    throw new Error("Could not load hub data — are you serving this folder over http:// ?");
  }
  const [hubsJson, participantsJson, datasetsJson] = await Promise.all([hubsRes.json(), participantsRes.json(), datasetsRes.json()]);
  cache = {
    hubs: hubsJson.hubs,
    defaultActiveHub: hubsJson.defaultActiveHub,
    participants: participantsJson.participants,
    datasets: datasetsJson.datasets,
  };
  return cache;
}

export async function getHubs() {
  return (await loadAll()).hubs;
}

export async function getDefaultActiveHubId() {
  return (await loadAll()).defaultActiveHub;
}

function flattenHubs(hubs) {
  const out = [];
  for (const h of hubs) {
    out.push(h);
    if (h.subHubs) out.push(...h.subHubs);
  }
  return out;
}

export async function findHubById(hubId) {
  const hubs = await getHubs();
  return flattenHubs(hubs).find((h) => h.id === hubId) || null;
}

export async function getAllHubsFlat() {
  return flattenHubs(await getHubs());
}

// A recipe's data ingredients come from its own CWL: every workflow input
// declared `type: File` (with a `format:` media type) is a dataset the hub
// picks from the catalogue, everything else is a parameter. The Cookbook
// Registry reports them as `dag.data_inputs`; this maps one onto the
// ingredient shape the Wizard's Data Ingredients step, the Status tab and the
// detail pages read. `workflow_input_name` is the CWL input the picked
// resource is sent as — a CWL File pointing at its URL, never its content
// (see ../liveRecipe.js's deploy). An older backend without `data_inputs`
// simply yields no ingredients.
export function ingredientsFromDag(dag) {
  return Object.entries((dag && dag.data_inputs) || {}).map(([name, d]) => {
    const mediaType = d.media_type || null;
    const formats = catalogueFormatsFor(mediaType);
    return {
      input_dataset_id: `input:${name}`,
      role: d.label || name,
      description: d.doc || "",
      data_format: (formats && formats[0]) || mediaType || "any",
      media_type: mediaType,
      workflow_input_name: name,
      array: !!d.array,
      optional: !!d.optional,
    };
  });
}

// Descriptive metadata for a live recipe — most live recipes are pure
// orchestration-plumbing demos (add-multiply-demo, the playground slots)
// with nothing real to say here, hence the empty defaults below. "Rotterdam
// Boundary Buffer" is a genuine, if small, piece of geodata work, so it gets
// real values instead — read by ../js/views/recipeDetail.js's live Details
// tab (see recipeDetail.js::renderLive).
const LIVE_RECIPE_METADATA = {
  "recipe-rotterdam-buffer-demo": {
    theme: ["Open Data", "Geodata Processing"],
    location: ["Rotterdam"],
    project_phase: ["Preparation", "Initiative"],
    target_roles: ["Project Engineer", "GIS Analyst"],
    // The recipe itself, not the underlying PDOK data specifically (PDOK's
    // own boundary data is CC0 1.0 — see hub-datasets' seeded dataset entry)
    // — CC0 fits a recipe with no proprietary logic of its own either.
    license: "CC0 1.0",
    contact_person_name: "nLDT Sandbox Stack",
    contact_person_email: null,
    // Shown on the Wizard's Data Ingredients panel via
    // recipeRequirementsHtml() — not on the Recipe Details tab, which deliberately omits this field
    // (see recipeDetail.js::liveMetadataFieldsHtml).
    data_protocols: [
      "Input boundary: a GeoJSON File, passed by reference — the buffer tool fetches it from its URL. PDOK's Bestuurlijke Gebieden (Kadaster) boundary is fetched live from PDOK's WFS on every use, never cached.",
      "Output: a GeoJSON Feature (the buffered polygon), computed by reprojecting through RD New (EPSG:28992) for an accurate meters-based buffer, then back to WGS84.",
    ],
    execution_constraints: ["Buffer distance: 0 meters and up — a negative value is rejected by the buffer-geometry tool."],
    output_schema: [{ output_id: "bufferedOutline", output_type: "GeoJSON", preview_ref: null }],
  },
};

// Maps a real catalogue entry (from sandboxApi.listRecipes()) onto the flat
// shape every view reads (catalogue cards, detail tabs, the Wizard).
function liveRecipeToViewShape(liveRecipe, dag) {
  const metadata = LIVE_RECIPE_METADATA[liveRecipe.id] || {};
  return {
    recipe_id: liveRecipe.id,
    title: liveRecipe.title,
    description: liveRecipe.description || "",
    owner: "nLDT Sandbox Stack",
    owner_hub_id: null,
    // No visibility list at all => visible everywhere, per the rule below.
    visible_in_hubs: null,
    findability: "PUBLIC",
    project_phase: metadata.project_phase || [],
    target_roles: metadata.target_roles || [],
    theme: metadata.theme || liveRecipe.keywords || [],
    location: metadata.location || [],
    execution_pattern: "synchronous (single call)",
    license: metadata.license || "CC BY 4.0",
    contact_person_name: metadata.contact_person_name || null,
    contact_person_email: metadata.contact_person_email || null,
    status: "Live — backed by the real Sandbox Stack",
    // Made up — the recipe is a real, live computation, but there is no real
    // platform fee; this only feeds the Wizard's Setup Summary cart.
    base_fee: 50,
    parameters: [],
    input_datasets: ingredientsFromDag(dag),
    data_protocols: metadata.data_protocols || [],
    execution_constraints: metadata.execution_constraints || [],
    compatible_apps: [],
    output_type: "data_only",
    output_schema: metadata.output_schema || [],
    preview_result: null,
    // Every successful run's result (saved by liveRecipe.js's Status tab)
    // goes to this one dataset — never a hub-picked
    // destination — so the Wizard's Output step shows it as
    // fixed, the same way it already shows Output Format as fixed, rather
    // than as an editable choice that wouldn't actually be honored.
    fixed_output_destination: {
      hubId: "nldt-sandbox-hub",
      hubName: "nLDT Sandbox Hub",
      datasetId: "ds-sandbox-results",
      datasetTitle: "Sandbox Stack Recipe Results",
    },
    is_live: true,
  };
}

// Fetched fresh on every call, deliberately not cached alongside the static
// `cache` above: a recipe registered through the Cookbook API Registry after
// this page loaded should still show up on the next navigation to the
// catalogue. If the backend isn't running, this fails soft to an empty list
// rather than breaking the rest of the app.
// The order recipes are listed in, everywhere: the real geodata recipe first,
// then the add→multiply demo, then the playground slots. The catalogue itself
// returns them newest-first, which isn't a meaningful order for a reader.
// Recipes not listed here (e.g. registered later) follow, by title.
const RECIPE_ORDER = ["recipe-rotterdam-buffer-demo", "recipe-add-multiply-demo", "playground-1", "playground-2", "playground-3"];

function recipeOrderIndex(recipe) {
  const i = RECIPE_ORDER.indexOf(recipe.recipe_id);
  return i === -1 ? RECIPE_ORDER.length : i;
}

function byRecipeOrder(a, b) {
  return recipeOrderIndex(a) - recipeOrderIndex(b) || a.title.localeCompare(b.title, undefined, { numeric: true });
}

async function getLiveRecipes() {
  try {
    const summaries = await sandboxApi.listRecipes();
    lastFetchError.recipes = null;
    // Each recipe's DAG says which of its inputs are data (see
    // ingredientsFromDag). Fetched in parallel; a recipe whose DAG can't be
    // loaded still lists, just without ingredients.
    const dags = await Promise.all(summaries.map((s) => sandboxApi.getRecipeDag(s.id).catch(() => null)));
    return summaries.map((s, i) => liveRecipeToViewShape(s, dags[i])).sort(byRecipeOrder);
  } catch (err) {
    lastFetchError.recipes = err;
    console.warn("Sandbox Stack backend not reachable — live recipes will not appear in the catalogue.", err);
    return [];
  }
}

export async function getRecipes() {
  return getLiveRecipes();
}

export async function getRecipesForHub(hubId) {
  const recipes = await getRecipes();
  // The owning hub sees every recipe it owns (same convention as datasets/
  // digital twins), regardless of which hubs it's been shared to; a shared-to
  // hub sees it via visible_in_hubs.
  return recipes.filter((r) => r.owner_hub_id === hubId || !r.visible_in_hubs || r.visible_in_hubs.includes(hubId));
}

export async function findRecipeById(recipeId) {
  const recipes = await getRecipes();
  return recipes.find((r) => r.recipe_id === recipeId) || null;
}

// The distinct formats a recipe actually produces, derived from its own
// output_schema so it can't drift out of sync with what the recipe returns.
export function recipeOutputFormats(recipe) {
  const raw = (recipe.output_schema || []).map((o) => o.output_type);
  const normalized = raw.map((t) => (t.startsWith("GeoJSON") ? "GeoJSON" : t));
  return [...new Set(normalized)];
}

// Single-value summary used for the "Output Data Format" field/facet — a
// bare format name when the recipe only produces one, or "Mixed (...)" when
// it combines several (e.g. a 3D preview alongside a WMS layer).
export function recipeOutputDataFormat(recipe) {
  const formats = recipeOutputFormats(recipe);
  if (formats.length === 0) return "—";
  if (formats.length === 1) return formats[0];
  return `Mixed (${formats.join(", ")})`;
}

// Short form for the catalogue filter facet, where the breakdown would just
// repeat what the recipe detail page already spells out.
export function recipeOutputDataFormatFacetLabel(recipe) {
  const formats = recipeOutputFormats(recipe);
  if (formats.length === 0) return "—";
  if (formats.length === 1) return formats[0];
  return "Mixed";
}

// The catalogue formats (e.g. "geojson", "laz") a recipe's data inputs take
// — what the "Input Data Format" facet and field show.
export function recipeInputFormats(recipe) {
  return [...new Set((recipe.input_datasets || []).map((d) => d.data_format).filter(Boolean))];
}

export function recipeInputDataFormat(recipe) {
  const formats = recipeInputFormats(recipe);
  if (formats.length === 0) return "—";
  if (formats.length === 1) return formats[0];
  return `Mixed (${formats.join(", ")})`;
}

// The names of a recipe's data inputs (their CWL labels), for "Input Data".
export function recipeInputData(recipe) {
  return (recipe.input_datasets || []).map((d) => d.role).filter(Boolean);
}

// Maps one tool service's own OGC API Processes self-description onto the
// flat shape the Apps catalogue/detail pages read. `base_url` is where
// "Go to App" opens the running service.
function liveAppFromDescription(processId, baseUrl, description) {
  const inputNames = Object.keys(description.inputs || {});
  const outputNames = Object.keys(description.outputs || {});
  return {
    app_id: `app-${processId}`,
    app_name: description.title || processId,
    short_name: description.title || processId,
    owner: "nLDT Sandbox Stack",
    part_of_hub: null,
    findability: "PUBLIC",
    license: "CC BY 4.0",
    status: "Registered",
    execution_pattern: (description.jobControlOptions || []).includes("async-execute")
      ? "asynchronous (JobID poll)"
      : "synchronous (single call)",
    auth_method: "None (sandbox — no auth in this environment)",
    tags: ["Sandbox Stack", "OGC API Processes"],
    capabilities: [processId],
    compatible_data_formats: [],
    expected_attributes: [],
    // Fake, but pulled from the same TOOL_CATALOG entry the Wizard's Tool &
    // Engine step prices this tool at (see toolCatalog.js and recipeWizard.js's
    // computeCartLines) — so the Apps catalogue and the wizard never disagree
    // about what a given tool service costs. 0 for a tool id the catalog
    // doesn't know about, same fallback the wizard itself uses.
    wizard_execution_fee: (findTool(processId) || {}).wizard_execution_fee || 0,
    type_of_app: "OGC API Process (tool service)",
    logo: "assets/logo.svg",
    description: `A live OGC API Processes tool service, actually running as part of this Sandbox Stack. Inputs: ${inputNames.join(", ") || "none"}. Outputs: ${outputNames.join(", ") || "none"}.`,
    is_live: true,
    base_url: baseUrl,
    process_id: processId,
  };
}

// Fetched fresh on every call, same reasoning as getLiveRecipes() above: no
// caching, fails soft to an empty list per tool that isn't reachable rather
// than breaking the whole Apps catalogue.
async function getLiveApps() {
  const settled = await Promise.allSettled(
    sandboxApi.TOOL_SERVICES.map(async ({ baseUrl, processId }) => {
      const description = await sandboxApi.getToolProcessDescription(baseUrl, processId);
      return liveAppFromDescription(processId, baseUrl, description);
    })
  );
  const apps = [];
  settled.forEach((r) => {
    if (r.status === "fulfilled") apps.push(r.value);
    else console.warn("A Sandbox Stack tool service was not reachable — it will not appear in the Apps catalogue.", r.reason);
  });
  // Only an error when every tool service failed — one unreachable tool just
  // leaves its card out.
  lastFetchError.apps = apps.length === 0 && settled.length ? settled[0].reason : null;
  return apps;
}

export async function getApps() {
  return getLiveApps();
}

export async function findAppById(appId) {
  const apps = await getApps();
  return apps.find((a) => a.app_id === appId) || null;
}

// Real hub-datasets rows (see ../../services/hub-datasets), mapped onto the
// same shape as UI/data/datasets.json's fallback stub, resource content
// omitted — a recipe never receives content from the browser: deploying
// sends a CWL File pointing at the resource's data URL
// (sandboxApi.resourceDataUrl), and the process fetches it itself. Only the
// map preview (hubPreview.js) loads content. Fetched fresh on every call — never
// cached alongside the static `cache` above — and fails soft to an empty
// list if the backend isn't reachable, same reasoning as getLiveRecipes().
async function getHubDatasets() {
  try {
    const hubDatasets = await sandboxApi.listHubDatasets();
    return await Promise.all(
      hubDatasets.map(async (d) => {
        const resources = await sandboxApi.listHubResources(d.id);
        return {
          id: d.id,
          title: d.title,
          description: d.description || "",
          owner_hub_id: d.owner_hub_id || null,
          owner_hub_name: d.owner_hub_name || "nLDT Sandbox Hub",
          license: d.license || "CC0 1.0",
          findability: d.findability || "PUBLIC",
          tags: d.tags || [],
          // `url` is set only for a link-only resource (e.g. a point cloud
          // living elsewhere) — see sandboxApi.resourceDataUrl.
          resources: resources.map((r) => ({ id: r.id, name: r.name, format: r.format, url: r.url || null })),
          // Read by the dataset card views: a live dataset's Preview button
          // opens a real map (see hubPreview.js), the fallback stub's can't.
          is_live: true,
        };
      })
    );
  } catch (err) {
    console.warn("Hub Datasets backend not reachable — real Sandbox Stack datasets will not appear in the catalogue.", err);
    return [];
  }
}

export async function getDatasets() {
  const fallback = (await loadAll()).datasets;
  const hubDatasets = await getHubDatasets();
  // A real hub-datasets row takes priority over the same-id fallback stub —
  // datasets.json only exists so "ds-sandbox-results" still shows up (as an
  // empty destination) when the hub-datasets service isn't reachable.
  const hubIds = new Set(hubDatasets.map((d) => d.id));
  return [...fallback.filter((d) => !hubIds.has(d.id)), ...hubDatasets];
}

export async function getCatalogueDatasetsForHub(hubId) {
  const datasets = await getDatasets();
  return datasets.filter((d) => d.owner_hub_id === hubId);
}

export async function getAppsForHub(hubId) {
  // Every Sandbox Stack tool service is available to every hub, so surface
  // the full app catalogue scoped to whichever hub is open.
  return getApps();
}

export async function getParticipants() {
  return (await loadAll()).participants;
}
