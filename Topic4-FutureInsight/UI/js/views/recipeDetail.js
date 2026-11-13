import * as api from "../data.js";
import * as dataCatalogueView from "./dataCatalogue.js";
import * as appsCatalogueView from "./appsCatalogue.js";
import * as recipeWizardView from "./recipeWizard.js";
import { executionPatternHelpHtml, initHelpTips } from "../executionPatterns.js";
import { PHASE_SEQUENCE } from "../constants.js";
import { catalogueFormatsFor } from "../dataFormats.js";
import { graphHtml } from "../recipeGraph.js";
import { icons } from "../icons.js";
import * as liveRecipe from "../liveRecipe.js";
import * as sandboxApi from "../sandboxApi.js";

// The recipe's declared outputs as a static diagram, built from its catalogue
// metadata alone (no run, no CWL fetch) — used by Edit Recipe's Metadata tab
// (see views/editRecipe.js). A recipe from the Cookbook API Registry
// declares no tool connectors or per-slot data breakdown in its catalogue
// metadata (data.js::liveRecipeToViewShape), so only the outputs have
// nodes here; the full pipeline is the Details tab's #live-details-graph,
// drawn from the recipe's real CWL-derived DAG.
export function buildStaticGraph(recipe) {
  const nodes = (recipe.output_schema || []).map((o) => ({ id: `output:${o.output_id}`, kind: "output", label: o.output_type }));
  return { nodes, edges: [] };
}

// The OUP-registerable formats this recipe actually requires as input —
// derived from its own input datasets, so it can't drift out of sync with
// what the recipe really asks for. Drives the locked Formats facet on the
// Compatible Data tab.
function recipeCompatibleFormats(recipe) {
  // Every catalogue format any of the recipe's data inputs accepts (see
  // dataFormats.js) — an input of unknown media type accepts any format, so
  // it adds no lock of its own.
  const formats = new Set();
  (recipe.input_datasets || []).forEach((d) => (catalogueFormatsFor(d.media_type) || []).forEach((f) => formats.add(f)));
  return [...formats];
}

function liveFieldRow(label, valueHtml) {
  return `<div class="field-group"><span class="field-label">${label}</span>${valueHtml}</div>`;
}

function listFieldHtml(items) {
  return `<ul style="margin:0;padding-left:18px;">${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;
}

// The metadata fields a recipe can have real values for — Theme, Location,
// Project Phases, Users, Input/Output Data Format, Execution Constraints,
// License, Contact (see data.js::LIVE_RECIPE_METADATA).
//
// Deliberately excludes Data Protocols & Formats even when
// recipe.data_protocols is populated — that field belongs on the Wizard's
// Step 1 panel instead (see recipeWizard.js::recipeRequirementsHtml), not
// duplicated here.
function liveMetadataFieldsHtml(recipe) {
  return `
    <div style="margin-top:18px;">
      ${liveFieldRow("Theme", `<div class="chip-row">${(recipe.theme || []).map((t) => `<span class="chip">${t}</span>`).join("") || "—"}</div>`)}
      ${liveFieldRow("Location", `<div class="chip-row">${(recipe.location || []).map((l) => `<span class="chip">${l}</span>`).join("") || "—"}</div>`)}
      ${liveFieldRow("Project Phases", phaseTimelineHtml(recipe))}
      ${liveFieldRow("Users", `<div class="chip-row">${(recipe.target_roles || []).map((r) => `<span class="chip">${r}</span>`).join("") || "—"}</div>`)}
      ${liveFieldRow("Input Data", `<div class="chip-row">${api.recipeInputData(recipe).map((n) => `<span class="chip">${n}</span>`).join("") || "—"}</div>`)}
      ${liveFieldRow("Input Data Format", `<div class="field-value">${api.recipeInputDataFormat(recipe).toUpperCase()}</div>`)}
      ${liveFieldRow("Output Data Format", `<div class="field-value">${api.recipeOutputDataFormat(recipe).toUpperCase()}</div>`)}
      ${
        recipe.execution_constraints && recipe.execution_constraints.length
          ? liveFieldRow("Execution Constraints", listFieldHtml(recipe.execution_constraints))
          : ""
      }
      ${liveFieldRow("License", `<div class="field-value">${recipe.license || "—"}</div>`)}
      ${liveFieldRow("Contact Person Name", `<div class="field-value">${recipe.contact_person_name || "—"}</div>`)}
      ${liveFieldRow(
        "Contact Person Email",
        `<div class="field-value">${recipe.contact_person_email ? `<a href="mailto:${recipe.contact_person_email}">${recipe.contact_person_email}</a>` : "—"}</div>`
      )}
    </div>`;
}

function phaseTimelineHtml(recipe) {
  return `
    <div class="phase-bar phase-bar--readonly">
      ${PHASE_SEQUENCE.map(
        (phase, i) => `
        <div class="phase-bar__step ${recipe.project_phase.includes(phase) ? "is-applicable" : ""}">
          ${i > 0 ? '<span class="phase-bar__line"></span>' : ""}
          <span class="phase-bar__dot"></span>
          <span class="phase-bar__label">${phase}</span>
        </div>`
      ).join("")}
    </div>`;
}

const TABS = [
  { key: "details", label: "Recipe Details" },
  { key: "wizard", label: "Recipe Wizard" },
  { key: "status", label: "Status" },
  { key: "data", label: "Compatible Data" },
  { key: "apps", label: "Compatible Apps" },
  { key: "apis", label: "APIs" },
  { key: "reviews", label: "Reviews" },
];

function tabsHtml(recipeId, activeTab) {
  return `
    <div class="tabs">
      ${TABS.map((t) => `<a class="tab ${t.key === activeTab ? "is-active" : ""}" href="#/recipes/${recipeId}/${t.key}">${t.label}</a>`).join("")}
    </div>`;
}

// Edit Recipe's Metadata tab (see views/editRecipe.js): the recipe's fields,
// laid out read-only, with a non-functional pencil icon next to every field
// label so the tab visually reads as "these fields are editable" even though
// nothing here is wired to an actual save: editing catalogue metadata is
// outside this testbed's scope. A pencil's click still needs wiring by the caller
// — see editRecipe.js's [data-mock-edit-field] handler — this function only
// ever returns markup, never attaches events.
export function detailsTabHtml(recipe, graph) {
  const fieldRow = (label, valueHtml) => `
    <div class="field-group">
      <span class="field-label">
        ${label}
        <button type="button" class="field-edit-pencil" data-mock-edit-field="${label}" title="Edit ${label}" aria-label="Edit ${label}">${icons.pencil}</button>
      </span>
      ${valueHtml}
    </div>`;

  // Recipes registered in the Cookbook API Registry have no owner hub
  // (owner_hub_id: null), so the owner is plain text unless one exists.
  const ownerHtml = recipe.owner_hub_id ? `<a href="#/hubs/${recipe.owner_hub_id}/details/recipes">${recipe.owner}</a>` : recipe.owner;

  return `
    <div style="margin-top:18px;">
      ${fieldRow("Title", `<div class="field-value">${recipe.title}</div>`)}
      ${fieldRow("Owner", `<div class="field-value">${ownerHtml}</div>`)}
      ${fieldRow("Findability", `<span class="badge badge-public">${recipe.findability}</span>`)}
      ${fieldRow("Description", `<div class="field-value">${recipe.description}</div>`)}
    </div>

    ${graphHtml(graph, {
      title: "Recipe Schema",
      hint: "The outputs this recipe declares in its catalogue metadata. The full pipeline is on the Recipe Details tab and the Orchestrator tab.",
    })}

    <div style="margin-top:18px;">
      ${fieldRow("Execution pattern", `<div class="field-value">${recipe.execution_pattern}${executionPatternHelpHtml(recipe.execution_pattern)}</div>`)}
      ${fieldRow("Project Phases", phaseTimelineHtml(recipe))}
      ${fieldRow("Users", `<div class="chip-row">${recipe.target_roles.map((r) => `<span class="chip">${r}</span>`).join("") || "—"}</div>`)}
      ${fieldRow("Theme", `<div class="chip-row">${(recipe.theme || []).map((t) => `<span class="chip">${t}</span>`).join("") || "—"}</div>`)}
      ${fieldRow("Location", `<div class="chip-row">${(recipe.location || []).map((l) => `<span class="chip">${l}</span>`).join("") || "—"}</div>`)}
      ${fieldRow("Input Data", `<div class="chip-row">${api.recipeInputData(recipe).map((n) => `<span class="chip">${n}</span>`).join("") || "—"}</div>`)}
      ${fieldRow("Input Data Format", `<div class="field-value">${api.recipeInputDataFormat(recipe).toUpperCase()}</div>`)}
      ${fieldRow("Output Data Format", `<div class="field-value">${api.recipeOutputDataFormat(recipe).toUpperCase()}</div>`)}
      ${fieldRow(
        "Outputs",
        `<div class="chip-row">${(recipe.output_schema || []).map((o) => `<span class="badge badge-public">${o.output_type}</span>`).join("") || "—"}</div>`
      )}
      ${fieldRow("Contact Person Name", `<div class="field-value">${recipe.contact_person_name || "—"}</div>`)}
      ${fieldRow(
        "Contact Person Email",
        `<div class="field-value">${recipe.contact_person_email ? `<a href="mailto:${recipe.contact_person_email}">${recipe.contact_person_email}</a>` : "—"}</div>`
      )}
    </div>
  `;
}

// Details and Status are rendered here; Wizard, Compatible Data and
// Compatible Apps go straight to the generic wizard/catalogue components
// (see render() below); APIs and Reviews have nothing to show yet.
async function renderTabBody(container, recipe, tab) {
  container.innerHTML = `
    <div class="detail-shell">
      ${tabsHtml(recipe.recipe_id, tab)}
      <div id="live-tab-body"></div>
    </div>`;
  const body = container.querySelector("#live-tab-body");

  if (tab === "status") {
    await liveRecipe.renderStatusTab(body, recipe);
  } else if (tab === "details") {
    // Most recipes (add-multiply-demo, the playground slots) are pure
    // orchestration-plumbing demos with nothing real to say beyond title/
    // description — the extra metadata block below is skipped for them.
    // "Rotterdam Boundary Buffer" has real values here (see
    // data.js::LIVE_RECIPE_METADATA).
    const hasMetadata =
      (recipe.theme && recipe.theme.length) ||
      (recipe.location && recipe.location.length) ||
      (recipe.project_phase && recipe.project_phase.length) ||
      (recipe.data_protocols && recipe.data_protocols.length);
    body.innerHTML = `
      <button class="btn btn-secondary" onclick="location.hash='#/recipes/${recipe.recipe_id}/edit/orchestrator'">Edit Recipe</button>

      <div class="field-group" style="margin-top:18px;">
        <span class="field-label">Title</span>
        <div class="field-value">${recipe.title}</div>
      </div>
      <div class="field-group">
        <span class="field-label">Description</span>
        <div class="field-value">${recipe.description || "—"}</div>
      </div>
      <div class="field-group">
        <span class="field-label">Execution pattern</span>
        <div class="field-value">${recipe.execution_pattern}${executionPatternHelpHtml(recipe.execution_pattern)}</div>
      </div>
      <div id="live-details-graph" style="margin-top:18px;"></div>
      ${hasMetadata ? liveMetadataFieldsHtml(recipe) : ""}
      <div class="notice-banner" style="margin-top:18px;">
        This recipe is served live by the Sandbox Stack backend — the OGC API Records
        Wrapper, the Cookbook API Registry, and the Cook Orchestrator.
        Go to the <a href="#/recipes/${recipe.recipe_id}/wizard">Recipe Wizard</a> tab to choose its
        tools, data and parameters and run it.
      </div>`;

    // The recipe's own default/as-authored blueprint (no run, no tool
    // overrides), computed from its real CWL-derived DAG via the same
    // node/edge renderer the Status tab's built graph uses
    // (liveRecipe.renderGraph).
    const graphEl = body.querySelector("#live-details-graph");
    try {
      const dag = await sandboxApi.getRecipeDag(recipe.recipe_id);
      liveRecipe.renderGraph(graphEl, dag, [], { title: "Recipe Schema" });
    } catch (err) {
      graphEl.innerHTML = `<div class="notice-banner">Could not load this recipe's pipeline.<br /><small>${err.message}</small></div>`;
    }
  } else {
    body.innerHTML = `<div class="empty-state">Nothing here yet for this recipe.</div>`;
  }

  initHelpTips(container);
}

export async function render(container, params, ctx) {
  const { recipeId, tab = "details" } = params;
  const recipe = await api.findRecipeById(recipeId);
  if (!recipe) {
    container.innerHTML = `<div class="empty-state">Recipe not found.</div>`;
    return;
  }

  ctx.setTitle("Recipes");
  ctx.setSubtitle(recipe.title);

  if (tab === "data") {
    // Most recipes have no dataset ingredients at all, so nothing in the
    // catalogue should match — "none" is a sentinel format no real dataset
    // has, which locks the Formats facet to a value that correctly filters
    // the grid down to zero, rather than an empty lock (which this component
    // treats as "no filter", i.e. showing everything). A recipe that DOES
    // declare a data input (e.g. Rotterdam Boundary Buffer's GeoJSON
    // boundary — see data.js::ingredientsFromDag) locks to the catalogue
    // formats that fit it.
    const formats = recipeCompatibleFormats(recipe);
    await dataCatalogueView.render(container, {}, ctx, {
      lockedFormats: formats.length ? formats : ["none"],
      hideRegister: true,
      hideHeading: true,
      facetKeys: ["owner_hub_name", "tags", "format"],
      topTabsHtml: tabsHtml(recipe.recipe_id, tab),
    });
    return;
  }

  if (tab === "apps") {
    // "Compatible" for a CWL recipe means "the tool services its steps
    // actually call" — derived from its DAG's process ids, which map 1:1
    // onto the live app ids js/data.js::liveAppFromDescription() builds
    // (`app-${processId}`) — not a data-format lock.
    let appIds = [];
    try {
      const dag = await sandboxApi.getRecipeDag(recipe.recipe_id);
      appIds = dag.steps.map((s) => `app-${s.process_id}`);
    } catch (err) {
      console.warn(`Could not fetch DAG for '${recipe.recipe_id}' to determine compatible apps.`, err);
    }
    await appsCatalogueView.render(container, {}, ctx, {
      appIds,
      hideRegister: true,
      hideHeading: true,
      facetKeys: ["owner", "tags"],
      topTabsHtml: tabsHtml(recipe.recipe_id, tab),
    });
    return;
  }

  if (tab === "wizard") {
    await recipeWizardView.render(container, recipe, ctx, {
      topTabsHtml: tabsHtml(recipe.recipe_id, tab),
    });
    return;
  }

  await renderTabBody(container, recipe, tab);
}
