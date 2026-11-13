// A small, honest slice of "Digital Twin: view and stack your data layers"
// — not the full Digital Twin viewer (out of scope for this testbed), just a
// real map showing
// every resource actually saved to a hub-datasets-backed dataset (see
// ../../services/hub-datasets), each as its own togglable layer.
//
// Opened from the existing "Preview" button on a dataset card — see
// views/dataCatalogue.js and views/hubs.js, both of which branch to this
// instead of the usual mocked toast only for a dataset carrying `is_live`
// (see data.js::getHubDatasets).
import * as sandboxApi from "./sandboxApi.js";
import { cityJsonFootprints } from "./cityJson.js";
import { icons } from "./icons.js";
import { showToast } from "./state.js";

// Rotterdam-centered — every dataset this preview currently ever shows
// (the PDOK boundary, and any buffer saved from it) is Rotterdam-local.
const DEFAULT_CENTER = [51.92, 4.48];
const DEFAULT_ZOOM = 11;

const LAYER_COLORS = ["#2f7bd9", "#d9772f", "#2fa87a", "#a83fd9", "#d92f57", "#7ad92f"];

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// A saved result's name is "<recipe title> — <date>, <time>" (see
// liveRecipe.js's autoSaveToHub, which uses toLocaleString()). Split into the
// recipe title and the date and time shown under it. The date and time come
// from the name itself — the moment the result was saved — and only fall
// back to the server's `created` timestamp for a name not in that shape.
function resultLabel(resource) {
  const name = resource.name || "";
  const sep = name.lastIndexOf(" — ");
  const title = sep > 0 ? name.slice(0, sep) : name;
  const stamp = sep > 0 ? name.slice(sep + 3) : "";
  const comma = stamp.indexOf(", ");
  if (comma > 0) return { title, date: stamp.slice(0, comma), time: stamp.slice(comma + 2) };
  const created = resource.created ? new Date(resource.created) : null;
  if (created && !Number.isNaN(created.getTime())) {
    return { title, date: created.toLocaleDateString(), time: created.toLocaleTimeString() };
  }
  return { title, date: stamp, time: "" };
}

// What to draw for a saved result: the result itself when it is GeoJSON, or
// the building footprints of the CityJSON model it links to (roofer's
// reconstruction saves plain JSON with an `artifacts.cityjson.href`).
// Anything else is handed to Leaflet as-is, which rejects it, and the result
// then shows as having no geometry.
async function mapContent(content) {
  const geoJsonTypes = ["Feature", "FeatureCollection", "Point", "MultiPoint", "LineString",
    "MultiLineString", "Polygon", "MultiPolygon", "GeometryCollection"];
  if (content && geoJsonTypes.includes(content.type)) return content;
  return (await cityJsonFootprints(content)) || content;
}

// A building footprint's popup adds the building's id and heights (when the
// CityJSON has them) under the result's own label.
function featureDetailsHtml(feature) {
  const p = (feature && feature.properties) || {};
  if (!p.cityObjectId) return "";
  const m = (v) => (typeof v === "number" ? `${v.toFixed(1)} m` : null);
  const rows = [
    [p.cityObjectType || "Object", p.cityObjectId],
    ["Roof height", m(p.roofHeight)],
    ["Ground height", m(p.groundHeight)],
  ].filter(([, v]) => v);
  return `<span class="hub-layer-popup__details">${rows
    .map(([k, v]) => `<span><b>${escapeHtml(k)}:</b> ${escapeHtml(v)}</span>`)
    .join("")}</span>`;
}

function resultLabelHtml(resource, cls) {
  const { title, date, time } = resultLabel(resource);
  return `
    <span class="${cls}__title">${escapeHtml(title)}</span>
    ${date || time ? `<span class="${cls}__meta"><span>${escapeHtml(date)}</span><span>${escapeHtml(time)}</span></span>` : ""}`;
}

// An in-app "are you sure?" dialog, stacked over the preview, for a
// destructive action. `items` ({title, date, time}, see resultLabel) lists
// exactly what the action affects. Resolves true only on the explicit confirm button;
// Cancel (focused by default, so Enter is safe), Escape and a click outside
// all resolve false. Escape is caught before the preview's own Escape
// handler, so it closes only this dialog, not the preview behind it.
function confirmDialog({ title, message, items = [], confirmLabel }) {
  const MAX_LISTED = 6;
  const listed = items.slice(0, MAX_LISTED);
  const listHtml = items.length
    ? `<ul class="confirm-dialog__list">
        ${listed
          .map(
            (it) =>
              `<li><span class="hub-layer__title">${escapeHtml(it.title)}</span><span class="hub-layer__meta"><span>${escapeHtml(it.date)}</span><span>${escapeHtml(it.time)}</span></span></li>`
          )
          .join("")}
        ${items.length > MAX_LISTED ? `<li class="confirm-dialog__more">and ${items.length - MAX_LISTED} more</li>` : ""}
      </ul>`
    : "";
  return new Promise((resolve) => {
    const dlg = document.createElement("div");
    dlg.className = "modal-overlay";
    dlg.innerHTML = `
      <div class="modal-panel confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-msg">
        <div class="confirm-dialog__body">
          <span class="confirm-dialog__icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2 21h20L12 3z"/><path d="M12 10v5"/><path d="M12 18h.01"/></svg></span>
          <div>
            <h2 id="confirm-dialog-title">${escapeHtml(title)}</h2>
            <p id="confirm-dialog-msg">${escapeHtml(message)}</p>
            ${listHtml}
          </div>
        </div>
        <div class="modal-panel__footer">
          <button type="button" class="btn btn-outline" data-confirm="no">Cancel</button>
          <button type="button" class="btn confirm-dialog__danger" data-confirm="yes">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(dlg);

    function done(answer) {
      dlg.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(answer);
    }
    function onKey(e) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      done(false);
    }
    document.addEventListener("keydown", onKey, true);
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) done(false);
      const answer = e.target.closest("[data-confirm]")?.getAttribute("data-confirm");
      if (answer) done(answer === "yes");
    });
    dlg.querySelector('[data-confirm="no"]').focus();
  });
}

export async function openHubDatasetPreview(dataset) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  document.body.appendChild(overlay);

  function close() {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  }
  function onKey(e) {
    if (e.key === "Escape") close();
  }
  document.addEventListener("keydown", onKey);

  overlay.innerHTML = `
    <div class="modal-panel" style="max-width:920px;width:92vw;height:75vh;">
      <div class="modal-panel__header">
        <h2>Preview — ${escapeHtml(dataset.title)}</h2>
        <button type="button" class="modal-panel__close" aria-label="Close">${icons.close}</button>
      </div>
      <div class="modal-panel__body" style="padding:0;">
        <div id="hub-preview-layers" class="hub-layers"></div>
        <div id="hub-preview-map" style="flex:1;min-width:0;"></div>
      </div>
      <div class="modal-panel__footer">
        <button type="button" class="btn btn-outline" id="hub-preview-delete-selected" disabled style="margin-right:auto;color:var(--c-error);border-color:var(--c-error);">Delete selected</button>
        <button type="button" class="btn btn-outline" id="hub-preview-close">Close</button>
      </div>
    </div>`;

  overlay.querySelector(".modal-panel__close").addEventListener("click", close);
  overlay.querySelector("#hub-preview-close").addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  // Deletes only the results whose layer is switched on in the list, after
  // an explicit confirmation
  // naming each one. Re-fetches and repaints the preview afterwards, so the
  // remaining results are immediately visible.
  const deleteBtn = overlay.querySelector("#hub-preview-delete-selected");
  const plural = (n) => `${n} ${n === 1 ? "result" : "results"}`;
  function selectedResources() {
    return [...layersEl.querySelectorAll("[data-layer-toggle]:checked")].map(
      (cb) => resources[Number(cb.getAttribute("data-layer-toggle"))]
    );
  }
  function updateDeleteButton() {
    const n = selectedResources().length;
    deleteBtn.disabled = n === 0;
    deleteBtn.textContent = n ? `Delete selected (${n})` : "Delete selected";
    deleteBtn.title = n ? "" : "Switch on the results to delete";
  }
  deleteBtn.addEventListener("click", async () => {
    const selected = selectedResources();
    if (!selected.length) return;
    const ok = await confirmDialog({
      title: `Delete ${plural(selected.length)}?`,
      message: `These results are removed from “${dataset.title}” for everyone using this hub. This can't be undone.`,
      items: selected.map(resultLabel),
      confirmLabel: `Delete ${plural(selected.length)}`,
    });
    if (!ok) return;
    deleteBtn.disabled = true;
    deleteBtn.textContent = "Deleting…";
    const outcomes = await Promise.allSettled(selected.map((r) => sandboxApi.deleteHubResource(dataset.id, r.id)));
    const failures = outcomes.filter((o) => o.status === "rejected").map((o) => o.reason);
    const deleted = outcomes.length - failures.length;
    if (failures.some((err) => err.outdatedService)) {
      showToast("Deleting selected results needs the updated hub-datasets service. Ask for it to be redeployed.");
    } else if (failures.length) {
      showToast(`Deleted ${deleted} of ${outcomes.length}. ${failures[0].message}`);
    } else {
      showToast(`Deleted ${plural(deleted)} from "${dataset.title}".`);
    }
    if (deleted) {
      close();
      openHubDatasetPreview(dataset);
    } else {
      updateDeleteButton();
    }
  });

  const layersEl = overlay.querySelector("#hub-preview-layers");
  const mapEl = overlay.querySelector("#hub-preview-map");
  layersEl.innerHTML = `<div class="empty-state">Loading resources…</div>`;

  const map = L.map(mapEl).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);
  // Leaflet measures mapEl's pixel size at construction time via
  // getBoundingClientRect() — a `setTimeout(fn, 0)` isn't reliably ordered
  // after the browser has actually committed the flex layout that gives
  // mapEl its real (60vh) height, so invalidateSize() called that way can
  // still see the wrong (pre-layout) size and silently no-op, leaving
  // Leaflet's internal tile grid permanently sized for a near-zero box. A
  // frame callback fires only after a real layout+paint pass has happened,
  // so it's actually ordered after the size is correct.
  requestAnimationFrame(() => map.invalidateSize());

  let resources;
  try {
    resources = await sandboxApi.listHubResources(dataset.id);
  } catch (err) {
    layersEl.innerHTML = `<div class="notice-banner">Could not load resources.<br /><small>${escapeHtml(err.message)}</small></div>`;
    return;
  }

  if (!resources.length) {
    layersEl.innerHTML = `<p style="font-size:.85rem;color:var(--g-900);">No resources saved to this dataset yet.</p>`;
    return;
  }

  // Each row: a visibility toggle, plus a zoom button — a small result can
  // otherwise be hard to find on a map fitted to every result at once.
  // Zoom stays unavailable until that resource's geometry has loaded, and for
  // good if it never does (a result with neither GeoJSON nor a link to a
  // CityJSON model, such as add-multiply-demo's number). It is
  // marked aria-disabled rather than `disabled`, because a disabled button
  // doesn't reliably show its tooltip, and the tooltip is what says why.
  layersEl.innerHTML = `
    <div class="hub-layers__heading">
      <h3>Layers</h3>
      <span class="hub-layers__count">${resources.length} ${resources.length === 1 ? "result" : "results"}</span>
    </div>
    ${resources
      .map(
        (r, i) => `
      <div class="hub-layer" data-layer-row="${i}">
        <label class="hub-layer__label" title="${escapeHtml(r.name)}">
          <input type="checkbox" data-layer-toggle="${i}" checked />
          <span class="hub-layer__swatch" style="background:${LAYER_COLORS[i % LAYER_COLORS.length]};"></span>
          <span class="hub-layer__text">${resultLabelHtml(r, "hub-layer")}</span>
        </label>
        <button type="button" class="hub-layer__zoom" data-layer-zoom="${i}" aria-disabled="true"
          title="Loading…" aria-label="Zoom to ${escapeHtml(r.name)}">${icons.search}</button>
      </div>`
      )
      .join("")}`;

  const layers = [];
  await Promise.all(
    resources.map(async (r, i) => {
      try {
        const content = await mapContent(await sandboxApi.getHubResourceContent(dataset.id, r.id));
        const label = resultLabelHtml(r, "hub-layer");
        const layer = L.geoJSON(content, {
          style: { color: LAYER_COLORS[i % LAYER_COLORS.length], weight: 2, fillOpacity: 0.15 },
        })
          .addTo(map)
          // Leaflet passes the clicked footprint (or the whole layer, when
          // opened from the zoom button), so a building shows its own details.
          .bindPopup((clicked) => `<span class="hub-layer-popup">${label}${featureDetailsHtml(clicked.feature)}</span>`);
        layers[i] = layer;
      } catch (err) {
        console.warn(`Could not load content for resource '${r.id}'`, err);
        const label = layersEl.querySelector(`[data-layer-toggle="${i}"]`)?.closest("label");
        if (label) label.title = `Could not load: ${err.message}`;
      }
    })
  );

  // A second, belt-and-braces invalidateSize() — by now real network time has
  // passed fetching every resource's content, so the container's layout is
  // certainly settled; fitBounds() computes its zoom/pan from the map's
  // CURRENT internal size, so this has to run before it, not just once at
  // construction time.
  map.invalidateSize();
  const bounds = L.latLngBounds([]);
  layers.forEach((l) => l && bounds.extend(l.getBounds()));
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24] });

  layersEl.querySelectorAll("[data-layer-toggle]").forEach((cb) =>
    cb.addEventListener("change", () => {
      const idx = Number(cb.getAttribute("data-layer-toggle"));
      cb.closest(".hub-layer")?.classList.toggle("is-hidden", !cb.checked);
      updateDeleteButton();
      const layer = layers[idx];
      if (!layer) return;
      if (cb.checked) map.addLayer(layer);
      else map.removeLayer(layer);
    })
  );
  // Enabled only now that every checkbox is wired to keep its count current.
  updateDeleteButton();

  layersEl.querySelectorAll("[data-layer-zoom]").forEach((btn) => {
    const idx = Number(btn.getAttribute("data-layer-zoom"));
    const layer = layers[idx];
    if (!layer || !layer.getBounds().isValid()) {
      const why = "No geometry in this result, so there is nothing to show on the map.";
      btn.title = why;
      btn.addEventListener("click", () => showToast(why));
      return;
    }
    btn.removeAttribute("aria-disabled");
    btn.title = "Zoom to this result";
    btn.addEventListener("click", () => {
      // Zooming to a hidden layer would show an empty map — show it first.
      const cb = layersEl.querySelector(`[data-layer-toggle="${idx}"]`);
      if (cb && !cb.checked) {
        cb.checked = true;
        cb.closest(".hub-layer")?.classList.remove("is-hidden");
        map.addLayer(layer);
        updateDeleteButton();
      }
      const layerBounds = layer.getBounds();
      map.fitBounds(layerBounds, { padding: [24, 24], maxZoom: 17 });
      // A popup of its own rather than layer.openPopup(): Leaflet would bind
      // that to the layer's first feature, i.e. some arbitrary building.
      L.popup()
        .setLatLng(layerBounds.getCenter())
        .setContent(`<span class="hub-layer-popup">${resultLabelHtml(resources[idx], "hub-layer")}</span>`)
        .openOn(map);
    });
  });
}
