import * as api from "../data.js";
import { icons } from "../icons.js";
import { showToast } from "../state.js";

const favorites = new Set();

const ALL_FACETS = [
  { key: "owner", label: "Owner hub", values: (a) => [a.owner] },
  { key: "part_of_hub", label: "Part of hub", values: (a) => (a.part_of_hub ? [a.part_of_hub] : []) },
  { key: "findability", label: "Findability", values: (a) => [a.findability] },
  { key: "tags", label: "Tags", values: (a) => a.tags || [] },
  { key: "compatible_data_formats", label: "Compatible data formats", values: (a) => a.compatible_data_formats || [] },
  { key: "type_of_app", label: "Type of app", values: (a) => [a.type_of_app] },
];

function uniqueValues(items, facet) {
  const set = new Set();
  items.forEach((i) => facet.values(i).forEach((v) => set.add(v)));
  return [...set].sort();
}

// Lets a link open the catalogue pre-filtered, e.g. `#/apps?type_of_app=A` —
// the catalogue reads them straight into its own facet selections on load.
function presetValuesFromQuery(query, key) {
  if (!query) return [];
  const raw = query.get(key);
  return raw ? raw.split(",").filter(Boolean) : [];
}

function facetHtml(facet, apps, state) {
  const values = uniqueValues(apps, facet);
  const isOpen = state.openFacets.has(facet.key);
  const hasActive = state.selected[facet.key].size > 0;
  const isLockedFacet = facet.key === "compatible_data_formats" && state.lockedFormats;
  const searchTerm = (state.facetSearch[facet.key] || "").toLowerCase();
  const visibleValues = searchTerm ? values.filter((v) => v.toLowerCase().includes(searchTerm)) : values;

  return `
    <div class="facet ${isOpen ? "is-open" : ""}" data-facet="${facet.key}">
      <button class="facet__header" data-facet-toggle="${facet.key}">
        <span>${facet.label}${hasActive ? '<span class="facet__dot"></span>' : ""}</span>
        ${icons.chevronDown}
      </button>
      <div class="facet__options">
        ${
          values.length > 6
            ? `<div class="facet__search"><input type="text" placeholder="Search ${facet.label.toLowerCase()}" data-facet-search="${facet.key}" value="${state.facetSearch[facet.key] || ""}" /></div>`
            : ""
        }
        ${
          visibleValues
            .map((v) => {
              const locked = isLockedFacet && state.lockedFormats.includes(v);
              const checked = state.selected[facet.key].has(v);
              const count = apps.filter((a) => facet.values(a).includes(v)).length;
              return `
          <label class="facet__option" ${locked ? 'title="Required by this recipe"' : ""}>
            <input type="checkbox" data-facet-value="${facet.key}|${v}" ${checked ? "checked" : ""} ${locked ? 'data-locked="true"' : ""} />
            <span class="facet__option-label">${v}</span>
            <span class="facet__count">${count}</span>
          </label>`;
            })
            .join("") || `<p class="facet__empty">No matches.</p>`
        }
      </div>
    </div>`;
}

function cardHtml(a) {
  const isFav = favorites.has(a.app_id);
  return `
    <div class="catalog-card">
      <div class="catalog-card__header">
        <h3><a href="#/apps/${a.app_id}">${a.app_name}</a></h3>
        <button class="star-toggle ${isFav ? "is-fav" : ""}" data-fav="${a.app_id}" title="Favorite">${icons.star}</button>
      </div>
      <div class="catalog-card__body">
        <p>${a.description}</p>
        <div class="catalog-card__side">
          <img class="app-logo" src="${a.logo}" alt="${a.app_name} logo" />
          <div class="catalog-card__actions">
            <a class="btn btn-secondary btn-sm" href="#/apps/${a.app_id}">App Details</a>
            <button class="btn btn-secondary btn-sm" data-goto-app-live="${a.base_url}">Go to App</button>
          </div>
        </div>
      </div>
      <div class="catalog-card__footer">
        <span>Owner Hub <b>${a.owner}</b></span>
      </div>
    </div>`;
}

function matchesFilters(a, state) {
  const q = state.query.trim().toLowerCase();
  if (q && !(a.app_name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q) || a.owner.toLowerCase().includes(q))) {
    return false;
  }
  return state.facets.every((facet) => {
    const chosen = state.selected[facet.key];
    if (chosen.size === 0) return true;
    return facet.values(a).some((v) => chosen.has(v));
  });
}

function sortApps(apps, sortBy) {
  const sorted = [...apps];
  if (sortBy === "owner") sorted.sort((a, b) => a.owner.localeCompare(b.owner));
  else sorted.sort((a, b) => a.app_name.localeCompare(b.app_name));
  return sorted;
}

// Same three cases as the Recipes catalogue's empty state: unreachable,
// nothing registered, or filtered out.
function emptyStateHtml(apps) {
  if (apps.length) return `<div class="empty-state">No apps match the current search/filters.</div>`;
  if (api.getLastFetchError("apps")) {
    return `<div class="empty-state">Can't reach the nLDT Sandbox Stack's tool services, so no apps can be shown. Check that the backend is running and reachable from this browser.</div>`;
  }
  return `<div class="empty-state">No tool services to show here.</div>`;
}

function renderGrid(container, apps, state) {
  const filtered = sortApps(apps.filter((a) => matchesFilters(a, state)), state.sortBy);
  container.querySelector("#apps-cards").innerHTML = filtered.map(cardHtml).join("") || emptyStateHtml(apps);
  container.querySelectorAll("[data-fav]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-fav");
      if (favorites.has(id)) favorites.delete(id);
      else favorites.add(id);
      btn.classList.toggle("is-fav");
    })
  );
  container.querySelectorAll("[data-goto-app-live]").forEach((btn) =>
    btn.addEventListener("click", () => window.open(btn.getAttribute("data-goto-app-live"), "_blank", "noopener"))
  );
}

function renderFacets(container, apps, state) {
  const section = container.querySelector("#filter-facets");
  section.innerHTML = state.facets.map((f) => facetHtml(f, apps, state)).join("");
  wireFacetEvents(container, apps, state);
}

function wireFacetEvents(container, apps, state) {
  const section = container.querySelector("#filter-facets");
  section.querySelectorAll("[data-facet-toggle]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const key = btn.getAttribute("data-facet-toggle");
      if (state.openFacets.has(key)) state.openFacets.delete(key);
      else state.openFacets.add(key);
      btn.closest(".facet").classList.toggle("is-open");
    })
  );
  section.querySelectorAll("[data-facet-value]").forEach((cb) =>
    cb.addEventListener("change", () => {
      const [key, value] = cb.getAttribute("data-facet-value").split("|");
      if (cb.getAttribute("data-locked") === "true" && !cb.checked) {
        cb.checked = true;
        showToast(`"${value}" is required by this recipe and can't be removed here.`);
        return;
      }
      if (cb.checked) state.selected[key].add(value);
      else state.selected[key].delete(value);
      renderGrid(container, apps, state);
      renderFacets(container, apps, state);
    })
  );
  section.querySelectorAll("[data-facet-search]").forEach((input) =>
    input.addEventListener("input", (e) => {
      const key = e.target.getAttribute("data-facet-search");
      state.facetSearch[key] = e.target.value;
      renderFacets(container, apps, state);
      container.querySelector(`[data-facet-search="${key}"]`).focus();
    })
  );
}

/**
 * Renders the apps catalogue UI into `container` — same shape as
 * dataCatalogue.js's render(), so a recipe's Compatible Apps tab can embed it
 * exactly like Compatible Data.
 * options.lockedFormats: string[] — pre-checks the "Compatible data formats"
 *   facet with what this recipe requires; can't be unchecked (toast explains).
 * options.appIds: string[] — restricts the whole catalogue (search, facets,
 *   grid) to exactly these app ids, rather than filtering by format. Used by
 *   a live recipe's Compatible Apps tab: the apps that "are compatible" with
 *   a CWL recipe are the specific tool services its steps actually call
 *   (derived from the recipe's DAG), not something expressible as a data-
 *   format lock.
 * options.facetKeys: string[] — restrict which facets are shown.
 * options.hideHeading / hideRegister / title / subtitle / topTabsHtml: see
 *   dataCatalogue.js for the same meaning.
 */
export async function render(container, params, ctx, options = {}) {
  const allApps = await api.getApps();
  const apps = options.appIds ? allApps.filter((a) => options.appIds.includes(a.app_id)) : allApps;
  const facets = options.facetKeys ? ALL_FACETS.filter((f) => options.facetKeys.includes(f.key)) : ALL_FACETS;

  const state = {
    query: "",
    sortBy: "name",
    facets,
    openFacets: new Set([
      ...(options.lockedFormats ? ["compatible_data_formats"] : []),
      ...facets.filter((f) => presetValuesFromQuery(params.query, f.key).length).map((f) => f.key),
    ]),
    facetSearch: {},
    lockedFormats: options.lockedFormats || null,
    selected: Object.fromEntries(
      facets.map((f) => [
        f.key,
        new Set(f.key === "compatible_data_formats" && options.lockedFormats ? options.lockedFormats : presetValuesFromQuery(params.query, f.key)),
      ])
    ),
  };

  const heading = options.hideHeading
    ? ""
    : `
      <h1 class="view-title is-on-canvas">${options.title || "Apps"}</h1>
      <p class="view-subtitle is-on-canvas">${options.subtitle || "Applications registered on the OUP that a recipe can plug into."}</p>`;

  container.innerHTML = `
    <div class="catalog-shell">
      ${options.topTabsHtml ? `<div class="catalog-shell__tabs">${options.topTabsHtml}</div>` : ""}
      <div class="catalog-layout">
        <aside class="catalog-filters">
          ${options.hideRegister ? "" : `<button class="btn btn-primary" id="btn-new-app">+ New App</button>`}
          <div class="search-box">${icons.search}<input type="text" id="apps-search" placeholder="Search apps" /></div>
          <div class="filter-section">
            <div class="filter-section__title">Sort ${icons.sort}</div>
            <div style="padding:10px 2px 14px;">
              <label class="field-label" for="apps-sort" style="margin-bottom:6px;">Sort by</label>
              <select id="apps-sort">
                <option value="name">Name</option>
                <option value="owner">Owner</option>
              </select>
            </div>
          </div>
          <div class="filter-section">
            <div class="filter-section__title">Filter ${icons.refresh}</div>
            <div id="filter-facets"></div>
          </div>
        </aside>
        <div class="catalog-results">
          ${heading}
          <div class="grid grid-2" id="apps-cards"></div>
        </div>
      </div>
    </div>
  `;

  renderFacets(container, apps, state);
  renderGrid(container, apps, state);

  const registerBtn = container.querySelector("#btn-new-app");
  if (registerBtn) registerBtn.addEventListener("click", () => showToast("Mocked — app registration isn't wired up in this phase."));

  container.querySelector("#apps-search").addEventListener("input", (e) => {
    state.query = e.target.value;
    renderGrid(container, apps, state);
  });
  container.querySelector("#apps-sort").addEventListener("change", (e) => {
    state.sortBy = e.target.value;
    renderGrid(container, apps, state);
  });
}
