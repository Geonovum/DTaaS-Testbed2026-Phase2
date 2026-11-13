import * as api from "../data.js";
import { showToast } from "../state.js";
import * as liveRecipe from "../liveRecipe.js";
import { initHelpTips } from "../executionPatterns.js";
import { detailsTabHtml, buildStaticGraph } from "./recipeDetail.js";

const TABS = [
  { key: "orchestrator", label: "Orchestrator" },
  { key: "metadata", label: "Metadata" },
];

// A read-only mock, deliberately: lays out the recipe's catalogue fields (title/owner/findability/description, the Recipe
// Schema graph, and the full field list down to Contact Person) — via the
// shared, exported detailsTabHtml()/buildStaticGraph() in recipeDetail.js.
// Nothing here is wired to a form or a save action.
function renderMetadataTab(container, recipe) {
  container.innerHTML = detailsTabHtml(recipe, buildStaticGraph(recipe));
  initHelpTips(container);
  container.querySelectorAll("[data-mock-edit-field]").forEach((btn) =>
    btn.addEventListener("click", () => showToast(`Mocked — editing "${btn.getAttribute("data-mock-edit-field")}" isn't wired up in this phase.`))
  );
}

function tabsHtml(recipeId, activeTab) {
  return `
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
      <div class="tabs" style="margin-bottom:0;border-bottom:none;">
        ${TABS.map((t) => `<a class="tab ${t.key === activeTab ? "is-active" : ""}" href="#/recipes/${recipeId}/edit/${t.key}">${t.label}</a>`).join("")}
      </div>
      <a class="btn btn-outline btn-sm" href="#/recipes/${recipeId}/details">&larr; Back to Recipe Details</a>
    </div>
    <div style="border-bottom:1px solid var(--g-400);margin-bottom:20px;"></div>`;
}

// The Orchestrator tab is the recipe's actual CWL document driving real
// execution in the Sandbox Stack (see ../liveRecipe.js::renderOrchestratorEditTab);
// Metadata is the read-only mock described above.
export async function render(container, params, ctx) {
  const { recipeId } = params;
  const tab = TABS.some((t) => t.key === params.tab) ? params.tab : "orchestrator";
  const recipe = await api.findRecipeById(recipeId);
  if (!recipe) {
    container.innerHTML = `<div class="empty-state">Recipe not found.</div>`;
    return;
  }
  ctx.setTitle("Recipes");
  ctx.setSubtitle(`${recipe.title} — Edit Recipe`);

  container.innerHTML = `
    <div class="detail-shell">
      ${tabsHtml(recipe.recipe_id, tab)}
      <div id="edit-tab-body"></div>
    </div>`;
  const body = container.querySelector("#edit-tab-body");

  if (tab === "metadata") renderMetadataTab(body, recipe);
  else await liveRecipe.renderOrchestratorEditTab(body, recipe);
}
