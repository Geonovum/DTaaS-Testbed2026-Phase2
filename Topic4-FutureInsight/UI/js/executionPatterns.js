// Shared explanations for the four execution patterns a recipe/app can use —
// describes how the platform's backend and UI actually talk to the external
// tool depending on how long the computation takes and how complex the
// workflow is. Rendered as a small "?" help balloon wherever an execution
// pattern is shown (Recipes catalogue filter, Recipe Details tab).
import { icons } from "./icons.js";

export const EXECUTION_PATTERN_HELP = {
  "synchronous (single call)":
    "The user clicks run, the front-end sends an API request, and the server returns the result immediately in the same HTTP response. Used for quick, lightweight checks — e.g. a 10-meter buffer calculation, a building height lookup, or a simple schema/attribute validator.",
  "asynchronous (job-based)":
    "The front-end submits the parameters to the app's API, which immediately replies with a 202 Accepted status and a Job ID, freeing up the UI while processing runs in the background. The user is notified (e.g. by email or web notification) once it's finished.",
  "asynchronous (JobID poll)":
    "After submitting a job and receiving a Job ID, the client app repeatedly polls an endpoint at set intervals (e.g. every 5 seconds) until the status changes from PENDING to FINISHED, then retrieves the output assets.",
  "asynchronous (chained jobs)":
    "A multi-stage pipeline where the output dataset of one background job is automatically passed as the input that triggers a second background job — e.g. a traffic simulation's output feeding a CO₂/noise model, which in turn feeds a 3D visualization renderer.",
};

export function executionPatternHelpHtml(pattern) {
  const text = EXECUTION_PATTERN_HELP[pattern];
  if (!text) return "";
  return `<span class="help-tip" tabindex="0" data-help-text="${text.replace(/"/g, "&quot;")}">${icons.help}</span>`;
}

// A single shared floating tooltip, positioned in JS (not pure CSS) so it
// can't get clipped by a scrolling ancestor like the narrow filter sidebar —
// position:fixed escapes that clipping, which position:absolute wouldn't.
let bubbleEl = null;

function ensureBubble() {
  if (bubbleEl) return bubbleEl;
  bubbleEl = document.createElement("div");
  bubbleEl.className = "help-tip-bubble";
  document.body.appendChild(bubbleEl);
  return bubbleEl;
}

function showBubble(trigger, text) {
  const el = ensureBubble();
  el.textContent = text;
  el.style.display = "block";
  const rect = trigger.getBoundingClientRect();
  const maxWidth = 260;
  const spaceBelow = window.innerHeight - rect.bottom;
  const top = spaceBelow > 100 ? rect.bottom + 8 : rect.top - el.offsetHeight - 8;
  let left = Math.min(rect.left, window.innerWidth - maxWidth - 12);
  left = Math.max(left, 8);
  el.style.top = `${Math.max(8, top)}px`;
  el.style.left = `${left}px`;
}

function hideBubble() {
  if (bubbleEl) bubbleEl.style.display = "none";
}

/** Wires hover/focus behavior for every `.help-tip[data-help-text]` inside `container`. */
export function initHelpTips(container) {
  container.querySelectorAll(".help-tip[data-help-text]").forEach((el) => {
    const text = el.getAttribute("data-help-text");
    el.addEventListener("mouseenter", () => showBubble(el, text));
    el.addEventListener("mouseleave", hideBubble);
    el.addEventListener("focus", () => showBubble(el, text));
    el.addEventListener("blur", hideBubble);
  });
}
