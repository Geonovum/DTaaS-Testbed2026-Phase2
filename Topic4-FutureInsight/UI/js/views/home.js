import * as api from "../data.js";

// Home is the Recent Activity dashboard. (#/home/search, an older route,
// also lands on this page.)

function feedItem(bullet, html, timestamp) {
  return `<li><span class="bullet">${bullet}</span><span>${html} ${timestamp ? `· <span class="timestamp">${timestamp}</span>` : ""}</span></li>`;
}

// For a panel that's honestly empty in the current perspective — e.g. the
// Sandbox Stack has no dataset catalogue or multi-hub activity of its own —
// rather than fabricating activity that didn't happen.
function emptyFeedItem(message) {
  return `<li style="color:var(--g-700);font-style:italic;">${message}</li>`;
}

function feedTileHtml({ title, gotoHash, gotoLabel, items }) {
  return `
    <div class="dashboard-tile">
      <div class="dashboard-tile__header"><h3>${title}</h3></div>
      <div class="dashboard-tile__body">
        <a class="btn btn-secondary" href="${gotoHash}">${gotoLabel}</a>
        <ul class="dashboard-tile__list">${items.join("")}</ul>
      </div>
    </div>`;
}

// The Recent Activity feed is built from the live recipes/apps/datasets
// actually running in the Sandbox Stack, and is honest (via emptyFeedItem)
// about panels that have nothing to show because the concept doesn't exist in
// this sandbox (it has no Digital Twins of its own). "Updates from public
// data" lists only the live hub-datasets rows (see api.getDatasets()'s
// `is_live` rows), e.g. the PDOK-backed "PDOK Rotterdam Boundary Data".
function recentActivityBodyHtml(recipes, apps, datasets) {
  const newsFromHubsItems = [
    emptyFeedItem("No Digital Twin activity — the nLDT Sandbox Hub only hosts the recipe, apps, and data shown in the other panels."),
  ];

  const liveDatasets = datasets.filter((d) => d.is_live);
  const updatesFromDataItems = liveDatasets.length
    ? liveDatasets.map((d) => feedItem("+", `Dataset <a href="#/data">${d.title}</a> is registered by <b>${d.owner_hub_name}</b>`, "live"))
    : [emptyFeedItem("No datasets registered in the Sandbox Stack catalogue yet.")];

  const newRecipesItems = recipes.length
    ? recipes.map((r) => feedItem("+", `Recipe <a href="#/recipes/${r.recipe_id}">${r.title}</a> is published by <b>${r.owner}</b>`, "live"))
    : [emptyFeedItem("No recipes registered in the Sandbox Stack catalogue yet.")];

  const newAppsItems = apps.length
    ? apps.map((a) => feedItem("+", `App <a href="#/apps/${a.app_id}">${a.app_name}</a> was added by <b>${a.owner}</b>`, "live"))
    : [emptyFeedItem("No tool services reachable right now.")];

  return `
    <div class="home-activity-grid">
      ${feedTileHtml({ title: "News from your hubs", gotoHash: "#/hubs", gotoLabel: "Go to Hubs", items: newsFromHubsItems })}
      ${feedTileHtml({ title: "New recipes", gotoHash: "#/recipes", gotoLabel: "Go to Recipes", items: newRecipesItems })}
      ${feedTileHtml({ title: "Updates from public data", gotoHash: "#/data", gotoLabel: "Go to Data", items: updatesFromDataItems })}
      ${feedTileHtml({ title: "New apps", gotoHash: "#/apps", gotoLabel: "Go to Apps", items: newAppsItems })}
    </div>`;
}

function sideHtml(welcomeLinks) {
  return `
    <div class="dashboard-tile is-major">
      <div class="dashboard-tile__header"><h3>Welcome</h3></div>
      <div class="dashboard-tile__body is-white">
        <ul class="welcome-links">
          ${welcomeLinks.map((l) => `<li><a href="#/home">${l}</a></li>`).join("")}
        </ul>
      </div>
    </div>
    <div class="dashboard-tile is-minor">
      <div class="dashboard-tile__header"><h3>Feedback</h3></div>
      <div class="dashboard-tile__body is-white">
        <div class="feedback-body">
          We are always interested in what you think about the OUP.<br />
          <a class="feedback-link" href="#/connect">Click here to leave your feedback</a>
        </div>
      </div>
    </div>`;
}

export async function render(container) {
  const welcomeLinks = ["Welcome", "How to start", "FAQ", "Governance & Ethics", "Help & Support", "Documentation & Release notes", "Terms"];
  const [recipes, apps, datasets] = await Promise.all([api.getRecipes(), api.getApps(), api.getDatasets()]);
  container.innerHTML = `
    <div class="home-page">
      <div class="home-top-bar">
        <h1 class="view-title is-on-canvas">Recent Activity</h1>
      </div>
      <div class="home-layout">
        <div class="home-main">${recentActivityBodyHtml(recipes, apps, datasets)}</div>
        <div class="home-side">${sideHtml(welcomeLinks)}</div>
      </div>
    </div>`;
}
