import { icons } from "./icons.js";
import * as api from "./data.js";
import { setActiveHub, getActiveHubId, getActiveHubName } from "./state.js";

import * as homeView from "./views/home.js";
import * as hubsView from "./views/hubs.js";
import * as recipesCatalogueView from "./views/recipesCatalogue.js";
import * as recipeDetailView from "./views/recipeDetail.js";
import * as appDetailView from "./views/appDetail.js";
import * as editRecipeView from "./views/editRecipe.js";
import * as placeholderView from "./views/placeholder.js";
import * as dataCatalogueView from "./views/dataCatalogue.js";

const NAV_ITEMS = [
  { key: "home", label: "Home", icon: icons.home, hash: "#/home" },
  { key: "hubs", label: "Hubs", icon: icons.hubs, hash: "#/hubs" },
  { key: "recipes", label: "Recipes", icon: icons.recipes, hash: "#/recipes" },
  { key: "digital-twin", label: "Digital Twin", icon: icons.digitalTwin, hash: "#/digital-twin" },
  { key: "data", label: "Data", icon: icons.data, hash: "#/data" },
  { key: "apps-nav", label: "Apps", icon: icons.apps, hash: "#/apps" },
  { key: "connect", label: "Connect", icon: icons.connect, hash: "#/connect" },
];

const sidebarEl = document.getElementById("sidebar");
const headerEl = document.getElementById("header");
const viewEl = document.getElementById("view");

function renderSidebar(activeKey) {
  sidebarEl.innerHTML = NAV_ITEMS.map(
    (item) => `
    <a class="app-sidebar__link ${item.key === activeKey ? "is-active" : ""}" href="${item.hash}">
      ${item.icon}
      <span>${item.label}</span>
    </a>`
  ).join("");
}

function renderHeader(title) {
  headerEl.innerHTML = `
    <img class="app-header__logo" src="assets/logo.svg" alt="Future Insight" />
    <div class="app-header__titles">
      <span class="app-header__title">${title}</span>
      <span class="app-header__subtitle" id="header-subtitle" style="display:none;"></span>
    </div>
    <div class="app-header__spacer"></div>
    <div class="app-header__right">
      <span class="app-header__hub" title="Active hub">
        ${icons.hubs}
        <span>Active Hub: <b id="active-hub-name">${getActiveHubName() || "—"}</b></span>
      </span>
      <button class="app-header__icon-btn" title="Language">${icons.globe}<span style="margin-left:2px;font-size:.7rem;">EN</span></button>
      <button class="app-header__icon-btn" title="Help">${icons.help}</button>
      <button class="app-header__icon-btn" title="Settings">${icons.gear}</button>
    </div>`;
}

export function updateHeaderTitle(title) {
  const el = headerEl.querySelector(".app-header__title");
  if (el) el.textContent = title;
}

export function updateHeaderSubtitle(subtitle) {
  const el = document.getElementById("header-subtitle");
  if (!el) return;
  if (subtitle) {
    el.textContent = subtitle;
    el.style.display = "block";
  } else {
    el.textContent = "";
    el.style.display = "none";
  }
}

export function refreshActiveHubLabel() {
  const el = document.getElementById("active-hub-name");
  if (el) el.textContent = getActiveHubName() || "—";
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [pathPart, queryPart] = raw.split("?");
  const segments = pathPart.split("/").filter(Boolean).map(decodeURIComponent);
  const query = new URLSearchParams(queryPart || "");
  return { segments, query };
}

function activeNavKeyFor(segments) {
  const first = segments[0] || "home";
  if (first === "apps") return "apps-nav";
  return first;
}

async function ensureDefaultActiveHub() {
  // A remembered hub only counts if it still exists (e.g. one saved by an
  // older build of this UI) — otherwise fall back to the default hub.
  if (getActiveHubName() && (await api.findHubById(getActiveHubId()))) return;
  const defaultId = await api.getDefaultActiveHubId();
  const hub = await api.findHubById(defaultId);
  if (hub) setActiveHub(hub.id, hub.name);
}

const ctx = {
  navigate(hash) {
    location.hash = hash;
  },
  setTitle(title) {
    updateHeaderTitle(title);
    document.title = `${title} — Geonovum Testbed Recipes`;
  },
  setSubtitle(subtitle) {
    updateHeaderSubtitle(subtitle);
  },
};

async function route() {
  await ensureDefaultActiveHub();
  const { segments, query } = parseHash();
  renderSidebar(activeNavKeyFor(segments));
  renderHeader("Geonovum Testbed Recipes");

  const [top, ...rest] = segments;

  // classList.toggle(cls, force) treats an explicit `undefined` force as "not
  // provided" (plain toggle) rather than "false" — so these must be coerced
  // to real booleans, or a truthy-but-short-circuited `&&` chain (e.g.
  // `rest[0]` being `undefined`) silently flips the class instead of
  // clearing it.
  const isCatalogRoute = !!(
    (top === "recipes" && !rest[0]) ||
    (top === "recipes" && rest[1] === "data") ||
    (top === "recipes" && rest[1] === "apps") ||
    (top === "apps" && !rest[0]) ||
    (top === "apps" && rest[0] && rest[1] === "data") ||
    top === "hubs" ||
    top === "data"
  );
  const isWhiteDetailRoute = !!(
    (top === "recipes" && rest[0] && rest[1] !== "data" && rest[1] !== "apps") ||
    (top === "apps" && rest[0] && rest[1] !== "data")
  );
  viewEl.classList.toggle("is-edge-to-edge", isCatalogRoute);
  viewEl.classList.toggle("is-white-detail", isWhiteDetailRoute);

  try {
    if (!top || top === "home") {
      ctx.setTitle("Home");
      await homeView.render(viewEl);
    } else if (top === "hubs") {
      const [hubId, topTab, sub] = rest;
      ctx.setTitle(hubId ? "Hubs" : "Hubs");
      await hubsView.render(viewEl, { hubId, topTab, sub }, ctx);
    } else if (top === "recipes") {
      if (!rest[0]) {
        ctx.setTitle("Recipes");
        await recipesCatalogueView.render(viewEl, { query }, ctx);
      } else if (rest[1] === "edit") {
        const [recipeId, , tab] = rest;
        await editRecipeView.render(viewEl, { recipeId, tab }, ctx);
      } else {
        const [recipeId, tab] = rest;
        await recipeDetailView.render(viewEl, { recipeId, tab }, ctx);
      }
    } else if (top === "apps") {
      const [appId, tab] = rest;
      await appDetailView.render(viewEl, { appId, tab, query }, ctx);
    } else if (top === "data") {
      ctx.setTitle("Data");
      await dataCatalogueView.render(viewEl, { query }, ctx);
    } else if (["digital-twin", "connect"].includes(top)) {
      const labelMap = { "digital-twin": "Digital Twin", connect: "Connect" };
      ctx.setTitle(labelMap[top]);
      await placeholderView.render(viewEl, { label: labelMap[top] }, ctx);
    } else {
      ctx.setTitle("Not found");
      viewEl.innerHTML = `<div class="empty-state">Unknown screen.</div>`;
    }
  } catch (err) {
    console.error(err);
    viewEl.innerHTML = `<div class="notice-banner">Could not load mock data. <small>${err.message}</small></div>`;
  }
}

window.addEventListener("hashchange", route);
window.addEventListener("DOMContentLoaded", route);
