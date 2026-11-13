// Client for the REAL nLDT Sandbox Stack backend (see ../../DECISIONS.md and
// ../../services/). Every function here makes a live network call to one of
// the running services; js/data.js maps the results onto the shapes the
// views read.
//
// ---------------------------------------------------------------------------
// Where the backends live
// ---------------------------------------------------------------------------
// The UI container is nginx serving static files only — it never proxies. The
// *browser* calls each backend directly, so these addresses must resolve from
// wherever the page is being *viewed*, not from inside the docker network.
//
// There are two deployment shapes, and the difference is forced by TLS:
//
//   "port" mode — http://<host>:8001, :8002, ...
//     Each service on its own published port (docker-compose.yml). Correct
//     for a local `docker compose up`, where the page is served from
//     http://localhost:8000 and everything shares an origin-by-host.
//     Unusable behind HTTPS: it would mean a valid certificate on every one
//     of those ports, and plain-http calls from an https page are blocked by
//     the browser as mixed content.
//
//   "path" mode — https://<host>/api/records, /api/cookbook, ...
//     Every service reached through one origin, routed by path prefix by
//     whatever reverse proxy terminates TLS. One certificate, one origin —
//     which also makes the CORS config in each service moot, since nothing
//     is cross-origin any more. Required for any HTTPS deployment.
//
// The mode is chosen from whether the page URL carries an explicit port:
// http://localhost:8000 has one, so the published ports are reachable too;
// https://example.org does not, so the page is behind a proxy on 443 and the
// backends have to come through it as well. Override when that guess is
// wrong (e.g. a proxy on a non-default port) with, in priority order:
//   1. ?apiMode=path  /  ?apiMode=port   — query param, no redeploy needed.
//   2. window.NLDT_API_MODE = "path"     — from an inline <script> in
//      index.html, before js/app.js loads, for a permanent deployment.
// A backend on a different *host* than the UI (separate API box, ssh tunnel)
// is handled by ?apiHost= / window.NLDT_API_HOST, which only applies in port
// mode — in path mode the host is by definition the page's own.
//
// Path prefixes must match the proxy config — see docker-compose.yml's header
// and deploy/ for ready-made nginx/Caddy/Traefik routes.
const API_ROUTES = {
  recordsWrapper: { port: 8001, path: "/api/records" },
  cookbookRegistry: { port: 8002, path: "/api/cookbook" },
  cookOrchestrator: { port: 8003, path: "/api/orchestrator" },
  hubDatasets: { port: 8014, path: "/api/hub" },
};

function queryOverride(name) {
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null; // no search string to parse
  }
}

// A UI served from somewhere with no backends of its own — VS Code's Live
// Server (:5500, or the next free port up when that's taken), or the GitHub
// Pages site (.github/workflows/pages.yml),
// both serve static files only — can borrow a deployed stack's instead: path
// mode, but against that stack's origin rather than the page's. Works because
// every service's CORS policy is open (see DECISIONS.md).
// Override with ?apiBase=https://host  /  window.NLDT_API_BASE = "https://host".
const DEPLOYED_API_BASE = "https://nldt-tb2.clearly.app";
const STATIC_ONLY_DEV_PORTS = new Set(["5500", "5501", "5502", "5503", "5504", "5505"]);
const STATIC_ONLY_HOSTS = new Set(["fi-group.github.io"]);

function resolveApiBase() {
  const override = queryOverride("apiBase") || window.NLDT_API_BASE || null;
  if (override) return override.replace(/\/+$/, "");
  const staticOnly = STATIC_ONLY_DEV_PORTS.has(window.location.port) || STATIC_ONLY_HOSTS.has(window.location.hostname);
  return staticOnly ? DEPLOYED_API_BASE : null;
}

const API_BASE = resolveApiBase();

function resolveApiMode() {
  if (API_BASE) return "path";
  const override = queryOverride("apiMode") || window.NLDT_API_MODE || null;
  if (override === "path" || override === "port") return override;
  // No explicit port in the page URL => served on 80/443, i.e. behind a
  // proxy => the backends must come through that same proxy.
  return window.location.port ? "port" : "path";
}

function resolveApiHost() {
  // location.hostname is "" under file:// — no origin to derive from, so fall
  // back to the local-docker default.
  return queryOverride("apiHost") || window.NLDT_API_HOST || window.location.hostname || "localhost";
}

const API_MODE = resolveApiMode();
const API_HOST = resolveApiHost();
// Follow the page's own scheme: an https-served UI calling http backends gets
// blocked as mixed content, so matching it fails loudly rather than
// half-working.
const API_SCHEME = window.location.protocol === "https:" ? "https:" : "http:";

/** Base URL of a backend service, given both the port it publishes in
 * docker-compose.yml and the path prefix a reverse proxy routes to it. Which
 * of the two is used depends on API_MODE (see above). */
export function serviceUrl({ port, path }) {
  return API_MODE === "path" ? `${API_BASE || window.location.origin}${path}` : `${API_SCHEME}//${API_HOST}:${port}`;
}

export const RECORDS_WRAPPER_URL = serviceUrl(API_ROUTES.recordsWrapper);
export const COOKBOOK_REGISTRY_URL = serviceUrl(API_ROUTES.cookbookRegistry);
export const COOK_ORCHESTRATOR_URL = serviceUrl(API_ROUTES.cookOrchestrator);
export const HUB_DATASETS_URL = serviceUrl(API_ROUTES.hubDatasets);

// The tool (leaf process) services — the one place a static registry is used
// instead of discovery, mirroring the Cook Orchestrator's own
// TOOL_REGISTRY_JSON (see DECISIONS.md, D10). Used by
// js/data.js to surface each tool as a real "App" in the Apps catalogue,
// fetched live rather than hardcoded. Same resolution as above.
export const TOOL_SERVICES = [
  { baseUrl: serviceUrl({ port: 8010, path: "/api/tools/add" }), processId: "add-two-numbers" },
  { baseUrl: serviceUrl({ port: 8011, path: "/api/tools/multiply" }), processId: "multiply-two-numbers" },
  { baseUrl: serviceUrl({ port: 8012, path: "/api/tools/multiply3" }), processId: "multiply-three-numbers" },
  { baseUrl: serviceUrl({ port: 8013, path: "/api/tools/geo-buffer" }), processId: "buffer-geometry" },
];

async function asJson(resp, context) {
  if (!resp.ok) {
    let detail = "";
    try {
      detail = (await resp.json()).detail || "";
    } catch {
      /* response wasn't JSON — ignore */
    }
    throw new Error(`${context} failed: HTTP ${resp.status}${detail ? ` — ${detail}` : ""}`);
  }
  return resp.json();
}

/** Maps an OGC API Records "Feature" (see records-wrapper/app/main.py) down to
 * the flat shape the Cookbook (Live) views actually use. */
function featureToRecipeSummary(feature) {
  const sourceLink = (feature.links || []).find(
    (l) => l.rel === "http://www.opengis.net/def/rel/ogc/1.0/recipe-source"
  );
  return {
    id: feature.id,
    title: feature.properties?.title || feature.id,
    description: feature.properties?.description || "",
    keywords: feature.properties?.keywords || [],
    cookbookUrl: sourceLink?.href || null,
  };
}

/** Lists recipes from the real OGC API Records Wrapper catalogue. */
export async function listRecipes({ q } = {}) {
  const url = new URL(`${RECORDS_WRAPPER_URL}/collections/recipes/items`);
  if (q) url.searchParams.set("q", q);
  const resp = await fetch(url);
  const body = await asJson(resp, "Listing recipes from the Records Wrapper");
  return (body.features || []).map(featureToRecipeSummary);
}

/** Fetches the JSON Schema for a recipe's top-level inputs, derived live from
 * its CWL by the Cookbook API Registry — never a stored/cached schema. */
export async function getRecipeSchema(recipeId) {
  const resp = await fetch(`${COOKBOOK_REGISTRY_URL}/recipes/${encodeURIComponent(recipeId)}/schema`);
  return asJson(resp, `Fetching schema for '${recipeId}'`);
}

/** Fetches the execution DAG (steps, wiring) the Cook Orchestrator itself
 * walks — also derived live from the CWL by the Cookbook API Registry. */
export async function getRecipeDag(recipeId) {
  const resp = await fetch(`${COOKBOOK_REGISTRY_URL}/recipes/${encodeURIComponent(recipeId)}/dag`);
  return asJson(resp, `Fetching execution graph for '${recipeId}'`);
}

/** Fetches { schema, dag } for the recipe's stored CWL with the given steps'
 * tools substituted (stepId -> tool id) — a hub's own custom configuration
 * for this run, computed fresh server-side, never persisted or touching the
 * recipe's stored/default CWL. `toolOverrides` empty/omitted behaves like
 * the recipe's own schema/dag. */
export async function getEffectiveRecipe(recipeId, toolOverrides = {}) {
  const resp = await fetch(`${COOKBOOK_REGISTRY_URL}/recipes/${encodeURIComponent(recipeId)}/effective`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ toolOverrides }),
  });
  return asJson(resp, `Fetching effective schema/dag for '${recipeId}'`);
}

/** Fetches the raw CWL document text, exactly as stored. */
export async function getRecipeCwl(recipeId) {
  const resp = await fetch(`${COOKBOOK_REGISTRY_URL}/recipes/${encodeURIComponent(recipeId)}`);
  if (!resp.ok) throw new Error(`Fetching CWL for '${recipeId}' failed: HTTP ${resp.status}`);
  return resp.text();
}

/** Fetches the bundled, on-disk canonical CWL for a recipe — independent of
 * whatever is currently stored/edited. Throws (including on 404, when this
 * recipe has no bundled original) rather than returning null, so a caller
 * can't accidentally treat a missing original as an empty document. */
export async function getRecipeOriginalCwl(recipeId) {
  const resp = await fetch(`${COOKBOOK_REGISTRY_URL}/recipes/${encodeURIComponent(recipeId)}/original`);
  if (!resp.ok) {
    let detail = "";
    try {
      detail = (await resp.json()).detail || "";
    } catch {
      /* not JSON — ignore */
    }
    throw new Error(`Fetching original CWL for '${recipeId}' failed: HTTP ${resp.status}${detail ? ` — ${detail}` : ""}`);
  }
  return resp.text();
}

const JOB_POLL_INTERVAL_MS = 2000;

/** Executes a recipe against the real Cook Orchestrator (an OGC API Process)
 * and returns { result, trace }. Runs as an async job (`Prefer:
 * respond-async`) and polls it to completion rather than holding one HTTP
 * request open for the whole run — a step calling an external, long-running
 * process (e.g. roofer's building reconstruction) can take minutes, well past
 * what a reverse proxy in front of the stack will keep a request alive for.
 * `toolOverrides` (stepId -> tool id), if non-empty, runs this execution
 * against a per-run tool-substituted variant of the recipe (see
 * getEffectiveRecipe) — the recipe's own stored CWL is never modified by this. */
export async function executeRecipe(recipeId, parameters, toolOverrides = {}, { onStatus } = {}) {
  const job = await startRecipeExecution(recipeId, parameters, toolOverrides);
  // A sync answer (no job) is still accepted, e.g. from an older orchestrator.
  if (!job.jobID) return job;
  return waitForRecipeJob(job.jobID, { onStatus, initial: job });
}

/** Starts a recipe run as an async Cook Orchestrator job and returns its
 * status document ({jobID, status, steps, ...}) without waiting for it. */
export async function startRecipeExecution(recipeId, parameters, toolOverrides = {}) {
  const resp = await fetch(`${COOK_ORCHESTRATOR_URL}/processes/cook/execution`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "respond-async" },
    body: JSON.stringify({ inputs: { recipeId, parameters, toolOverrides } }),
  });
  return asJson(resp, `Executing recipe '${recipeId}'`);
}

/** One Cook Orchestrator job's status document: {jobID, status, progress,
 * message, steps: [{id, label, processId, status, remoteStatus,
 * remoteProgress, message}], ...} — see cook-orchestrator/app/main.py's
 * _job_status_body. A 404 (e.g. the orchestrator restarted and lost its
 * in-memory jobs) throws an Error with `notFound: true`. */
export async function getRecipeJob(jobId) {
  const resp = await fetch(`${COOK_ORCHESTRATOR_URL}/jobs/${encodeURIComponent(jobId)}`);
  if (resp.status === 404) {
    const err = new Error(`Job '${jobId}' no longer exists on the Cook Orchestrator`);
    err.notFound = true;
    throw err;
  }
  return asJson(resp, `Checking job '${jobId}'`);
}

/** Polls a job until it's finished, calling `onStatus(job)` with every
 * status document on the way, and resolves with its { result, trace } —
 * or throws with the job's own message if it failed or was cancelled
 * (err.cancelled is true for the latter). A failure's err.source is the
 * job's `errorSource` — {source: "cook" | "registry" | "tool", processId?,
 * url?, step?, stepLabel?}, see cook-orchestrator/app/engine.py's
 * ExecutionError — telling the Cook's own failures from a tool's. */
export async function waitForRecipeJob(jobId, { onStatus, initial } = {}) {
  let job = initial || (await getRecipeJob(jobId));
  if (onStatus) onStatus(job);
  while (job.status === "accepted" || job.status === "running") {
    await new Promise((resolve) => setTimeout(resolve, JOB_POLL_INTERVAL_MS));
    job = await getRecipeJob(jobId);
    if (onStatus) onStatus(job);
  }
  if (job.status !== "successful") {
    const err = new Error(job.status === "dismissed" ? "Cancelled on request." : job.message || `Job ${job.status}`);
    err.cancelled = job.status === "dismissed";
    err.source = job.errorSource || null;
    throw err;
  }
  return asJson(await fetch(`${COOK_ORCHESTRATOR_URL}/jobs/${encodeURIComponent(jobId)}/results`), `Fetching results of job '${jobId}'`);
}

/** Cancels a running job (OGC API Processes "dismiss"). The orchestrator
 * stops at its next check — between steps, or within a poll interval while
 * a step's remote job runs, which it then dismisses remotely too. */
export async function cancelRecipeJob(jobId) {
  const resp = await fetch(`${COOK_ORCHESTRATOR_URL}/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
  return asJson(resp, `Cancelling job '${jobId}'`);
}

/** Checks a CWL document without persisting anything. Returns
 * { valid: true, schema, dag } or { valid: false, error }. Always resolves
 * (an invalid document is a normal answer, not a thrown error) — only a
 * network/server failure throws. */
export async function validateCwl(cwlText) {
  const resp = await fetch(`${COOKBOOK_REGISTRY_URL}/recipes/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwl: cwlText }),
  });
  return asJson(resp, "Validating CWL");
}

/** Fetches one tool service's own OGC API Processes description of itself —
 * used to surface it as a live "App" card (see js/data.js::getLiveApps()). */
export async function getToolProcessDescription(baseUrl, processId) {
  const resp = await fetch(`${baseUrl}/processes/${encodeURIComponent(processId)}`);
  return asJson(resp, `Fetching process description for '${processId}'`);
}

/** Fetches an arbitrary external OGC API Process's own description (e.g. one
 * a recipe author pasted into the Orchestrator tab's "Add step from a
 * process URL" control) via the Cookbook Registry's proxy — not a direct
 * browser fetch, since an arbitrary third-party server can't be assumed to
 * send CORS headers permitting this UI's origin. `url` should be the
 * process's own address (".../processes/{id}"); a stray trailing
 * "/execution" is stripped server-side. */
export async function fetchExternalProcessDescription(url) {
  const resp = await fetch(`${COOKBOOK_REGISTRY_URL}/processes/fetch-description?url=${encodeURIComponent(url)}`);
  return asJson(resp, `Fetching process description from '${url}'`);
}

/** Publishes a (possibly edited) CWL document for an existing recipe id —
 * the same real POST /recipes the initial seed script uses. The Cookbook
 * Registry re-validates server-side regardless of client-side validation,
 * and re-publishes the catalog entry via the Records Wrapper. */
export async function saveRecipeCwl(recipeId, { title, description, keywords, cwl }) {
  const resp = await fetch(`${COOKBOOK_REGISTRY_URL}/recipes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: recipeId, title, description, keywords, cwl }),
  });
  return asJson(resp, `Saving recipe '${recipeId}'`);
}

// --- Hub Datasets (see ../../services/hub-datasets) — the real dataset/
// resource store behind the LDT hub's Data Catalogue, for the Sandbox Stack
// UI. js/data.js maps these onto the same shape as the fallback stub in
// UI/data/datasets.json, so every dataset-consuming
// view (Data Catalogue, hub Datasets tab, the Wizard's resource picker)
// reads them with no special-casing.

/** Lists every real hub dataset (id/title/description/owner — no resources,
 * see listHubResources for those). */
export async function listHubDatasets() {
  const resp = await fetch(`${HUB_DATASETS_URL}/datasets`);
  const body = await asJson(resp, "Listing hub datasets");
  return body.datasets || [];
}

/** Lists a dataset's resources (metadata only — id/name/format/created, not
 * content; see getHubResourceContent for a specific resource's payload). */
export async function listHubResources(datasetId) {
  const resp = await fetch(`${HUB_DATASETS_URL}/datasets/${encodeURIComponent(datasetId)}/resources`);
  const body = await asJson(resp, `Listing resources for dataset '${datasetId}'`);
  return body.resources || [];
}

/** Fetches one resource's actual payload. For the live PDOK-backed boundary
 * resource, the server fetches fresh from PDOK on every call (see
 * hub-datasets/app/pdok.py) — this never returns a cached copy. */
export async function getHubResourceContent(datasetId, resourceId) {
  const resp = await fetch(
    `${HUB_DATASETS_URL}/datasets/${encodeURIComponent(datasetId)}/resources/${encodeURIComponent(resourceId)}/content`
  );
  const body = await asJson(resp, `Fetching content for resource '${resourceId}'`);
  return body.content;
}

/** The public URL a resource's data can be fetched from — what a recipe's
 * data input is given as its CWL File `location`, so the OGC API Process can
 * fetch the data itself. A link-only resource (data living elsewhere, e.g. a
 * point cloud) carries its own `url`; anything else is served raw by Hub
 * Datasets' `/data` endpoint. */
export function resourceDataUrl(datasetId, resource) {
  if (resource.url) return resource.url;
  return `${HUB_DATASETS_URL}/datasets/${encodeURIComponent(datasetId)}/resources/${encodeURIComponent(resource.id)}/data`;
}

/** Saves a new resource into a hub dataset — used by a live recipe's "Save
 * to Hub" action (see js/liveRecipe.js) to persist a run's result for real,
 * rather than just displaying and discarding it. */
export async function saveHubResource(datasetId, { name, format, content }) {
  const resp = await fetch(`${HUB_DATASETS_URL}/datasets/${encodeURIComponent(datasetId)}/resources`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, format, content }),
  });
  return asJson(resp, `Saving a resource to dataset '${datasetId}'`);
}

/** Demo-only bulk reset — clears every user-saved resource in a dataset (e.g.
 * accumulated live-recipe run results) in one call. A seeded/live resource
 * (like the PDOK boundary) is never removed by this — see hub-datasets'
 * PROTECTED_RESOURCE_IDS. Used by js/hubPreview.js's "Delete All" button. */
/** Deletes one saved resource. Throws an error with `outdatedService: true`
 * when hub-datasets predates this endpoint (FastAPI's own route-level 404/405,
 * not the endpoint's "Resource ... not found"), so the caller can say the
 * backend needs a redeploy rather than report a confusing failure. */
export async function deleteHubResource(datasetId, resourceId) {
  const resp = await fetch(
    `${HUB_DATASETS_URL}/datasets/${encodeURIComponent(datasetId)}/resources/${encodeURIComponent(resourceId)}`,
    { method: "DELETE" }
  );
  if (resp.status === 404 || resp.status === 405) {
    const detail = await resp
      .clone()
      .json()
      .then((b) => b.detail)
      .catch(() => "");
    if (detail === "Not Found" || detail === "Method Not Allowed") {
      const err = new Error("hub-datasets does not support deleting single results yet");
      err.outdatedService = true;
      throw err;
    }
  }
  return asJson(resp, `Deleting resource '${resourceId}'`);
}
