// Recipe Schema graph — a small, purpose-built node-link diagram renderer
// (no external graph library) shared by the Recipe Details tab (the
// recipe's default, as-authored blueprint) and the Status tab (what a hub
// actually built through the Recipe Wizard). Both hand this the same shape —
// { nodes: [{id, kind, label, sublabel?, logo?, status?}], edges: [{from,
// to, muted?}] } — built from whatever source is appropriate (the static
// recipe record, or the wizard's live state).
//
// Columns are NOT fixed stages — they're computed from the actual edges, in
// two passes, so that every edge only ever connects two ADJACENT columns
// (nothing has to skip past a column it isn't actually connected to):
//
// 1. Every tool/output node gets a "core" layer via the classic longest-path
//    rule (0 if it has no tool/output predecessor of its own; otherwise 1 +
//    the deepest core layer among them) — computed as if raw inputs didn't
//    exist yet, so a chained tool (B consuming A's own output) still lands
//    strictly after A, in its own column.
// 2. A raw input is then pulled forward to sit immediately before the
//    EARLIEST tool/output it actually feeds — not dumped into one leftmost
//    "Data Inputs" column regardless of which stage uses it. An input that
//    only feeds a later stage gets its own dedicated column right before
//    that stage (titled e.g. "Data Inputs — Stage 2"), instead of a line
//    that has to detour around an earlier, unrelated stage to reach it.
//
// A recipe with no chaining still comes out as the familiar
// Inputs → Tool → Outputs three columns, since that's exactly what this
// produces when every tool is fed only by raw inputs.
const KIND_LABEL = { input: "Data Inputs", tool: "Tool & Engine", output: "Outputs", destination: "Result" };

function computeLayers(nodes, edges) {
  const ids = new Set(nodes.map((n) => n.id));
  const kindOf = new Map(nodes.map((n) => [n.id, n.kind]));

  // Pass 1 — core layer of every non-input node, considering only edges
  // whose source is itself non-input (a raw input contributes no depth of
  // its own; see pass 2 for where it actually lands).
  const coreIncoming = new Map(nodes.map((n) => [n.id, []]));
  edges.forEach((e) => {
    if (coreIncoming.has(e.to) && ids.has(e.from) && kindOf.get(e.from) !== "input") {
      coreIncoming.get(e.to).push(e.from);
    }
  });
  const coreLayer = new Map();
  function coreLayerOf(id, path) {
    if (coreLayer.has(id)) return coreLayer.get(id);
    if (path.has(id)) return 0; // guards against an accidental cycle
    path.add(id);
    const preds = coreIncoming.get(id) || [];
    const l = preds.length ? 1 + Math.max(...preds.map((p) => coreLayerOf(p, path))) : 0;
    coreLayer.set(id, l);
    return l;
  }
  nodes.forEach((n) => coreLayerOf(n.id, new Set()));

  // Every non-input node's real layer is its core layer doubled, leaving the
  // odd slot in between free for pass 2 to place its own direct inputs in.
  const layer = new Map();
  nodes.forEach((n) => {
    if (n.kind !== "input") layer.set(n.id, coreLayer.get(n.id) * 2);
  });

  // Results line up in the column after the last tool, and the save
  // destination after them — never beside a later tool, where an
  // intermediate result (one step's output a later step also reads) would
  // otherwise land and turn that column into an unlabeled mixed "Stage".
  const maxOf = (kind) => Math.max(-Infinity, ...nodes.filter((n) => n.kind === kind).map((n) => layer.get(n.id)));
  const lastTool = maxOf("tool");
  nodes.forEach((n) => {
    if (n.kind === "output" && Number.isFinite(lastTool)) layer.set(n.id, Math.max(layer.get(n.id), lastTool + 2));
  });
  const lastOutput = maxOf("output");
  nodes.forEach((n) => {
    if (n.kind === "destination" && Number.isFinite(lastOutput)) layer.set(n.id, Math.max(layer.get(n.id), lastOutput + 2));
  });

  // Pass 2 — a raw input sits one slot before whichever of its consumers has
  // the smallest layer, which is guaranteed to also be before every other
  // consumer it might have (later consumers only ever sit at an equal-or-
  // later layer). An input feeding both a very early and a much later
  // consumer still only gets to be adjacent to the nearer one; the edge to
  // the distant one may still skip ahead — not a shape any recipe in this
  // app actually has today.
  const outgoing = new Map(nodes.map((n) => [n.id, []]));
  edges.forEach((e) => {
    if (outgoing.has(e.from) && ids.has(e.to)) outgoing.get(e.from).push(e.to);
  });
  nodes.forEach((n) => {
    if (n.kind !== "input") return;
    const consumerLayers = (outgoing.get(n.id) || []).map((id) => layer.get(id)).filter((l) => l != null);
    layer.set(n.id, consumerLayers.length ? Math.min(...consumerLayers) - 1 : 0);
  });

  // Shift everything up so the smallest layer is 0 — an input positioned
  // immediately before the very first stage lands one slot below zero
  // before this normalization.
  const minLayer = Math.min(...layer.values());
  if (minLayer < 0) nodes.forEach((n) => layer.set(n.id, layer.get(n.id) - minLayer));

  return layer;
}

// Groups nodes into left-to-right columns by their computed layer, titling
// each by whatever kind of node actually landed there (numbering repeats,
// e.g. a second tool-only layer becomes "Tool & Engine — Stage 2", so a
// chained pipeline's two tool stages don't render two identical headers).
function layoutColumns(nodes, edges, kindLabels = KIND_LABEL) {
  const layerOf = computeLayers(nodes, edges);
  const byLayer = new Map();
  nodes.forEach((n) => {
    const l = layerOf.get(n.id) ?? 0;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l).push(n);
  });
  const kindOccurrences = {};
  return [...byLayer.keys()].sort((a, b) => a - b).map((l) => {
    const layerNodes = byLayer.get(l);
    const kinds = [...new Set(layerNodes.map((n) => n.kind))];
    const base = kinds.length === 1 ? kindLabels[kinds[0]] || kinds[0] : "Stage";
    kindOccurrences[base] = (kindOccurrences[base] || 0) + 1;
    const title = kindOccurrences[base] > 1 ? `${base} — Stage ${kindOccurrences[base]}` : base;
    return { title, nodes: layerNodes };
  });
}

// A node renders as a graph vertex — a pill with a status dot — not an info
// card: one line of text (label, optionally "· format"), plus a small app
// logo for tool nodes. Status is carried by the dot and a light border tint.
// The `recipe-graph__node--<kind>` class is what lets CSS mute a data-input
// node's red/amber "blocked/pending" colouring back to neutral (see
// styles.css) — an input isn't the decision any wizard step is actually
// asking the user to make there, so it shouldn't compete for attention with
// the tool/engine or destination node that is.
function nodeHtml(node) {
  const status = node.status || "default";
  return `
    <div class="recipe-graph__node recipe-graph__node--${node.kind} ${status !== "default" ? `is-${status}` : ""}" data-node="${node.id}" title="${node.label}${node.sublabel ? ` — ${node.sublabel}` : ""}">
      <span class="recipe-graph__node-dot"></span>
      ${node.logo ? `<img src="${node.logo}" alt="" class="recipe-graph__node-logo" />` : ""}
      <span class="recipe-graph__node-label">${node.label}</span>
      ${node.sublabel ? `<span class="recipe-graph__node-sub">${node.sublabel}</span>` : ""}
    </div>`;
}

function columnHtml(column) {
  return `
    <div class="recipe-graph__col">
      <div class="recipe-graph__col-title">${column.title}</div>
      ${column.nodes.map(nodeHtml).join("")}
    </div>`;
}

/**
 * Returns the graph's HTML — an SVG connector overlay plus one column per
 * computed layer (see layoutColumns above). Caller must keep the same
 * `graph` object around to pass to drawGraphConnectors() once this HTML is
 * actually in the live DOM.
 */
export function graphHtml(graph, { title = "", hint = "", kindLabels } = {}) {
  // kindLabels: optional per-kind column titles, overriding KIND_LABEL.
  const columns = layoutColumns(graph.nodes, graph.edges, { ...KIND_LABEL, ...kindLabels });
  // A recipe with several chained stages lays out wider than the panel that
  // hosts it — .app-main clips horizontal overflow globally (so an unrelated
  // wide element elsewhere can never scroll the whole page sideways), which
  // otherwise silently cuts the diagram off with no way to see the rest of
  // it. .recipe-graph__scroll gives this one diagram its own horizontal
  // scroller instead; the fade bars either side (toggled by
  // updateScrollShadows, below) are the only hint that there's more to see,
  // since a trackpad/touch scrollbar is often invisible until you touch it.
  // Two nested layers, not one — the fade bars have to be pinned to the
  // actual left/right edge of the VIEWPORT at all times, but a
  // position:absolute element anchored to a position:relative ancestor that
  // is ITSELF the overflow:auto element scrolls away with that ancestor's
  // content (it's still part of the same scrolling box), which is exactly
  // what made the fade drift into the middle of the diagram as soon as you
  // scrolled instead of staying put at the edge. So .recipe-graph__scroll
  // (outer) only ever holds position/overflow:hidden + the two fade
  // pseudo-elements and never itself scrolls; .recipe-graph__scroll-track
  // (inner) is the one with overflow-x, so the fades are outside its
  // scrolling box entirely and stay exactly where they visually belong.
  return `
    <div class="recipe-graph-wrap">
      ${title ? `<span class="field-label">${title}</span>` : ""}
      ${hint ? `<p class="recipe-graph__hint">${hint}</p>` : ""}
      <div class="recipe-graph__scroll" data-graph-scroll>
        <div class="recipe-graph__scroll-track" data-graph-scroll-track>
          <div class="recipe-graph" data-graph-root>
            <svg class="recipe-graph__lines"></svg>
            ${columns.map(columnHtml).join("")}
          </div>
        </div>
      </div>
    </div>`;
}

// Shows/hides the left/right fade bars based on how far the diagram is
// currently scrolled — both hidden when it fits without scrolling at all,
// which is still the common case (a simple three-column recipe). Also
// decides, itself, whether the container is allowed to scroll at all: some
// browser/OS combinations still paint an overflow-x:auto element's
// scrollbar track even when scrollWidth is only a sub-pixel or two past
// clientWidth (layout rounding, not a real overflow) — rather than trust
// that heuristic, .recipe-graph__scroll-track defaults to overflow-x:hidden
// in CSS and only earns "can-scroll-x" (which switches it to auto) once this
// measures an actual, more-than-rounding-noise overflow.
const OVERFLOW_TOLERANCE_PX = 2;
// trackEl is the element that actually scrolls (measured for overflow/
// scrollLeft, and whose own overflow-x this flips from hidden to auto);
// scrollEl is the outer, non-scrolling element whose ::before/::after fade
// bars this toggles — kept as two separate elements/params so the fades
// never sit inside the box they're measuring (see graphHtml above).
function updateScrollShadows(scrollEl, trackEl) {
  const overflow = trackEl.scrollWidth - trackEl.clientWidth;
  const canScroll = overflow > OVERFLOW_TOLERANCE_PX;
  trackEl.classList.toggle("can-scroll-x", canScroll);
  const atStart = trackEl.scrollLeft <= 1;
  const atEnd = trackEl.scrollLeft >= overflow - 1;
  scrollEl.classList.toggle("can-scroll-left", canScroll && !atStart);
  scrollEl.classList.toggle("can-scroll-right", canScroll && !atEnd);
}

const ARROW_LEN = 7;
const ARROW_HALF_WIDTH = 4.2;

// One colour per distinct source node, cycled — so an edge is traceable by
// eye from its start all the way to its arrowhead even when its curve
// crosses near an unrelated node (e.g. a workflow input feeding a later
// step, whose curve passes close to an earlier step it doesn't actually
// connect to). Same palette already used for per-step colour-coding
// elsewhere (see liveRecipe.js's STEP_COLORS).
const EDGE_COLORS = [
  "127,208,230", // cyan
  "240,201,135", // amber
  "226,147,196", // pink
  "154,211,159", // green
  "180,160,255", // violet
  "255,150,150", // coral
];

const ELBOW_GAP = 18; // how far a path travels straight out of a node before its first turn
const CORNER_RADIUS = 7; // rounds each turn instead of a sharp right angle

// Converts a sequence of [x, y] waypoints into an SVG path with each interior
// corner rounded — plain right-angle turns read as mechanical/cluttered once
// more than one or two are on screen at once (see the "look weird" report on
// the all-sharp-corners version), so every turn here is smoothed the way any
// ordinary flowchart tool rounds its orthogonal connectors. A corner whose
// two adjacent segments are too short for the full radius just uses whatever
// fits, and a zero-length segment (e.g. an edge that's already perfectly
// level with its target) is dropped instead of rounded, since there's no
// corner there to round.
function roundedPathD(points) {
  const pts = points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
  if (pts.length < 2) return "";
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const d1 = Math.hypot(x1 - x0, y1 - y0);
    const d2 = Math.hypot(x2 - x1, y2 - y1);
    const r = Math.min(CORNER_RADIUS, d1 / 2, d2 / 2);
    const p1 = [x1 - ((x1 - x0) / d1) * r, y1 - ((y1 - y0) / d1) * r];
    const p2 = [x1 + ((x2 - x1) / d2) * r, y1 + ((y2 - y1) / d2) * r];
    d += ` L${p1[0]},${p1[1]} Q${x1},${y1} ${p2[0]},${p2[1]}`;
  }
  const last = pts[pts.length - 1];
  d += ` L${last[0]},${last[1]}`;
  return d;
}

/**
 * Measures the already-rendered nodes and draws the connecting edges — each
 * a right-angled (orthogonal) path plus a small triangular arrowhead at the
 * target, so the diagram reads as a directed graph rather than just a set of
 * linked boxes. Call once, right after the graph's HTML has been inserted
 * into the live DOM (reading layout right after a mutation forces the
 * browser to compute it, so no rAF/resize wiring is needed).
 */
export function drawGraphConnectors(root, edges) {
  if (!root || !edges) return;
  const svg = root.querySelector(".recipe-graph__lines");
  if (!svg) return;

  // Wire up the scroll-fade affordance every render (cheap, and this is the
  // one place already guaranteed to run after the HTML is live in the DOM).
  // Re-reads scrollWidth on every scroll rather than once, since the graph's
  // own width never changes after render but this same listener has to keep
  // working across whatever the container's width happens to be. The
  // listener/measurement lives on the inner track (the element that actually
  // scrolls); the fade classes it toggles live on the outer, non-scrolling
  // element instead (see graphHtml/updateScrollShadows above).
  const scrollEl = root.closest("[data-graph-scroll]");
  const trackEl = root.closest("[data-graph-scroll-track]");
  if (trackEl && scrollEl && !trackEl.dataset.shadowsBound) {
    trackEl.dataset.shadowsBound = "true";
    trackEl.addEventListener("scroll", () => updateScrollShadows(scrollEl, trackEl));
    // A resize (window resized, sidebar toggled, panel split dragged) can
    // turn a graph that fit into one that doesn't, or vice versa — re-check
    // rather than leaving can-scroll-x stuck at whatever it was on render.
    window.addEventListener("resize", () => updateScrollShadows(scrollEl, trackEl));
  }
  if (trackEl && scrollEl) updateScrollShadows(scrollEl, trackEl);

  const rootRect = root.getBoundingClientRect();
  svg.setAttribute("width", root.scrollWidth);
  svg.setAttribute("height", root.scrollHeight);
  svg.innerHTML = "";

  // Assigned by first appearance among non-muted edges, so the same source
  // node always gets the same colour within one render, and two edges
  // sharing a source (e.g. two outputs of the same step) read as a pair.
  const colorByFrom = new Map();
  function colorFor(fromId) {
    if (!colorByFrom.has(fromId)) colorByFrom.set(fromId, EDGE_COLORS[colorByFrom.size % EDGE_COLORS.length]);
    return colorByFrom.get(fromId);
  }

  // Which column (left-to-right layer) each node actually landed in, and the
  // lowest edge of any node within each column — read straight from the
  // rendered columns rather than recomputed, so this can never disagree with
  // what's on screen.
  const nodeColumn = new Map();
  const columnBottom = new Map();
  [...root.querySelectorAll(".recipe-graph__col")].forEach((col, colIndex) => {
    const nodes = [...col.querySelectorAll("[data-node]")];
    nodes.forEach((n) => nodeColumn.set(n.getAttribute("data-node"), colIndex));
    if (nodes.length) {
      columnBottom.set(colIndex, Math.max(...nodes.map((n) => n.getBoundingClientRect().bottom)) - rootRect.top);
    }
  });
  const LANE_GAP = 12;
  const LANE_SPACING = 10;
  let laneCount = 0;

  edges.forEach((edge) => {
    const from = root.querySelector(`[data-node="${edge.from}"]`);
    const to = root.querySelector(`[data-node="${edge.to}"]`);
    if (!from || !to) return;
    const fr = from.getBoundingClientRect();
    const tr = to.getBoundingClientRect();
    const sx = fr.right - rootRect.left;
    const sy = fr.top + fr.height / 2 - rootRect.top;
    const tx = tr.left - rootRect.left;
    const ty = tr.top + tr.height / 2 - rootRect.top;
    // The path stops short of the node by the arrowhead's length — the
    // arrowhead's own apex is what actually touches the node — and because
    // its last segment is always horizontal into the target, a fixed
    // rightward-pointing triangle at that point is always correctly
    // oriented without computing a tangent.
    const lineEndX = tx - ARROW_LEN;
    const cls = edge.muted ? "is-muted" : "";
    // A muted edge keeps its own dashed/grey styling (that colour already
    // carries meaning — "not yet resolved"); only a live edge gets a
    // per-source colour, so the two kinds of colouring never fight.
    const rgb = edge.muted ? null : colorFor(edge.from);

    const colFrom = nodeColumn.get(edge.from);
    const colTo = nodeColumn.get(edge.to);
    const skipsAColumn = colFrom != null && colTo != null && colTo - colFrom >= 2;

    let points;
    if (skipsAColumn) {
      // Out of the source, down just far enough to clear whichever column(s)
      // this edge actually skips over — not the tallest column anywhere in
      // the graph, which is what made this dip look wildly exaggerated
      // whenever some unrelated column happened to stack several rows —
      // straight across, then up into the target. Each edge that uses this
      // gets its own height AND its own approach point into the target,
      // staggered by the same lane index — sharing only the final short run
      // into the arrowhead — so two edges heading to the same node fan in as
      // distinct lines instead of tracing directly on top of one another.
      let clearY = Math.max(sy, ty);
      for (let c = colFrom + 1; c <= colTo - 1; c++) {
        if (columnBottom.has(c)) clearY = Math.max(clearY, columnBottom.get(c));
      }
      const laneY = clearY + LANE_GAP + laneCount * LANE_SPACING;
      const turn1X = sx + ELBOW_GAP;
      const turn2X = lineEndX - ELBOW_GAP - laneCount * LANE_SPACING;
      laneCount++;
      points = [
        [sx, sy],
        [turn1X, sy],
        [turn1X, laneY],
        [turn2X, laneY],
        [turn2X, ty],
        [lineEndX, ty],
      ];
    } else if (sy === ty) {
      // Already level with the target (common for a single-row column) —
      // a plain straight line, not a fake elbow with two no-op turns.
      points = [
        [sx, sy],
        [lineEndX, ty],
      ];
    } else {
      // Adjacent columns: a single right-angled elbow, turning halfway
      // across the gap between them.
      const midX = (sx + lineEndX) / 2;
      points = [
        [sx, sy],
        [midX, sy],
        [midX, ty],
        [lineEndX, ty],
      ];
    }

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", roundedPathD(points));
    path.setAttribute("class", `recipe-graph__edge ${cls}`);
    if (rgb) path.setAttribute("style", `stroke: rgb(${rgb})`);
    svg.appendChild(path);

    const arrow = document.createElementNS("http://www.w3.org/2000/svg", "path");
    arrow.setAttribute(
      "d",
      `M${lineEndX},${ty - ARROW_HALF_WIDTH} L${tx},${ty} L${lineEndX},${ty + ARROW_HALF_WIDTH} Z`
    );
    arrow.setAttribute("class", `recipe-graph__arrow ${cls}`);
    if (rgb) arrow.setAttribute("style", `fill: rgb(${rgb})`);
    svg.appendChild(arrow);
  });
}
