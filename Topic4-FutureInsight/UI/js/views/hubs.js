import * as api from "../data.js";
import { icons } from "../icons.js";
import { setActiveHub, getActiveHubId, showToast } from "../state.js";
import { refreshActiveHubLabel } from "../app.js";
import { openHubDatasetPreview } from "../hubPreview.js";

const expanded = new Set();

function hubTreeHtml(hubs, selectedId) {
  return `
    <ul class="list-nav">
      ${hubs
        .map((h) => {
          const hasSub = h.subHubs && h.subHubs.length > 0;
          const isOpen = expanded.has(h.id);
          return `
          <li>
            <div style="display:flex;align-items:center;gap:4px;">
              ${
                hasSub
                  ? `<button class="app-header__icon-btn" style="flex:none;color:#23262b;width:22px;height:22px;" data-toggle-hub="${h.id}">${isOpen ? icons.chevronDown : icons.chevronRight}</button>`
                  : `<span style="flex:none;width:22px;"></span>`
              }
              <button style="flex:1;display:flex;justify-content:space-between;align-items:center;padding:8px 10px;${h.id === selectedId ? "background:var(--g-200);font-weight:700;color:var(--c-primary-dark);" : ""}" data-goto-hub="${h.id}">
                <span>${h.name}</span>
                <span class="${h.starred ? "star" : "star is-empty"}" style="width:16px;height:16px;">${icons.star}</span>
              </button>
            </div>
            ${
              hasSub && isOpen
                ? `<ul class="list-nav" style="padding-left:46px;">
                    ${h.subHubs
                      .map(
                        (sh) => `
                      <li>
                        <button style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;width:100%;${sh.id === selectedId ? "background:var(--g-200);font-weight:700;color:var(--c-primary-dark);" : ""}" data-goto-hub="${sh.id}">
                          <span>${sh.name}</span>
                          <span class="${sh.starred ? "star" : "star is-empty"}" style="width:16px;height:16px;">${icons.star}</span>
                        </button>
                      </li>`
                      )
                      .join("")}
                  </ul>`
                : ""
            }
          </li>`;
        })
        .join("")}
    </ul>`;
}

function subNavHtml(hubId, sub) {
  const items = [
    { key: "participants", label: "Participants" },
    { key: "recipes", label: "Recipes" },
    { key: "datasets", label: "Datasets" },
    { key: "apps", label: "Apps" },
    { key: "subscriptions", label: "Active subscriptions" },
  ];
  return `
    <ul class="list-nav">
      ${items
        .map(
          (it) => `
        <li><button class="${it.key === sub ? "is-active" : ""}" data-goto-sub="${hubId}|${it.key}">${it.label}</button></li>`
        )
        .join("")}
    </ul>`;
}

function recipeCardHtml(r) {
  return `
    <div class="catalog-card">
      <div class="catalog-card__header">
        <h3><a href="#/recipes/${r.recipe_id}">${r.title}</a></h3>
        <span class="star-toggle" title="Favorite">${icons.star}</span>
      </div>
      <div class="catalog-card__body">
        <p>${r.description}</p>
        <div class="catalog-card__actions">
          <a class="btn btn-secondary btn-sm" href="#/recipes/${r.recipe_id}">Info</a>
          <a class="btn btn-secondary btn-sm" href="#/recipes/${r.recipe_id}/edit">Edit Recipe</a>
          <a class="btn btn-secondary btn-sm" href="#/recipes/${r.recipe_id}/reviews">Reviews</a>
        </div>
      </div>
      <div class="catalog-card__footer">
        <span>Owner Hub <b>${r.owner_hub_id ? `<a href="#/hubs/${r.owner_hub_id}/details/recipes">${r.owner}</a>` : r.owner}</b></span>
        <span>License: ${r.license}</span>
        <span>Status: ${r.status}</span>
      </div>
    </div>`;
}

function appCardHtml(a) {
  return `
    <div class="catalog-card">
      <div class="catalog-card__header">
        <h3><a href="#/apps/${a.app_id}">${a.app_name}</a></h3>
        <span class="star-toggle" title="Favorite">${icons.star}</span>
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

function datasetCardHtml(d) {
  const title = d.title;
  const body = d.description || "";
  const footer = `<span>Owner Hub <b>${d.owner_hub_name}</b></span><span>License: ${d.license}</span>`;
  return `
    <div class="catalog-card">
      <div class="catalog-card__header">
        <h3>${title}</h3>
        <span class="star-toggle" title="Favorite">${icons.star}</span>
      </div>
      <div class="catalog-card__body">
        <p>${body}</p>
        <div class="catalog-card__actions">
          <button class="btn btn-secondary btn-sm" data-toast="Mocked — dataset info isn't wired up in this phase.">Info</button>
          ${
            d.is_live
              ? `<button class="btn btn-secondary btn-sm" data-hub-preview="${d.id}">Preview</button>`
              : `<button class="btn btn-secondary btn-sm" data-toast="Mocked — preview isn't wired up in this phase.">Preview</button>`
          }
          <button class="btn btn-secondary btn-sm" data-toast="Mocked — reviews aren't wired up in this phase.">Reviews</button>
        </div>
      </div>
      <div class="catalog-card__footer">
        ${footer}
      </div>
    </div>`;
}

function participantsTableHtml(people) {
  return `
    <table class="data-table">
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th></th></tr></thead>
      <tbody>
        ${people
          .map(
            (p) => `
          <tr>
            <td><span class="avatar">${p.initials}</span>${p.name}</td>
            <td>${p.email}</td>
            <td>${p.role}</td>
            <td><button class="kebab-btn" data-toast="Mocked — participant actions aren't wired up in this phase.">&#8942;</button></td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>`;
}

function splitPanelHtml(headerHtml, bodyHtml, { headerPadded = true, bodyPadded = true, variant = "" } = {}) {
  return `
    <div class="split-panel ${variant}">
      <div class="split-panel__header ${headerPadded ? "is-padded-lg" : ""}">${headerHtml}</div>
      <div class="split-panel__body ${bodyPadded ? "is-padded-lg" : ""}">${bodyHtml}</div>
    </div>`;
}

function actionRowHtml(primaryLabel, secondaryLabel, searchPlaceholder, searchId) {
  return `
    <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;">
      <button class="btn btn-primary" data-toast="Mocked — creation isn't wired up in this phase.">${primaryLabel}</button>
      <button class="btn btn-outline" data-toast="Mocked — favoriting isn't wired up in this phase.">${secondaryLabel}</button>
    </div>
    <div class="search-box">${icons.search}<input type="text" id="${searchId}" placeholder="${searchPlaceholder}" /></div>`;
}

function genericPaneHtml(title, text) {
  return `<div class="card"><h3 style="margin-top:0;">${title}</h3><p style="color:var(--g-900);font-size:.88rem;">${text}</p></div>`;
}

async function subPanelFor(hub, sub) {
  if (sub === "recipes") {
    const recipes = await api.getRecipesForHub(hub.id);
    return {
      header: actionRowHtml("+ New Recipe", "+ Add Favorite Recipe", "Search recipes", "sub-search"),
      body: `<div class="grid grid-2" id="sub-cards">${recipes.map(recipeCardHtml).join("") || `<div class="empty-state">No recipes found.</div>`}</div>`,
      items: recipes,
      cardFn: recipeCardHtml,
      matchText: (r) => `${r.title} ${r.description}`,
    };
  }
  if (sub === "apps") {
    const appsList = await api.getAppsForHub(hub.id);
    return {
      header: actionRowHtml("+ New App", "+ Add Favorite App", "Search apps", "sub-search"),
      body: `<div class="grid grid-2" id="sub-cards">${appsList.map(appCardHtml).join("") || `<div class="empty-state">No apps found.</div>`}</div>`,
      items: appsList,
      cardFn: appCardHtml,
      matchText: (a) => `${a.app_name} ${a.description}`,
    };
  }
  if (sub === "datasets") {
    // Only the hub's own catalogued datasets — what a recipe *needs* is shown
    // on that recipe's own pages (its data inputs), not as a dataset here.
    const datasets = await api.getCatalogueDatasetsForHub(hub.id);
    return {
      header: actionRowHtml("+ Register Dataset", "+ Add Favorite Dataset", "Search datasets", "sub-search"),
      body: `<div class="grid grid-2" id="sub-cards">${datasets.map(datasetCardHtml).join("") || `<div class="empty-state">No datasets found.</div>`}</div>`,
      items: datasets,
      cardFn: datasetCardHtml,
      matchText: (d) => `${d.title} ${d.description || ""}`,
    };
  }
  if (sub === "participants") {
    const people = await api.getParticipants();
    return {
      header: `
        <button class="btn btn-secondary" style="margin-bottom:14px;" data-toast="Mocked — invites aren't wired up in this phase.">+ Invite</button>
        <div class="search-box">${icons.search}<input type="text" id="sub-search" placeholder="Search participants" /></div>`,
      body: `<div id="sub-cards">${participantsTableHtml(people)}</div>`,
      items: people,
      renderFn: participantsTableHtml,
      matchText: (p) => `${p.name} ${p.email} ${p.role}`,
    };
  }
  // subscriptions — no data model for this in the Sandbox Stack
  return {
    header: "",
    body: genericPaneHtml("Active subscriptions", "Not part of the Geonovum Testbed — see the Recipes tab for the working example."),
    items: null,
  };
}

export async function render(container, params, ctx) {
  const { hubId, topTab: requestedTopTab = "details", sub = "recipes" } = params;
  const hubs = await api.getHubs();

  if (!hubId) {
    container.innerHTML = `
      <div class="two-col">
        ${splitPanelHtml(
          `<button class="btn btn-primary" style="margin-bottom:12px;width:100%;" id="btn-new-hub">+ New Hub</button>
           <div class="search-box">${icons.search}<input type="text" placeholder="Search hubs" /></div>`,
          hubTreeHtml(hubs, null),
          { headerPadded: false, bodyPadded: false, variant: "split-panel--flush" }
        )}
        <div class="split-panel split-panel--inset">
          <div class="split-panel__body" style="padding:0;">
            <div class="hero-welcome">
              <div class="hero-welcome__inner">
                <p>Welcome to the Hubs page</p>
                <p>Hubs are the way to bring people and organizations together, share data and work with data together with anyone in your organization or project.</p>
                <p>You can create your own hubs, or your organization can create 'sub hubs'.</p>
                <p>Hubs can contain members, digital twin viewers, datasets and apps.</p>
                <p>Click on a Hub in order to view its details</p>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    wireTreeEvents(container, ctx);
    container.querySelector("#btn-new-hub").addEventListener("click", () => showToast("Mocked — hub creation isn't wired up in this phase."));
    return;
  }

  const hub = await api.findHubById(hubId);
  if (!hub) {
    container.innerHTML = `<div class="empty-state">Hub "${hubId}" not found.</div>`;
    return;
  }
  ctx.setSubtitle(hub.name);

  // Visiting a hub's page makes it the active hub — no separate "set active"
  // action needed, matching how the real app scopes itself to whichever hub
  // you're currently looking at.
  if (getActiveHubId() !== hub.id) {
    setActiveHub(hub.id, hub.name);
    refreshActiveHubLabel();
  }

  // Non-participant hubs (you're not a member) only get the public Home tab —
  // Conversations/Details/Settings are participant-only.
  const topTab = hub.is_participant ? requestedTopTab : "home";

  const topTabs = hub.is_participant
    ? [
        { key: "home", label: "Home" },
        { key: "conversations", label: "Conversations" },
        { key: "details", label: "Details" },
        { key: "settings", label: "Settings" },
      ]
    : [{ key: "home", label: "Home" }];

  const rightHeader = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px;">
      <h1 class="view-title" style="margin-bottom:0;">${hub.name}</h1>
      <span class="badge badge-public">Active hub</span>
    </div>
    <div class="tabs" style="margin-bottom:0;">
      ${topTabs
        .map(
          (t) =>
            `<a class="tab ${t.key === topTab ? "is-active" : ""}" href="#/hubs/${hub.id}/${t.key}${t.key === "details" ? "/" + sub : ""}">${t.label}</a>`
        )
        .join("")}
    </div>`;

  let rightBody = "";
  let subInfo = null;

  if (topTab === "home") {
    rightBody = genericPaneHtml(hub.name, "Hub landing page — welcome message, images and description configured by the hub owner (see Hub Settings › Hub home page in the platform docs).");
  } else if (topTab === "conversations") {
    rightBody = genericPaneHtml("Conversations", "Both hub owners and participants can create or join conversations happening in this hub.");
  } else if (topTab === "settings") {
    rightBody = genericPaneHtml("Settings", "Settings content depends on your role: hub owners see General / Findability / Authentication / Billing / Subscription Models; participants see only Statistics.");
  } else {
    subInfo = await subPanelFor(hub, sub);
    rightBody = `
      <div class="two-col" style="height:100%;">
        <div style="padding-top:2px;">${subNavHtml(hub.id, sub)}</div>
        ${splitPanelHtml(subInfo.header, subInfo.body, { headerPadded: false, bodyPadded: false })}
      </div>`;
  }

  container.innerHTML = `
    <div class="two-col">
      ${splitPanelHtml(
        `<button class="btn btn-primary" style="margin-bottom:12px;width:100%;" id="btn-new-hub">+ New Hub</button>
         <div class="search-box">${icons.search}<input type="text" placeholder="Search hubs" /></div>`,
        hubTreeHtml(hubs, hub.id),
        { headerPadded: false, bodyPadded: false, variant: "split-panel--flush" }
      )}
      ${splitPanelHtml(rightHeader, rightBody, { headerPadded: true, bodyPadded: topTab !== "details", variant: "split-panel--inset" })}
    </div>
  `;

  wireTreeEvents(container, ctx);
  container.querySelector("#btn-new-hub").addEventListener("click", () => showToast("Mocked — hub creation isn't wired up in this phase."));


  container.querySelectorAll("[data-toast]").forEach((btn) =>
    btn.addEventListener("click", () => showToast(btn.getAttribute("data-toast")))
  );
  container.querySelectorAll("[data-goto-app-live]").forEach((btn) =>
    btn.addEventListener("click", () => window.open(btn.getAttribute("data-goto-app-live"), "_blank", "noopener"))
  );
  container.querySelectorAll("[data-hub-preview]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const dataset = subInfo && subInfo.items && subInfo.items.find((d) => d.id === btn.getAttribute("data-hub-preview"));
      if (dataset) openHubDatasetPreview(dataset);
    })
  );

  if (subInfo && subInfo.items) {
    const searchInput = container.querySelector("#sub-search");
    if (searchInput) {
      searchInput.addEventListener("input", (e) => {
        const q = e.target.value.trim().toLowerCase();
        const filtered = subInfo.items.filter((it) => subInfo.matchText(it).toLowerCase().includes(q));
        const cardsEl = container.querySelector("#sub-cards");
        if (subInfo.renderFn) {
          cardsEl.innerHTML = filtered.length ? subInfo.renderFn(filtered) : `<div class="empty-state">No matches for "${e.target.value}".</div>`;
        } else {
          cardsEl.innerHTML = filtered.map(subInfo.cardFn).join("") || `<div class="empty-state">No matches for "${e.target.value}".</div>`;
        }
        container.querySelectorAll("[data-toast]").forEach((btn) =>
          btn.addEventListener("click", () => showToast(btn.getAttribute("data-toast")))
        );
        container.querySelectorAll("[data-goto-app-live]").forEach((btn) =>
          btn.addEventListener("click", () => window.open(btn.getAttribute("data-goto-app-live"), "_blank", "noopener"))
        );
        container.querySelectorAll("[data-hub-preview]").forEach((btn) =>
          btn.addEventListener("click", () => {
            const dataset = filtered.find((d) => d.id === btn.getAttribute("data-hub-preview"));
            if (dataset) openHubDatasetPreview(dataset);
          })
        );
      });
    }
  }
}

function wireTreeEvents(container, ctx) {
  container.querySelectorAll("[data-toggle-hub]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-toggle-hub");
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      render(container, currentParamsFromHash(), ctx);
    });
  });
  container.querySelectorAll("[data-goto-hub]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-goto-hub");
      const hub = await api.findHubById(id);
      ctx.navigate(hub && hub.is_participant ? `#/hubs/${id}/details/recipes` : `#/hubs/${id}/home`);
    });
  });
  container.querySelectorAll("[data-goto-sub]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const [hId, subKey] = btn.getAttribute("data-goto-sub").split("|");
      ctx.navigate(`#/hubs/${hId}/details/${subKey}`);
    });
  });
}

function currentParamsFromHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [, hubId, topTab, sub] = raw.split("/").filter(Boolean);
  return { hubId, topTab, sub };
}
