import * as api from "../data.js";
import { icons } from "../icons.js";
import { showToast } from "../state.js";
import { openHubDatasetPreview } from "../hubPreview.js";

const favorites = new Set();

const ALL_FACETS = [
  { key: "owner_hub_name", label: "Owner hubs", values: (d) => [d.owner_hub_name] },
  { key: "part_of_hub", label: "Part of hub", values: (d) => [d.owner_hub_name] },
  { key: "findability", label: "Findability", values: (d) => [d.findability] },
  { key: "tags", label: "Tags", values: (d) => d.tags || [] },
  { key: "format", label: "Formats", values: (d) => d.resources.map((r) => r.format) },
];

function uniqueValues(items, facet) {
  const set = new Set();
  items.forEach((i) => facet.values(i).forEach((v) => set.add(v)));
  return [...set].sort();
}

// Lets a link open the catalogue pre-filtered, e.g. `#/data?tags=A,B` — the
// catalogue reads them straight into its own facet selections on load.
function presetValuesFromQuery(query, key) {
  if (!query) return [];
  const raw = query.get(key);
  return raw ? raw.split(",").filter(Boolean) : [];
}

function facetHtml(facet, datasets, state) {
  const values = uniqueValues(datasets, facet);
  const isOpen = state.openFacets.has(facet.key);
  const hasActive = state.selected[facet.key].size > 0;
  const isLockedFacet = facet.key === "format" && state.lockedFormats;
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
              // Count matching occurrences, not matching datasets — a format
              // like "3D Tiles" can appear as several resources within one
              // dataset.
              const count = datasets.reduce((sum, d) => sum + facet.values(d).filter((x) => x === v).length, 0);
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

function geoAndRatingFacetHtml() {
  return `
    <div class="facet" data-facet="geo">
      <button class="facet__header" data-facet-toggle="geo">
        <span>Geographical search</span>
        ${icons.chevronDown}
      </button>
      <div class="facet__options">
        <input type="text" placeholder="Search by city or postcode" disabled title="Mocked — not wired up in this phase" />
      </div>
    </div>
    <div class="facet" data-facet="ratings">
      <button class="facet__header" data-facet-toggle="ratings">
        <span>Ratings</span>
        ${icons.chevronDown}
      </button>
      <div class="facet__options">
        ${[5, 4, 3, 2, 1].map((n) => `<label class="facet__option"><input type="checkbox" disabled /><span class="facet__option-label">${"★".repeat(n)}${"☆".repeat(5 - n)} &amp; up</span></label>`).join("")}
      </div>
    </div>`;
}

// Cap how many tag badges render inline so a dataset with many tags doesn't
// stretch its card taller than the others in the grid — the rest collapse
// into a single "+N more" badge instead of wrapping. Deliberately the
// dataset's own `tags` (its topic/category labels), not its resources' names
// — a live dataset's resource names can be arbitrary/timestamped (e.g. a
// recipe's "Save to Hub" run, named "<recipe title> — <run timestamp>"),
// which made no sense rendered as a badge row here.
const TAG_BADGE_LIMIT = 4;

function tagBadgesHtml(d) {
  const tags = d.tags || [];
  const shown = tags.slice(0, TAG_BADGE_LIMIT);
  const rest = tags.slice(TAG_BADGE_LIMIT);
  return `
    ${shown.map((t) => `<span class="badge badge-public">${t}</span>`).join("")}
    ${rest.length ? `<span class="badge badge-muted" title="${rest.join(", ")}">+${rest.length} more</span>` : ""}
  `;
}

function cardHtml(d) {
  const isFav = favorites.has(d.id);
  return `
    <div class="catalog-card">
      <div class="catalog-card__header">
        <h3>${d.title}</h3>
        <button class="star-toggle ${isFav ? "is-fav" : ""}" data-fav="${d.id}" title="Favorite">${icons.star}</button>
      </div>
      <div class="catalog-card__body">
        <p>${d.description || ""}</p>
        <div class="catalog-card__actions">
          <button class="btn btn-secondary btn-sm" data-toast="Mocked — dataset info isn't wired up in this phase.">${icons.info} Info</button>
          ${
            d.is_live
              ? `<button class="btn btn-secondary btn-sm" data-hub-preview="${d.id}">${icons.eye} Preview</button>`
              : `<button class="btn btn-secondary btn-sm" data-toast="Mocked — preview isn't wired up in this phase.">${icons.eye} Preview</button>`
          }
          <button class="btn btn-secondary btn-sm" data-toast="Mocked — reviews aren't wired up in this phase.">${icons.star} Reviews</button>
        </div>
      </div>
      <div class="catalog-card__resources">
        ${tagBadgesHtml(d)}
      </div>
      <div class="catalog-card__footer">
        <span>Owner Hub <b><a href="#/hubs/${d.owner_hub_id}/details/datasets">${d.owner_hub_name}</a></b></span>
        <span>License: ${d.license}</span>
        <span>${d.resources.length} resource${d.resources.length === 1 ? "" : "s"}</span>
      </div>
    </div>`;
}

function matchesFilters(d, state) {
  const q = state.query.trim().toLowerCase();
  if (
    q &&
    !(
      d.title.toLowerCase().includes(q) ||
      (d.description || "").toLowerCase().includes(q) ||
      d.owner_hub_name.toLowerCase().includes(q) ||
      d.resources.some((r) => r.name.toLowerCase().includes(q))
    )
  ) {
    return false;
  }
  return state.facets.every((facet) => {
    const chosen = state.selected[facet.key];
    if (chosen.size === 0) return true;
    return facet.values(d).some((v) => chosen.has(v));
  });
}

function sortDatasets(datasets, sortBy) {
  const sorted = [...datasets];
  if (sortBy === "name") sorted.sort((a, b) => a.title.localeCompare(b.title));
  else if (sortBy === "owner") sorted.sort((a, b) => a.owner_hub_name.localeCompare(b.owner_hub_name));
  return sorted;
}

function renderGrid(container, datasets, state) {
  const filtered = sortDatasets(datasets.filter((d) => matchesFilters(d, state)), state.sortBy);
  container.querySelector("#dataset-cards").innerHTML =
    filtered.map(cardHtml).join("") || `<div class="empty-state">No datasets match the current search/filters.</div>`;
  container.querySelectorAll("[data-fav]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-fav");
      if (favorites.has(id)) favorites.delete(id);
      else favorites.add(id);
      btn.classList.toggle("is-fav");
    })
  );
  container.querySelectorAll("[data-toast]").forEach((btn) =>
    btn.addEventListener("click", () => showToast(btn.getAttribute("data-toast")))
  );
  container.querySelectorAll("[data-hub-preview]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const dataset = datasets.find((d) => d.id === btn.getAttribute("data-hub-preview"));
      if (dataset) openHubDatasetPreview(dataset);
    })
  );
}

function renderFacets(container, datasets, state) {
  const section = container.querySelector("#filter-facets");
  section.innerHTML = `
    ${state.showGeoAndRatings ? geoAndRatingFacetHtml() : ""}
    ${state.facets.map((f) => facetHtml(f, datasets, state)).join("")}
  `;
  wireFacetEvents(container, datasets, state);
}

function wireFacetEvents(container, datasets, state) {
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
      renderGrid(container, datasets, state);
      renderFacets(container, datasets, state);
    })
  );
  section.querySelectorAll("[data-facet-search]").forEach((input) =>
    input.addEventListener("input", (e) => {
      const key = e.target.getAttribute("data-facet-search");
      state.facetSearch[key] = e.target.value;
      renderFacets(container, datasets, state);
      container.querySelector(`[data-facet-search="${key}"]`).focus();
    })
  );
}

/**
 * Renders the dataset catalogue UI into `container`.
 * options.lockedFormats: string[] — if given, the Formats facet is pre-checked
 *   with these values; the recipe requires them so they can't be unchecked
 *   (a toast explains why instead of a heavy "locked" visual treatment —
 *   matches the real app, which just shows an active-filter dot).
 * options.facetKeys: string[] — restrict which facets are shown (e.g. a
 *   recipe's Compatible Data tab only shows Owner hubs / Tags / Formats,
 *   same as the real app's Compatible Data tab).
 * options.hideHeading: skip the "Datasets" title/subtitle (used when a
 *   parent view already shows the entity's name in the header/tabs).
 * options.hideRegister: hide the "+ Register Dataset" button.
 * options.topTabsHtml: full-width tab bar rendered above the whole layout
 *   (not inside the narrow filter column) so it keeps the exact same size
 *   and position as every other tab on that entity's page.
 */
export async function render(container, params, ctx, options = {}) {
  const datasets = await api.getDatasets();
  const facets = options.facetKeys ? ALL_FACETS.filter((f) => options.facetKeys.includes(f.key)) : ALL_FACETS;

  const state = {
    query: "",
    sortBy: "relevance",
    facets,
    showGeoAndRatings: !options.facetKeys,
    openFacets: new Set([
      ...(options.lockedFormats ? ["format"] : []),
      ...facets.filter((f) => presetValuesFromQuery(params.query, f.key).length).map((f) => f.key),
    ]),
    facetSearch: {},
    lockedFormats: options.lockedFormats || null,
    selected: Object.fromEntries(
      facets.map((f) => [
        f.key,
        new Set(f.key === "format" && options.lockedFormats ? options.lockedFormats : presetValuesFromQuery(params.query, f.key)),
      ])
    ),
  };

  const heading = options.hideHeading
    ? ""
    : `
      <h1 class="view-title is-on-canvas">${options.title || "Datasets"}</h1>
      <p class="view-subtitle is-on-canvas">${options.subtitle || "The OUP data catalogue — datasets registered in the nLDT Sandbox Stack's hub-datasets service."}</p>`;

  container.innerHTML = `
    <div class="catalog-shell">
      ${options.topTabsHtml ? `<div class="catalog-shell__tabs">${options.topTabsHtml}</div>` : ""}
      <div class="catalog-layout">
        <aside class="catalog-filters">
          ${options.hideRegister ? "" : `<button class="btn btn-primary" id="btn-register-dataset">+ Register Dataset</button>`}
          <div class="search-box">${icons.search}<input type="text" id="dataset-search" placeholder="Search datasets" /></div>
          <div class="filter-section">
            <div class="filter-section__title">Sort ${icons.sort}</div>
            <div style="padding:10px 2px 14px;">
              <label class="field-label" for="dataset-sort" style="margin-bottom:6px;">Sort by</label>
              <select id="dataset-sort">
                <option value="relevance">Relevance</option>
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
          <div class="grid grid-2" id="dataset-cards"></div>
        </div>
      </div>
    </div>
  `;

  renderFacets(container, datasets, state);
  renderGrid(container, datasets, state);

  const registerBtn = container.querySelector("#btn-register-dataset");
  if (registerBtn) registerBtn.addEventListener("click", () => showToast("Mocked — dataset registration isn't wired up in this phase."));

  container.querySelector("#dataset-search").addEventListener("input", (e) => {
    state.query = e.target.value;
    renderGrid(container, datasets, state);
  });
  container.querySelector("#dataset-sort").addEventListener("change", (e) => {
    state.sortBy = e.target.value;
    renderGrid(container, datasets, state);
  });
}
