export async function render(container, params) {
  container.innerHTML = `
    <h1 class="view-title is-on-canvas">${params.label}</h1>
    <div class="page-panel">
      <div class="notice-banner">
        This section is out of scope for the Geonovum Testbed.
      </div>
      <div class="empty-state">Nothing to see here yet.</div>
    </div>
  `;
}
