// Tiny shared UI state — active hub selection and a toast helper. Everything
// here is client-side only, nothing is persisted to a server. The active hub
// is remembered per viewer in localStorage so a page reload keeps it.

const HUB_STORAGE_KEY = "nldt.activeHub";

const readPref = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage unavailable — fall back to defaults
  }
};
const writePref = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — the choice just isn't remembered */
  }
};

let activeHubId = null;
let activeHubName = "";

try {
  const savedHub = JSON.parse(readPref(HUB_STORAGE_KEY));
  if (savedHub && savedHub.id && savedHub.name) {
    activeHubId = savedHub.id;
    activeHubName = savedHub.name;
  }
} catch {
  /* corrupt entry — ignore it, ensureDefaultActiveHub() picks a default */
}

export function setActiveHub(id, name) {
  activeHubId = id;
  activeHubName = name;
  writePref(HUB_STORAGE_KEY, JSON.stringify({ id, name }));
}

export function getActiveHubId() {
  return activeHubId;
}

export function getActiveHubName() {
  return activeHubName;
}

export function showToast(message) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("is-visible");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove("is-visible"), 2200);
}
