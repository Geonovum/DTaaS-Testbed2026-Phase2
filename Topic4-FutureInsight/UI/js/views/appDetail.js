import * as api from "../data.js";
import { showToast } from "../state.js";
import * as dataCatalogueView from "./dataCatalogue.js";
import * as appsCatalogueView from "./appsCatalogue.js";

const TABS = [
  { key: "details", label: "App Details" },
  { key: "data", label: "Compatible Data" },
  { key: "reviews", label: "Reviews" },
];

function tabsHtml(appId, activeTab) {
  return `
    <div class="tabs">
      ${TABS.map((t) => `<a class="tab ${t.key === activeTab ? "is-active" : ""}" href="#/apps/${appId}/${t.key}">${t.label}</a>`).join("")}
    </div>`;
}

function detailsTabHtml(app) {
  return `
    <div class="detail-side-layout">
      <div>
        <div style="display:flex;gap:10px;margin-bottom:18px;flex-wrap:wrap;">
          <button class="btn btn-primary" id="btn-goto-app">Go to App</button>
          <button class="btn btn-secondary" id="btn-report-app">Report App</button>
        </div>
        <div class="field-group"><span class="field-label">Title</span><div class="field-value">${app.app_name}</div></div>
        <div class="field-group"><span class="field-label">Owner Hub</span><div class="field-value">${app.owner}</div></div>
        <div class="field-group"><span class="field-label">Findability</span><span class="badge badge-public">${app.findability}</span></div>
        <div class="field-group"><span class="field-label">Description</span><div class="field-value">${app.description}</div></div>
        <div class="field-group"><span class="field-label">Type of app</span><div class="field-value">${app.type_of_app}</div></div>
        <div class="field-group"><span class="field-label">Tags</span><div class="chip-row">${(app.tags || []).map((t) => `<span class="chip">${t}</span>`).join("")}</div></div>
        <div class="field-group"><span class="field-label">Compatible data formats</span><div class="field-value">${(app.compatible_data_formats || []).join(", ")}</div></div>
        <div class="field-group"><span class="field-label">Execution pattern</span><div class="field-value">${app.execution_pattern}</div></div>
      </div>
      <div>
        <h3 style="margin-top:0;">Pricing</h3>
        <div class="pricing-tile">
          <div class="pricing-tile__label">Per run</div>
          <div class="pricing-tile__value">€${app.wizard_execution_fee.toLocaleString("en-GB")}</div>
          <p class="pricing-tile__hint">Illustrative only — the same fee the Recipe Wizard's Setup Summary charges for this tool.</p>
        </div>
      </div>
    </div>`;
}

function reviewsTabHtml() {
  return `<div class="card"><div class="empty-state">No reviews yet.</div></div>`;
}

export async function render(container, params, ctx) {
  const { appId, tab = "details", query } = params;

  if (!appId) {
    ctx.setTitle("Apps");
    await appsCatalogueView.render(container, { query }, ctx);
    return;
  }

  const app = await api.findAppById(appId);
  if (!app) {
    container.innerHTML = `<div class="empty-state">App not found.</div>`;
    return;
  }

  ctx.setTitle("Apps");
  ctx.setSubtitle(app.app_name);

  if (tab === "data") {
    // compatible_data_formats holds catalogue format ids (e.g. "3dtiles") for
    // apps that consume registered datasets, but display labels (e.g. "3D
    // Tiles") for viewer apps describing recipe *output* shapes instead —
    // only the former actually match the dataset catalogue's own format
    // facet, so only those are locked here.
    const lockedFormats = (app.compatible_data_formats || []).filter((f) => /^[a-z0-9_]+$/.test(f));
    await dataCatalogueView.render(container, {}, ctx, {
      lockedFormats,
      hideRegister: true,
      hideHeading: true,
      facetKeys: ["owner_hub_name", "tags", "format"],
      topTabsHtml: tabsHtml(app.app_id, tab),
    });
    return;
  }

  let body = "";
  if (tab === "details") body = detailsTabHtml(app);
  else if (tab === "reviews") body = reviewsTabHtml();

  container.innerHTML = `
    <div class="detail-shell">
      ${tabsHtml(app.app_id, tab)}
      ${body}
    </div>
  `;

  const goto = container.querySelector("#btn-goto-app");
  if (goto) {
    goto.addEventListener("click", () => window.open(app.base_url, "_blank", "noopener"));
  }
  const report = container.querySelector("#btn-report-app");
  if (report) report.addEventListener("click", () => showToast("Mocked — reporting isn't wired up in this phase."));
}
