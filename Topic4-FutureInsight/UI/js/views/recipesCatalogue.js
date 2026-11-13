import * as api from "../data.js";
import { icons } from "../icons.js";
import { showToast } from "../state.js";
import { executionPatternHelpHtml, initHelpTips } from "../executionPatterns.js";
import { PHASE_SEQUENCE } from "../constants.js";
import { RECORDS_WRAPPER_URL } from "../sandboxApi.js";

const favorites = new Set();

const FACETS = [
  { key: "owner", label: "Owner Hub", values: (r) => [r.owner] },
  { key: "execution_pattern", label: "Execution pattern", values: (r) => [r.execution_pattern] },
  { key: "project_phase", label: "Project phase", values: (r) => r.project_phase },
  { key: "target_roles", label: "Target roles", values: (r) => r.target_roles },
  { key: "theme", label: "Theme", values: (r) => r.theme || [] },
  { key: "location", label: "Location", values: (r) => r.location || [] },
  { key: "input_data_format", label: "Input Data Format", values: (r) => api.recipeInputFormats(r) },
  { key: "output_data_format", label: "Output Data Format", values: (r) => [api.recipeOutputDataFormatFacetLabel(r)] },
  { key: "findability", label: "Findability", values: (r) => [r.findability] },
];

const selected = Object.fromEntries(FACETS.map((f) => [f.key, new Set()]));
const openFacets = new Set(["project_phase"]);

// Lets the Home page's "What are you looking for?" search hand off its
// checked facet values as `#/recipes?target_roles=A,B&theme=C` — only
// touches `selected` when such a query is actually present, so plain
// in-app navigation to the catalogue keeps whatever the user last set.
function applyPresetFilters(query) {
  if (!query || [...query.keys()].length === 0) return;
  FACETS.forEach((f) => selected[f.key].clear());
  for (const [key, value] of query.entries()) {
    if (!selected[key]) continue;
    value.split(",").filter(Boolean).forEach((v) => selected[key].add(v));
  }
}

function uniqueValues(recipes, facet) {
  const set = new Set();
  recipes.forEach((r) => facet.values(r).forEach((v) => set.add(v)));
  return [...set].sort();
}

// Keeps every card's description block roughly the same size regardless of
// how long the underlying recipe's description actually is (some live
// recipes' descriptions — e.g. the playground slots' onboarding instructions
// — run to several paragraphs) — full text is still searchable via
// matchesFilters() below, which reads r.description directly, untruncated.
const CARD_DESCRIPTION_MAX_LENGTH = 160;

function truncateDescription(text) {
  if (!text || text.length <= CARD_DESCRIPTION_MAX_LENGTH) return text || "";
  return `${text.slice(0, CARD_DESCRIPTION_MAX_LENGTH).trimEnd()}…`;
}

function cardHtml(r) {
  const isFav = favorites.has(r.recipe_id);
  return `
    <div class="catalog-card">
      <div class="catalog-card__header">
        <h3><a href="#/recipes/${r.recipe_id}">${r.title}</a></h3>
        <button class="star-toggle ${isFav ? "is-fav" : ""}" data-fav="${r.recipe_id}" title="Favorite">${icons.star}</button>
      </div>
      <div class="catalog-card__body">
        <p>${truncateDescription(r.description)}</p>
        <div class="catalog-card__actions">
          <a class="btn btn-secondary btn-sm" href="#/recipes/${r.recipe_id}">Info</a>
          <a class="btn btn-secondary btn-sm" href="#/recipes/${r.recipe_id}/edit">Edit Recipe</a>
          <a class="btn btn-secondary btn-sm" href="#/recipes/${r.recipe_id}/reviews">Reviews</a>
        </div>
      </div>
      <div class="catalog-card__footer">
        <span>Owner <b>${r.owner_hub_id ? `<a href="#/hubs/${r.owner_hub_id}/details/recipes">${r.owner}</a>` : r.owner}</b></span>
        <span>License: ${r.license}</span>
        <span>Status: ${r.status}</span>
      </div>
    </div>`;
}

function matchesFilters(r, query) {
  const q = query.trim().toLowerCase();
  if (q && !(r.title.toLowerCase().includes(q) || r.description.toLowerCase().includes(q) || r.owner.toLowerCase().includes(q))) {
    return false;
  }
  return FACETS.every((facet) => {
    const chosen = selected[facet.key];
    if (chosen.size === 0) return true;
    const values = facet.values(r);
    return values.some((v) => chosen.has(v));
  });
}

function facetHtml(facet, recipes) {
  const values = uniqueValues(recipes, facet);
  const isOpen = openFacets.has(facet.key);
  return `
    <div class="facet ${isOpen ? "is-open" : ""}" data-facet="${facet.key}">
      <button class="facet__header" data-facet-toggle="${facet.key}">
        <span>${facet.label}</span>
        ${icons.chevronDown}
      </button>
      <div class="facet__options">
        ${values
          .map(
            (v) => `
          <label>
            <input type="checkbox" data-facet-value="${facet.key}|${v}" ${selected[facet.key].has(v) ? "checked" : ""} />
            <span>${v}</span>
            ${facet.key === "execution_pattern" ? executionPatternHelpHtml(v) : ""}
          </label>`
          )
          .join("")}
      </div>
    </div>`;
}

function phaseBarFacetHtml() {
  const isOpen = openFacets.has("project_phase");
  const current = [...selected.project_phase][0] || null;
  return `
    <div class="facet ${isOpen ? "is-open" : ""}" data-facet="project_phase">
      <button class="facet__header" data-facet-toggle="project_phase">
        <span>Project phase</span>
        ${icons.chevronDown}
      </button>
      <div class="facet__options">
        <div class="phase-bar" data-phase-bar>
          ${PHASE_SEQUENCE.map(
            (phase, i) => `
            <button type="button" class="phase-bar__step ${phase === current ? "is-current" : ""}" data-phase-select="${phase}" title="Show recipes in the ${phase} phase">
              ${i > 0 ? '<span class="phase-bar__line"></span>' : ""}
              <span class="phase-bar__dot"></span>
              <span class="phase-bar__label">${phase}</span>
            </button>`
          ).join("")}
        </div>
        <p class="phase-bar__current">${current ? `Showing recipes in: <b>${current}</b> · <a href="#" data-phase-clear>clear</a>` : "Click a phase to filter by it."}</p>
      </div>
    </div>`;
}

// Three different reasons the grid can be empty, each needing a different
// fix: the backend couldn't be reached, nothing is registered yet, or the
// search/filters exclude everything.
function emptyStateHtml(recipes) {
  if (recipes.length) return `<div class="empty-state">No recipes match the current search/filters.</div>`;
  if (api.getLastFetchError("recipes")) {
    return `<div class="empty-state">Can't reach the nLDT Sandbox Stack at <code>${RECORDS_WRAPPER_URL}</code>, so no recipes can be shown. Check that the backend is running and reachable from this browser.</div>`;
  }
  return `<div class="empty-state">No recipes are registered in the Cookbook API Registry yet.</div>`;
}

function renderGrid(container, recipes, query) {
  const filtered = recipes.filter((r) => matchesFilters(r, query));
  container.querySelector("#catalogue-cards").innerHTML = filtered.map(cardHtml).join("") || emptyStateHtml(recipes);
  wireCardEvents(container);
}

function wirePhaseBar(container, recipes, query) {
  const facetEl = container.querySelector('[data-facet="project_phase"]');
  if (!facetEl) return;
  facetEl.outerHTML = phaseBarFacetHtml();
  const freshEl = container.querySelector('[data-facet="project_phase"]');

  freshEl.querySelector('[data-facet-toggle="project_phase"]').addEventListener("click", () => {
    if (openFacets.has("project_phase")) openFacets.delete("project_phase");
    else openFacets.add("project_phase");
    freshEl.classList.toggle("is-open");
  });

  freshEl.querySelectorAll("[data-phase-select]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const phase = btn.getAttribute("data-phase-select");
      const alreadySelected = selected.project_phase.has(phase);
      selected.project_phase.clear();
      if (!alreadySelected) selected.project_phase.add(phase);
      renderGrid(container, recipes, query);
      wirePhaseBar(container, recipes, query);
    })
  );

  const clearLink = freshEl.querySelector("[data-phase-clear]");
  if (clearLink) {
    clearLink.addEventListener("click", (e) => {
      e.preventDefault();
      selected.project_phase.clear();
      renderGrid(container, recipes, query);
      wirePhaseBar(container, recipes, query);
    });
  }
}

function wireCardEvents(container) {
  container.querySelectorAll("[data-fav]").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const id = btn.getAttribute("data-fav");
      if (favorites.has(id)) favorites.delete(id);
      else favorites.add(id);
      btn.classList.toggle("is-fav");
    })
  );
}

export async function render(container, params, ctx) {
  const recipes = await api.getRecipes();
  let query = "";

  applyPresetFilters(params.query);

  container.innerHTML = `
    <div class="catalog-layout">
      <aside class="catalog-filters">
        <button class="btn btn-primary" id="btn-new-recipe">+ New Recipe</button>
        <div class="search-box">${icons.search}<input type="text" id="catalogue-search" placeholder="Search recipes" /></div>
        <div class="filter-section">
          <div class="filter-section__title">Filter</div>
          ${FACETS.map((f) => (f.key === "project_phase" ? phaseBarFacetHtml() : facetHtml(f, recipes))).join("")}
        </div>
      </aside>
      <div class="catalog-results">
        <h1 class="view-title is-on-canvas">Recipes</h1>
        <p class="view-subtitle is-on-canvas">
          The recipes registered in the nLDT Sandbox Stack's Cookbook API Registry, served
          live through its OGC API Records catalogue. Each card is one CWL workflow: the tool
          services it calls, the parameters it takes, and the data it needs.
        </p>
        <div class="grid grid-2" id="catalogue-cards"></div>
      </div>
    </div>
  `;

  renderGrid(container, recipes, query);
  wirePhaseBar(container, recipes, query);
  initHelpTips(container);

  container.querySelector("#btn-new-recipe").addEventListener("click", () => showToast("Mocked — recipe creation isn't wired up in this phase."));

  container.querySelector("#catalogue-search").addEventListener("input", (e) => {
    query = e.target.value;
    renderGrid(container, recipes, query);
  });

  container.querySelectorAll("[data-facet-toggle]").forEach((btn) => {
    const key = btn.getAttribute("data-facet-toggle");
    if (key === "project_phase") return; // handled by wirePhaseBar
    btn.addEventListener("click", () => {
      if (openFacets.has(key)) openFacets.delete(key);
      else openFacets.add(key);
      btn.closest(".facet").classList.toggle("is-open");
    });
  });

  container.querySelectorAll("[data-facet-value]").forEach((cb) =>
    cb.addEventListener("change", () => {
      const [key, value] = cb.getAttribute("data-facet-value").split("|");
      if (cb.checked) selected[key].add(value);
      else selected[key].delete(value);
      renderGrid(container, recipes, query);
    })
  );
}
