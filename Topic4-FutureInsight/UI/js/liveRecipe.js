// UI logic for the Geonovum Testbed's recipes — the ones registered in the
// nLDT Sandbox Stack backend (see ../DECISIONS.md and ../../services/).
// js/data.js flags every recipe `is_live: true` as it maps it in from the
// OGC API Records Wrapper catalogue.
//
// This module holds the recipe graph (renderGraph), the Status tab
// (renderStatusTab: execute, follow the cook job, save the result) and the
// Orchestrator editor (renderOrchestratorEditTab: CWL text, diagram and
// guided builder). The Wizard (views/recipeWizard.js) reuses its graph and
// builds its Data Ingredients step from the DAG's data inputs (CWL `type:
// File` inputs, see data.js::ingredientsFromDag). Executing a recipe always
// means running it through the Cook Orchestrator.
import { drawGraphConnectors, graphHtml } from "./recipeGraph.js";
import { icons } from "./icons.js";
import * as sandboxApi from "./sandboxApi.js";
import { showToast } from "./state.js";
import { executionPatternHelpHtml, initHelpTips } from "./executionPatterns.js";
import {
  TOOL_CATALOG,
  findTool,
  toolProcessUrl,
  toolProcessLink,
  externalProcessLink,
  processDescriptionToTool,
} from "./toolCatalog.js";
import {
  getLiveParameters,
  getLiveToolOverrides,
  getLiveIngredients,
  loadProcessHints,
  effectiveParamProps,
  groupParamsByApp,
  appGroupHeadHtml,
  paramHeadHtml,
  stepAppName,
  stepSublabel,
} from "./views/recipeWizard.js";
import { cwlFile, mediaTypeLabel, formatToMediaType, mediaTypeToFormat, DATA_MEDIA_TYPE_OPTIONS } from "./dataFormats.js";

// The dataset every successful run's result is saved
// into — see services/hub-datasets, which seeds this dataset for exactly
// this purpose (UI/data/datasets.json holds a fallback stub with the same
// id/title for when hub-datasets isn't reachable).
const SANDBOX_RESULTS_DATASET_ID = "ds-sandbox-results";
// The hub that owns SANDBOX_RESULTS_DATASET_ID (see data.js's
// liveRecipeToViewShape::fixed_output_destination) — the "Go to Dataset"
// link below always lands here, since a live recipe's result is never saved
// anywhere else.
const SANDBOX_RESULTS_HUB_ID = "nldt-sandbox-hub";

const GEOJSON_TYPES = new Set([
  "Feature",
  "FeatureCollection",
  "Point",
  "LineString",
  "Polygon",
  "MultiPoint",
  "MultiLineString",
  "MultiPolygon",
  "GeometryCollection",
]);

function isGeoJsonLike(value) {
  return !!value && typeof value === "object" && GEOJSON_TYPES.has(value.type);
}

const VALIDATE_CWL_HELP =
  "Checks that this is well-formed CWL v1.2 in the subset the Cook Orchestrator supports: " +
  "a Workflow with mapping-form steps, each running an inline Operation, resolvable to a " +
  "cycle-free execution order — and derives its parameter schema and step sequence from that. " +
  "It does NOT check that the tool services referenced by process id actually exist or that " +
  "running it would succeed — only that the document itself is valid and routable.";

const RESET_CWL_HELP =
  "Discards whatever is in the editor and loads the recipe's bundled, factory-original CWL " +
  "definition — not just what's currently saved (which could itself be a broken edit). This " +
  "only replaces the text in the editor: it still needs Validate and Save to actually take " +
  "effect. Only recipes shipped with a bundled definition have one to reset to.";

const BUILDING_BLOCKS_HELP =
  "Build the recipe without hand-writing CWL, in four steps. 1. Recipe details: the parts the " +
  "CWL standard requires (cwlVersion, class, the inputs/outputs/steps sections) plus the " +
  "recipe's name, identifier and description. 2. Add a step: append a call to " +
  "a tool (from the catalog, or any OGC API Process by URL), with its inputs and outputs " +
  "already declared; click it in the diagram to also allow alternative tools a hub may swap in " +
  "for it. 3. Connect a step: wire each of a step's inputs to a workflow input (a " +
  "parameter filled in when the recipe runs) or to another step's output. 4. Finalize the " +
  "process: choose which step output(s) are the recipe's result, review what's still " +
  "unconnected, and validate. Each one edits the CWL text below — you can still edit it by hand.";

/** Adapts the Cook Orchestrator's execution-DAG shape (see
 * cookbook-registry/app/cwl_parser.py::extract_dag) into the {nodes, edges}
 * shape recipeGraph.js already knows how to render. `trace` (once a run has
 * happened) marks completed steps as resolved. */
function dagToGraph(dag, trace) {
  const done = new Set((trace || []).map((t) => t.step));
  const nodes = [];
  const edges = [];

  dag.workflow_inputs.forEach((name) => nodes.push({ id: `in:${name}`, kind: "input", label: name }));

  dag.steps.forEach((step) => {
    // Named the same way as everywhere else (see recipeWizard.js's
    // stepAppName): the app that runs the step, with the step's own name
    // beside it.
    nodes.push({
      id: `step:${step.id}`,
      kind: "tool",
      label: escapeHtml(stepAppName({}, step)),
      sublabel: escapeHtml(stepSublabel({}, step)),
      status: done.has(step.id) ? "resolved" : "default",
    });
    Object.values(step.inputs).forEach((ref) => {
      edges.push({
        from: ref.source_type === "workflow_input" ? `in:${ref.name}` : `step:${ref.step}`,
        to: `step:${step.id}`,
      });
    });
  });

  dag.workflow_outputs.forEach((out) => {
    nodes.push({ id: `out:${out.id}`, kind: "output", label: out.id, status: done.size ? "resolved" : "default" });
    edges.push({
      from: out.source_type === "workflow_input" ? `in:${out.name}` : `step:${out.step}`,
      to: `out:${out.id}`,
    });
  });

  return { nodes, edges };
}

export function renderGraph(el, dag, trace, options = {}) {
  const graph = dagToGraph(dag, trace);
  el.innerHTML = graphHtml(graph, {
    title: options.title || "",
    hint: options.hint || "Computed live from the recipe's CWL document — not a static illustration.",
  });
  drawGraphConnectors(el.querySelector("[data-graph-root]"), graph.edges);
}

function escapeHtml(text) {
  // Quotes too — this also fills attribute values (value="…", data-*="…").
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Colours a single already-comment-stripped YAML scalar: quoted strings,
 * numbers, and true/false/null literals — the same token classes the static
 * recipe-document JSON viewer uses (see views/editRecipe.js), so both look
 * like one consistent system. */
function highlightYamlScalar(raw) {
  // Text-only escaping (quotes left as-is): the regex below finds quoted
  // strings in the escaped text, so escapeHtml's &quot; would hide them.
  const text = String(raw).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text.replace(
    // A number only when it stands on its own — not the "-3" of
    // "playground-3" or the "1.2" of "v1.2".
    /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\btrue\b|\bfalse\b|\bnull\b|(?<![\w.-])-?\d+(?:\.\d+)?(?![\w.-]))/g,
    (match) => {
      let cls = "jv-num";
      if (/^["']/.test(match)) cls = "jv-str";
      else if (/^(true|false|null)$/.test(match)) cls = "jv-bool";
      return `<span class="${cls}">${match}</span>`;
    }
  );
}

/** Colours one line of YAML: a trailing `# comment` (naive — doesn't account
 * for '#' inside quoted strings, fine for CWL's plain-scalar style), then a
 * leading `key:` (list-dash prefix included) if the line has one, then the
 * remaining scalar via highlightYamlScalar. */
function highlightYamlLine(line) {
  const commentMatch = line.match(/(^|\s)#.*/);
  const commentStart = commentMatch ? commentMatch.index + commentMatch[1].length : -1;
  const code = commentStart === -1 ? line : line.slice(0, commentStart);
  const comment = commentStart === -1 ? "" : line.slice(commentStart);

  const keyMatch = code.match(
    /^(\s*(?:-\s+)+|\s*)([A-Za-z0-9_.\-]+|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')(:)(?=\s|$)/
  );

  let html;
  if (keyMatch) {
    const [full, prefix, key, colon] = keyMatch;
    html =
      escapeHtml(prefix) +
      `<span class="jk">${escapeHtml(key)}</span>` +
      escapeHtml(colon) +
      highlightYamlScalar(code.slice(full.length));
  } else {
    html = highlightYamlScalar(code);
  }

  return comment ? html + `<span class="jv-comment">${escapeHtml(comment)}</span>` : html;
}

function highlightYaml(text) {
  return text.split("\n").map(highlightYamlLine).join("\n");
}

/** The actual fix for a real, reported bug: a `<textarea>` whose value ends
 * in a trailing newline renders one extra (empty) row — reserved for the
 * cursor to land on after the last character — that a plain `<pre>` does
 * NOT allocate height for on its own, since a wholly empty final line has no
 * content to force a line box. Left alone, this makes the highlight
 * overlay's scrollHeight fall exactly one line short of the textarea's
 * (confirmed directly in-browser: 1241px vs 1260px, a 19px/one-line gap) —
 * so once the document is tall enough to scroll, the two drift out of
 * vertical sync, and a click that visually lands on one line can place the
 * real (invisible) textarea's cursor on the line below or above it. A
 * trailing non-breaking space forces the browser to allocate that phantom
 * row's height too, keeping the two elements' scrollHeight identical. */
function highlightHtml(text) {
  const html = highlightYaml(text);
  return text.endsWith("\n") ? `${html}&nbsp;` : html;
}

// One solid colour per nesting depth, cycled if the document nests deeper
// than the palette — matches the VS Code "indent-rainbow"-style look asked
// for: solid translucent bands, not thin dashed lines.
//
// Deliberately a DIFFERENT set of RGB triples than STEP_COLORS below, not
// just a reordering of the same six — an earlier bug had this palette using
// the exact same colours as STEP_COLORS (just two entries swapped), so
// whenever a step's index and a nesting depth landed on the same palette
// slot, that depth's guide blended into the step-frame-box's own tint. A
// genuinely different hue rotation means the two can never cancel each
// other out that way, at any step/depth combination.
//
// Back to a subtle .16 alpha (it was bumped to .4 while chasing what turned
// out to be an unrelated bug — some bands were silently missing entirely,
// see computeIndentGuideBands' end-of-file fix — not actually an opacity
// problem) so these read as a faint wash, not a solid highlight.
const INDENT_GUIDE_COLORS = [
  "rgba(255,121,121,.16)", // red
  "rgba(255,179,102,.16)", // orange
  "rgba(230,214,122,.16)", // yellow
  "rgba(129,199,132,.16)", // green
  "rgba(100,181,246,.16)", // blue
  "rgba(179,136,255,.16)", // purple
];

/** Computes, for each 2-space YAML indent depth present in the document, the
 * contiguous line ranges where a block nested at least that deep is actually
 * active — e.g. depth 0's band covers every run of indented lines; depth 1's
 * only the runs indented two levels or more; and so on. This is the same
 * logic real editors' indent guides use: a guide at a given depth only
 * exists where that depth is actually active, not for the whole document
 * regardless of content (which is what a single repeating background would
 * have drawn). A blank line doesn't end a run — it has no indent of its own,
 * but visually sits inside whatever block surrounds it. */
function computeIndentGuideBands(text) {
  const lines = text.split("\n");
  const levelOf = lines.map((line) => (line.trim() === "" ? null : Math.floor(line.match(/^ */)[0].length / 2)));
  const maxLevel = levelOf.reduce((m, l) => (l !== null ? Math.max(m, l) : m), 0);

  const bands = [];
  for (let level = 0; level < maxLevel; level++) {
    let runStart = null;
    for (let i = 0; i <= lines.length; i++) {
      // i === lines.length is a sentinel one-past-the-end pass whose only
      // job is to force-close a run that's still open at true end-of-file —
      // it must NEVER be treated as "just another blank line" (lvl === null
      // mid-document continues whatever run was already active). Otherwise
      // a run still open at the end of the document (e.g. depth 0 from the
      // first step key onward) would never be closed, and would silently be
      // left out of `bands`.
      const isEnd = i === lines.length;
      const lvl = isEnd ? null : levelOf[i];
      const active = isEnd ? false : lvl === null ? runStart !== null : lvl > level;
      if (active && runStart === null) runStart = i;
      if (!active && runStart !== null) {
        bands.push({ level, startLine: runStart, endLine: i - 1 });
        runStart = null;
      }
    }
  }
  return bands;
}

/** Renders the indent-guide bands as real, absolutely-positioned elements
 * (not a CSS background-image) — the actual fix for a real reported bug:
 * a background-image's position doesn't scroll with its own element's
 * overflow by default, so the guides visually stayed fixed while the text
 * scrolled past them, looking like two decoupled layers. These bands are
 * positioned the same way the step-frame boxes already are (pixel `top`
 * from lineTop(), repositioned on every scroll — see repositionIndentGuides)
 * so they scroll in perfect lockstep with the real text, always. */
function renderIndentGuides(guidesEl, textarea) {
  const bands = computeIndentGuideBands(textarea.value);
  guidesEl.innerHTML = "";
  bands.forEach((band) => {
    const el = document.createElement("div");
    el.className = "indent-guide-band";
    el.dataset.startLine = String(band.startLine);
    el.style.top = `${lineTop(band.startLine, textarea.scrollTop)}px`;
    el.style.height = `${(band.endLine - band.startLine + 1) * LINE_HEIGHT}px`;
    el.style.left = `calc(${TEXT_LEFT}px + ${band.level * 2}ch)`;
    el.style.width = "2ch";
    el.style.transform = `translateX(${-textarea.scrollLeft}px)`;
    el.style.background = INDENT_GUIDE_COLORS[band.level % INDENT_GUIDE_COLORS.length];
    guidesEl.appendChild(el);
  });
}

/** Cheap scroll-linked reposition, mirroring repositionStepBoxes — moves
 * every band's `top` without rebuilding any of them. */
function repositionIndentGuides(guidesEl, textarea) {
  for (const el of guidesEl.children) {
    el.style.top = `${lineTop(Number(el.dataset.startLine), textarea.scrollTop)}px`;
    el.style.transform = `translateX(${-textarea.scrollLeft}px)`;
  }
}

/** VS Code-style line numbers down the gutter — plain text in normal flow
 * (not per-line positioned elements like the indent guides/tool frames),
 * since matching line-height/padding-top against the same monospace font
 * already keeps every number lined up with its row; only the gutter's own
 * scrollTop needs to track the textarea's (see the "scroll" listener in
 * renderOrchestratorEditTab). Rebuilt on every edit, same as the highlight
 * overlay, so the count always matches the document's actual line count. */
function renderGutter(gutterEl, textarea) {
  const lineCount = textarea.value.split("\n").length;
  let numbers = "";
  for (let i = 1; i <= lineCount; i++) numbers += (i > 1 ? "\n" : "") + i;
  gutterEl.textContent = numbers;
}

/** A step's own indent, its child `run:`/`in:`/`out:` line ranges, and the
 * tool id its `run:` block currently declares. Line indices are into the
 * plain `text.split("\n")` array so callers can splice replacements in
 * directly, and so a step's `run.id` line can be pinpointed for anchoring its
 * tool-preview frame. Deliberately just line/indent scanning — CWL's steps
 * are always this shape here (2-space indent, mapping-form steps, an inline
 * Operation under `run:`; see cwl_parser.py::extract_dag) — not a general
 * YAML parser. */
function parseCwlSteps(text) {
  const lines = codeLines(text);
  const indentOf = (line) => line.match(/^ */)[0].length;
  // Finds where a block of deeper-indented children ends, starting the scan
  // at `from` (the line right after the block's own header line).
  const blockEnd = (from, headerIndent) => {
    let k = from;
    while (k < lines.length) {
      const l = lines[k];
      if (l.trim() !== "" && indentOf(l) <= headerIndent) break;
      k++;
    }
    return k;
  };

  let stepsIdx = -1;
  let stepsIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)steps:\s*$/);
    if (m) {
      stepsIdx = i;
      stepsIndent = m[1].length;
      break;
    }
  }
  if (stepsIdx === -1) return [];

  const steps = [];
  const stepsBodyEnd = blockEnd(stepsIdx + 1, stepsIndent);
  let i = stepsIdx + 1;
  while (i < stepsBodyEnd) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    const indent = indentOf(line);
    const nameMatch = line.match(/^(\s*)([A-Za-z0-9_-]+):\s*$/);
    if (indent === stepsIndent + 2 && nameMatch) {
      const end = blockEnd(i + 1, indent);
      // A step ends at its last real CWL line: trailing blank and
      // comment-only lines (blank in `lines`, see codeLines) belong to
      // whatever follows — e.g. a closing comment block after the last step.
      let stepEnd = end;
      while (stepEnd > i + 1 && lines[stepEnd - 1].trim() === "") stepEnd--;
      steps.push(parseStepBlock(lines, nameMatch[2], i, stepEnd, indent));
      i = end;
    } else {
      i++;
    }
  }
  return steps;
}

function parseStepBlock(lines, name, start, end, stepIndent) {
  const indentOf = (line) => line.match(/^ */)[0].length;
  const blockEnd = (from, headerIndent) => {
    let k = from;
    while (k < end) {
      const l = lines[k];
      if (l.trim() !== "" && indentOf(l) <= headerIndent) break;
      k++;
    }
    return k;
  };

  const childIndent = stepIndent + 2;
  const step = {
    name,
    stepIndent,
    start,
    end,
    runStart: -1,
    runEnd: -1,
    idLineIndex: -1,
    idValue: null,
    // The run block's own `label:` — the only name there is for a tool the
    // catalog doesn't know (an external process, or a mockup recipe's app).
    runLabel: null,
    inStart: -1,
    inEnd: -1,
    outLineIndex: -1,
    // What the building-block modals (Connect / Finalize, see
    // openConnectStepModal/openFinalizeModal) offer as choices: the tool's
    // declared `run.inputs`/`run.outputs` ({name, type}), the step's current
    // `in:` wiring ({name, value, lineIndex, ...}) and its `out:` names. An
    // entry in CWL's long form (`name:` then `source:` / `valueFrom:` lines)
    // gets value = its source, plus valueFrom, sourceLineIndex and entryEnd.
    runInputs: [],
    runOutputs: [],
    inEntries: [],
    outNames: [],
  };

  for (let k = start + 1; k < end; k++) {
    const l = lines[k];
    if (l.trim() === "" || indentOf(l) !== childIndent) continue;
    const trimmed = l.trim();
    if (trimmed === "run:") {
      step.runStart = k;
      step.runEnd = blockEnd(k + 1, childIndent);
    } else if (/^in:(\s|$)/.test(trimmed)) {
      // Also the empty flow form `in: {}` (written by insertNewStep for a
      // tool with no inputs) — its block simply ends on its own line.
      step.inStart = k;
      step.inEnd = blockEnd(k + 1, childIndent);
    } else if (/^out:/.test(trimmed)) {
      step.outLineIndex = k;
      const m = trimmed.match(/^out:\s*\[(.*)\]/);
      if (m) step.outNames = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    }
  }

  if (step.runStart !== -1) {
    const runChildIndent = childIndent + 2;
    for (let k = step.runStart + 1; k < step.runEnd; k++) {
      const l = lines[k];
      if (l.trim() === "" || indentOf(l) !== runChildIndent) continue;
      const trimmed = l.trim();
      const m = trimmed.match(/^id:\s*(.+)$/);
      const labelMatch = trimmed.match(/^label:\s*(.+)$/);
      if (m && step.idLineIndex === -1) {
        step.idLineIndex = k;
        step.idValue = m[1].trim().replace(/^["']|["']$/g, "");
      } else if (labelMatch && step.runLabel === null) {
        step.runLabel = unquoteYaml(stripYamlComment(labelMatch[1]));
      } else if (/^(inputs|outputs):\s*$/.test(trimmed)) {
        const target = trimmed.startsWith("inputs") ? step.runInputs : step.runOutputs;
        target.push(...parseTypedEntries(lines, k + 1, blockEnd(k + 1, runChildIndent), runChildIndent + 2));
      }
    }
  }

  if (step.inStart !== -1) {
    const entryIndent = childIndent + 2;
    for (let k = step.inStart + 1; k < step.inEnd; k++) {
      const l = lines[k];
      if (l.trim() === "" || indentOf(l) !== entryIndent) continue;
      const m = l.trim().match(/^([\w.-]+):\s*(.*)$/);
      if (!m) continue;
      const entry = { name: m[1], value: stripYamlComment(m[2]), lineIndex: k, entryEnd: k + 1, valueFrom: null, sourceLineIndex: -1 };
      if (!entry.value) {
        // Long form: the entry's own keys, one level deeper.
        let j = k + 1;
        for (; j < step.inEnd && (lines[j].trim() === "" || indentOf(lines[j]) > entryIndent); j++) {
          const t = stripLineComment(lines[j]).trim();
          const src = t.match(/^source:\s*(.+)$/);
          const vf = t.match(/^valueFrom:\s*(.+)$/);
          if (src && entry.sourceLineIndex === -1) {
            entry.value = src[1].trim();
            entry.sourceLineIndex = j;
          } else if (vf && entry.valueFrom === null) {
            entry.valueFrom = unquoteYaml(vf[1].trim());
          }
        }
        while (j > k + 1 && lines[j - 1].trim() === "") j--;
        entry.entryEnd = j;
      }
      step.inEntries.push(entry);
    }
  }

  return step;
}

/** One line with any `# comment` (outside quotes) and trailing whitespace
 * removed, indentation kept — a whole-line comment becomes blank. */
function stripLineComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).replace(/\s+$/, "");
    }
  }
  return line.replace(/\s+$/, "");
}

/** Splits one line into its code and its trailing `# comment` (outside
 * quotes): {code, comment} — `code` keeps its indent, has no trailing
 * whitespace; `comment` starts at the `#` ("" when there is none). */
function splitLineComment(line) {
  const code = stripLineComment(line);
  const rest = line.slice(code.length);
  const hash = rest.indexOf("#");
  return { code, comment: hash === -1 ? "" : rest.slice(hash) };
}

// Columns between the end of a step box's longest code line and the start of
// the comments re-aligned past it (see alignStepComments) — the box's own
// right padding (BOX_TEXT_PAD) sits inside this gap.
const COMMENT_GAP_COLS = 3;

/** Re-aligns every trailing comment inside a step (on a line that also has
 * code) to start just past the step boxes' right edge — the boxes are as
 * wide as the steps' longest code line (see layoutEditor), so the comments
 * line up in one column outside them instead of running through the
 * boundary. Only the whitespace before each `#` changes, which YAML ignores.
 * Lines inside a block scalar (`doc: >` / `|`), where `#` is literal text,
 * are left alone. */
function alignStepComments(text) {
  const lines = text.split("\n");
  const steps = parseCwlSteps(text);
  if (!steps.length) return text;
  const { codeRows, width } = stepCodeLayout(lines, steps);
  const column = width + COMMENT_GAP_COLS;

  let changed = false;
  codeRows.forEach((k) => {
    const { code, comment } = splitLineComment(lines[k]);
    if (!comment) return;
    const aligned = code + " ".repeat(Math.max(2, column - code.length)) + comment;
    if (aligned !== lines[k]) {
      lines[k] = aligned;
      changed = true;
    }
  });
  return changed ? lines.join("\n") : text;
}

/** The steps' code footprint: `codeRows` — the step lines that are real code
 * (block-scalar content, where `#` is literal text, excluded) — and `width`,
 * the widest of them in columns, comments not counted (block-scalar text
 * counted in full). The step boxes are drawn exactly this wide (layoutEditor)
 * and alignStepComments starts trailing comments just past it. */
function stepCodeLayout(lines, steps) {
  const indentOf = (l) => l.match(/^ */)[0].length;
  const codeRows = [];
  let width = 0;
  steps.forEach((s) => {
    let scalarIndent = -1;
    for (let k = s.start; k < s.end && k < lines.length; k++) {
      if (scalarIndent !== -1) {
        if (lines[k].trim() === "" || indentOf(lines[k]) > scalarIndent) {
          width = Math.max(width, lines[k].replace(/\s+$/, "").length);
          continue;
        }
        scalarIndent = -1;
      }
      const { code } = splitLineComment(lines[k]);
      if (/:\s*[>|][+-]?$/.test(code)) scalarIndent = indentOf(lines[k]);
      if (code.trim()) {
        codeRows.push(k);
        width = Math.max(width, code.length);
      }
    }
  });
  return { codeRows, width };
}

/** `text`'s lines with comments stripped (see stripLineComment) — what every
 * line-based parser here matches against, so a hand-annotated recipe like
 * `add:   # this step's id` parses the same as a bare `add:`. Same line
 * count/indices as text.split("\n"), so results still index the real text. */
function codeLines(text) {
  return text.split("\n").map(stripLineComment);
}

/** A YAML scalar with any trailing `# comment` removed (but not a `#` inside
 * quotes, e.g. a URL fragment). */
function stripYamlComment(value) {
  let quote = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(value[i - 1]))) {
      return value.slice(0, i).trim();
    }
  }
  return value.trim();
}

/** The `name: { type: X }` (flow form) or `name:` + nested `type: X` (block
 * form) entries of an inputs/outputs mapping, between lines `from` and `to`,
 * whose keys sit at exactly `entryIndent`. Missing types read as "Any".
 * `format` (a data input's media type, e.g. `iana:application/geo+json`) is
 * null when not declared. */
function parseTypedEntries(lines, from, to, entryIndent) {
  const indentOf = (line) => line.match(/^ */)[0].length;
  const entries = [];
  for (let k = from; k < to; k++) {
    const l = lines[k];
    if (l.trim() === "" || l.trim().startsWith("#") || indentOf(l) !== entryIndent) continue;
    const m = l.trim().match(/^([\w.-]+):\s*(.*)$/);
    if (!m) continue;
    let type = null;
    let label = null;
    let format = null;
    const flow = m[2].match(/(?:^|[{,\s])type:\s*"?([^",}\s]+)"?/);
    if (flow) {
      type = flow[1];
      const flowLabel = m[2].match(/label:\s*"([^"]*)"/);
      if (flowLabel) label = flowLabel[1];
      const flowFormat = m[2].match(/format:\s*"?([^",}\s]+)"?/);
      if (flowFormat) format = flowFormat[1];
    } else if (!stripYamlComment(m[2])) {
      let childIndent = null;
      for (let j = k + 1; j < to && (lines[j].trim() === "" || indentOf(lines[j]) > entryIndent); j++) {
        // Only the entry's own keys (one level in) — not keys nested deeper,
        // e.g. inside an `nldt:jsonSchema:` block.
        if (lines[j].trim() === "" || lines[j].trim().startsWith("#")) continue;
        if (childIndent === null) childIndent = indentOf(lines[j]);
        if (indentOf(lines[j]) !== childIndent) continue;
        const t = lines[j].trim().match(/^type:\s*"?([^"\s#]+)"?/);
        if (t && !type) type = t[1].startsWith("{") ? flowMappingType(lines[j].trim()) : t[1];
        if (!t && !type && /^type:\s*$/.test(stripLineComment(lines[j]).trim())) {
          // Block form (`type:` then `type: array` / `items:` lines below it).
          const nested = [];
          for (let q = j + 1; q < to && (lines[q].trim() === "" || indentOf(lines[q]) > childIndent); q++) nested.push(lines[q].trim());
          type = flowMappingType(nested.join(" "));
        }
        const lab = lines[j].trim().match(/^label:\s*(.+)$/);
        if (lab && label === null) label = stripYamlComment(lab[1]).replace(/^["']|["']$/g, "");
        const fmt = lines[j].trim().match(/^format:\s*"?([^"\s#]+)"?/);
        if (fmt && format === null) format = fmt[1];
      }
    }
    entries.push({ name: m[1], type: type || "Any", label, format });
  }
  return entries;
}

/** The document's top-level `inputs:`/`outputs:` blocks — their line ranges
 * (header line through the end of its children; -1 when absent) and declared
 * entries — the workflow-level counterpart to parseCwlSteps. */
function parseCwlTopLevel(text) {
  const lines = codeLines(text);
  const result = { inputs: [], outputs: [], inputsStart: -1, inputsEnd: -1, outputsStart: -1, outputsEnd: -1 };
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(inputs|outputs):(.*)$/);
    if (!m) continue;
    let end = i + 1;
    while (end < lines.length && (lines[end].trim() === "" || /^\s/.test(lines[end]))) end++;
    // Trailing blank lines belong to whatever follows, not to this block.
    while (end > i + 1 && lines[end - 1].trim() === "") end--;
    result[`${m[1]}Start`] = i;
    result[`${m[1]}End`] = end;
    result[m[1]] = parseTypedEntries(lines, i + 1, end, 2);
    if (m[1] === "outputs") {
      // Each output's own outputSource, so Finalize can pre-tick what's
      // already the recipe's result.
      result.outputs.forEach((o) => {
        const header = lines.findIndex((l, k) => k > i && k < end && new RegExp(`^  ${o.name}:`).test(l));
        for (let k = header; k !== -1 && k < end; k++) {
          const src = lines[k].match(/outputSource:\s*"?([^"\s,}#]+)"?/);
          if (src) {
            o.outputSource = src[1];
            break;
          }
          if (k > header && /^ {0,2}\S/.test(lines[k])) break;
        }
      });
    }
  }
  return result;
}

/** Regenerates a step's `run:` block (class/id/label/doc/inputs/outputs),
 * its `in:` mapping (remapped to the new tool's input names, best-effort
 * carrying over the old wiring by position), and its `out:` list (the new
 * tool's output names) — then splices all three into `textarea`'s CWL text
 * in place, bottom-to-top so earlier line ranges stay valid, and dispatches
 * an `input` event so the highlight/frames/validation-gate all pick it up.
 *
 * `tool` is either a TOOL_CATALOG entry or a synthesized {id, inputs: [],
 * outputs: []} for a freeform id the catalog doesn't know — in that case the
 * generated block is a stub the author still has to fill in by hand; this
 * only saves them the CWL boilerplate and keeps the document well-formed. */
export function applyToolToStep(textarea, stepName, tool) {
  const lines = textarea.value.split("\n");
  const steps = parseCwlSteps(textarea.value);
  const step = steps.find((s) => s.name === stepName);
  if (!step) return;

  if (step.outLineIndex !== -1) {
    const ind = lines[step.outLineIndex].match(/^\s*/)[0];
    const names = (tool.outputs || []).map((o) => o.name);
    lines.splice(step.outLineIndex, 1, `${ind}out: [${names.join(", ")}]`);
  }

  if (step.inStart !== -1) {
    const inIndent = lines[step.inStart].match(/^\s*/)[0];
    const childIndent = `${inIndent}  `;
    const existingValues = [];
    for (let k = step.inStart + 1; k < step.inEnd; k++) {
      const l = lines[k];
      if (!l.trim()) continue;
      const m = l.trim().match(/^[\w.-]+:\s*(.+)$/);
      if (m) existingValues.push(m[1].trim());
    }
    const newLines = [`${inIndent}in:`];
    (tool.inputs || []).forEach((inp, idx) => {
      const known = existingValues[idx] !== undefined;
      newLines.push(`${childIndent}${inp.name}: ${known ? existingValues[idx] : UNCONNECTED_VALUE}`);
    });
    lines.splice(step.inStart, step.inEnd - step.inStart, ...newLines);
  }

  if (step.runStart !== -1) {
    const runIndent = lines[step.runStart].match(/^\s*/)[0];
    lines.splice(step.runStart, step.runEnd - step.runStart, ...buildRunBlockLines(tool, runIndent));
  }

  textarea.value = ensureNamespaces(lines.join("\n"));
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

// Plain-language comments written into generated CWL, so the two lookalike
// lists a step carries aren't a puzzle to someone reading the text: `run:`'s
// `inputs:` is what the tool *accepts* (copied from its process
// description), `in:` is where each of those gets its *value* from.
const RUN_INPUTS_COMMENT = "# What this tool accepts (from its process description) - no need to edit:";
const IN_BLOCK_COMMENT = "# Where each of those inputs gets its value: a recipe input's name, or another step's output as step/output.";
const UNCONNECTED_VALUE = '""  # not connected yet - use the Guided builder or "Connect a step"';

/** A tool's own `nldt:processLink` — the catalog's static internal-address
 * mapping (toolProcessLink) for a cataloged tool, or the pasted address
 * itself (externalProcessLink) for one fetched live from an external OGC
 * API Process (see processDescriptionToTool, ./toolCatalog.js). */
function toolLink(tool) {
  return tool.processUrl ? externalProcessLink(tool.processUrl) : toolProcessLink(tool.id);
}

/** A CWL type string (e.g. "float", but also "string?" or "string[]" — see
 * toolCatalog.js's jsonSchemaToCwlType) as a value safe to write inside a
 * flow mapping (`{ type: ... }`). A bare identifier like "float" is fine
 * unquoted, matching every hand-authored recipe's own style; anything with a
 * `?`/`[`/`]` — YAML flow-indicator characters — MUST be quoted, or the
 * document fails to parse as YAML at all (caught the hard way: an unquoted
 * `{ type: string? }` throws "expected ',' or '}', but got '?'"). */
function cwlFlowType(type) {
  return /^[A-Za-z][A-Za-z0-9]*$/.test(type) ? type : `"${type}"`;
}

/** Builds a step's `run:` block — `class: Operation`, `id`, `label`, `doc`,
 * `nldt:processLink`, `inputs:`, `outputs:` — as an array of CWL text lines,
 * starting with the `run:` header line itself at `runIndent`. Shared by
 * applyToolToStep (replacing an existing step's `run:`) and insertNewStep
 * (writing a brand-new one), so both ways of pointing a step at a tool —
 * picking one from the catalog, or pasting an external process's URL —
 * produce byte-identical CWL shape. */
function buildRunBlockLines(tool, runIndent) {
  const childIndent = `${runIndent}  `;
  const ioIndent = `${childIndent}  `;
  const newLines = [`${runIndent}run:`, `${childIndent}class: Operation`, `${childIndent}id: ${tool.id}`];
  if (tool.label) newLines.push(`${childIndent}label: "${tool.label}"`);
  newLines.push(`${childIndent}doc: "Calls the '${tool.id}' OGC API Process."`);
  const link = toolLink(tool);
  if (link) {
    const linkIndent = `${childIndent}  `;
    newLines.push(
      `${childIndent}${EXT_PROCESS_LINK}:`,
      `${linkIndent}rel: process`,
      `${linkIndent}type: application/json`,
      `${linkIndent}href: "${link.href}"`,
      `${linkIndent}internalHref: "${link.internalHref}"`
    );
  }
  if (tool.inputs && tool.inputs.length) {
    newLines.push(`${childIndent}${RUN_INPUTS_COMMENT}`, `${childIndent}inputs:`);
    tool.inputs.forEach((inp) =>
      newLines.push(`${ioIndent}${inp.name}: { type: ${cwlFlowType(inp.type)}${inp.format ? `, format: "${inp.format}"` : ""} }`)
    );
  } else {
    newLines.push(`${childIndent}inputs: {}  # TODO: declare this tool's inputs`);
  }
  if (tool.outputs && tool.outputs.length) {
    newLines.push(`${childIndent}outputs:`);
    tool.outputs.forEach((out) => newLines.push(`${ioIndent}${out.name}: { type: ${cwlFlowType(out.type)} }`));
  } else {
    newLines.push(`${childIndent}outputs: {}  # TODO: declare this tool's outputs`);
  }
  return newLines;
}

/** Appends a brand-new step to the document's `steps:` block for a tool
 * fetched live from a pasted OGC API Process URL (see
 * processDescriptionToTool, ./toolCatalog.js) — the "insert" counterpart to
 * applyToolToStep's "replace an existing step". Picks a fresh step name from
 * the tool's id (deduped against the steps already in the document), wires
 * its `in:` as TODO placeholders (there's no previous step's wiring to carry
 * over the way applyToolToStep does for an existing step — the author still
 * has to connect it to a workflow input or another step's output by hand),
 * and splices the new step in the same "mutate textarea.value, dispatch
 * input" way as applyToolToStep, so the editor's existing highlight/gutter/
 * step boxes and diagram wiring (see renderOrchestratorEditTab) picks it up for free. */
export function insertNewStep(textarea, tool, { name: requestedName } = {}) {
  // An empty `steps: {}` (see addMissingRequiredParts) opens up into a block.
  textarea.value = textarea.value.replace(/^steps:[ \t]*\{[ \t]*\}[ \t]*$/m, "steps:");
  const lines = textarea.value.split("\n");
  const name = requestedName || suggestStepName(textarea.value, tool);

  // Found on comment-stripped lines, so `steps:   # …` still counts.
  const code = codeLines(textarea.value);
  const stepsHeader = code.find((l) => /^[ \t]*steps:$/.test(l));
  const stepsIndent = stepsHeader ? stepsHeader.match(/^[ \t]*/)[0].length : 0;
  const stepIndent = " ".repeat(stepsIndent + 2);
  const childIndent = `${stepIndent}  `;

  const newLines = [`${stepIndent}${name}:`, ...buildRunBlockLines(tool, childIndent)];
  if (tool.inputs && tool.inputs.length) {
    newLines.push(`${childIndent}${IN_BLOCK_COMMENT}`, `${childIndent}in:`);
    tool.inputs.forEach((inp) => newLines.push(`${childIndent}  ${inp.name}: ${UNCONNECTED_VALUE}`));
  } else {
    newLines.push(`${childIndent}in: {}`);
  }
  const outputNames = (tool.outputs || []).map((o) => o.name);
  newLines.push(`${childIndent}out: [${outputNames.join(", ")}]`);

  const steps = parseCwlSteps(textarea.value);
  let stepsLineIndex = code.findIndex((l) => /^\s*steps:$/.test(l));
  if (stepsLineIndex === -1) {
    // No `steps:` block yet (a from-scratch document) — start one, or the
    // new step would land as a stray top-level key.
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push("", "steps:");
    stepsLineIndex = lines.length - 1;
  }
  const insertAt = steps.length
    ? steps[steps.length - 1].end
    : stepsLineIndex !== -1
      ? stepsLineIndex + 1
      : lines.length;
  // Match the file's own between-steps blank-line style: one before the new
  // step (skip it if insertAt already sits right after a blank line) and one
  // after, so it doesn't run straight into whatever follows (another step,
  // a trailing comment block, or EOF).
  // No blank line between the `steps:` header itself and its first step.
  const needsGap = lines[insertAt - 1] && lines[insertAt - 1].trim() !== "" && insertAt - 1 !== stepsLineIndex;
  const gapAfter = lines[insertAt] !== undefined && lines[insertAt].trim() !== "";
  const spaced = [...(needsGap ? [""] : []), ...newLines, ...(gapAfter ? [""] : [])];
  lines.splice(insertAt, 0, ...spaced);

  textarea.value = ensureNamespaces(lines.join("\n"));
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  return name;
}

/** A fresh step name derived from the tool's id, deduped against the steps
 * already in `text`. */
function suggestStepName(text, tool) {
  const existingNames = new Set(parseCwlSteps(text).map((s) => s.name));
  const baseName = (tool.id || "step").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "step";
  let name = baseName;
  let suffix = 2;
  while (existingNames.has(name)) {
    name = `${baseName}-${suffix++}`;
  }
  return name;
}

// ---------------------------------------------------------------------------
// Building blocks — Add a step / Connect a step / Finalize the process
// ---------------------------------------------------------------------------
// Text-level edits behind the toolbar's three guided actions (see
// openAddStepModal, openConnectStepModal, openFinalizeModal), each taking
// and returning the whole CWL text, so the modals can chain them and then
// write the result back once.

/** Every value a step input may be wired to: a workflow input's name, or
 * another step's `step/output`. */
function connectionSources(text, excludeStep) {
  const top = parseCwlTopLevel(text);
  const steps = parseCwlSteps(text);
  const stepOutputs = steps
    .filter((s) => s.name !== excludeStep)
    .flatMap((s) => {
      const names = [...new Set([...s.outNames, ...s.runOutputs.map((o) => o.name)])];
      return names.map((o) => ({ value: `${s.name}/${o}`, step: s.name, output: o }));
    });
  return { workflowInputs: top.inputs, stepOutputs };
}

/** True when `fromStep` (transitively, through its own `in:` wiring) already
 * depends on `toStep` — wiring toStep's input to fromStep's output would then
 * close a loop, which the Cookbook Registry rejects (the DAG must be
 * cycle-free). */
function dependsOn(steps, fromStep, toStep) {
  const byName = new Map(steps.map((s) => [s.name, s]));
  const seen = new Set();
  const stack = [fromStep];
  while (stack.length) {
    const name = stack.pop();
    if (name === toStep) return true;
    if (seen.has(name)) continue;
    seen.add(name);
    const step = byName.get(name);
    if (!step) continue;
    step.inEntries.forEach((e) => {
      const m = e.value.match(/^"?([\w.-]+)\/[\w.-]+"?$/);
      if (m) stack.push(m[1]);
    });
  }
  return false;
}

/** Sets (adding it if needed) `stepName`'s `in:` entry for `inputName` to
 * `source`. */
function setStepInput(text, stepName, inputName, source) {
  const lines = text.split("\n");
  const step = parseCwlSteps(text).find((s) => s.name === stepName);
  if (!step) return text;
  const childIndent = " ".repeat(step.stepIndent + 2);
  const entryLine = `${childIndent}  ${inputName}: ${source}`;
  const existing = step.inEntries.find((e) => e.name === inputName);
  const lastNonBlank = (from, to) => {
    let k = to;
    while (k - 1 > from && lines[k - 1].trim() === "") k--;
    return k;
  };

  // An empty source (`""`, e.g. UNCONNECTED_VALUE) means disconnecting.
  const disconnecting = /^""/.test(String(source).trim());
  if (existing && existing.sourceLineIndex !== -1 && !disconnecting) {
    // Long form (`source:` + `valueFrom:`): only the source changes; the
    // valueFrom that reshapes the value for this tool stays.
    const ind = lines[existing.sourceLineIndex].match(/^\s*/)[0];
    lines[existing.sourceLineIndex] = `${ind}source: ${source}`;
  } else if (existing) {
    // Short form, or disconnecting a long-form entry (its valueFrom only
    // made sense for the old source): one plain `name: source` line.
    lines.splice(existing.lineIndex, existing.entryEnd - existing.lineIndex, entryLine);
  } else if (step.inStart !== -1 && stripLineComment(lines[step.inStart]).trim() !== "in:") {
    // `in: {}` — expand the flow form into a block.
    lines.splice(step.inStart, 1, `${childIndent}in:`, entryLine);
  } else if (step.inStart !== -1) {
    lines.splice(lastNonBlank(step.inStart, step.inEnd), 0, entryLine);
  } else {
    const at = step.outLineIndex !== -1 ? step.outLineIndex : lastNonBlank(step.start, step.end);
    lines.splice(at, 0, `${childIndent}in:`, entryLine);
  }
  return lines.join("\n");
}

/** Declares a new top-level workflow input — a parameter the user fills in
 * on the Wizard's Parameters step, or, when `format` is given for a `File`
 * type, a data input the user picks from the Data Catalogue (its Data
 * Ingredients step). Copying the step input's own `type`/`format` is what
 * makes a tool's data input automatically become the recipe's data input. */
function addWorkflowInput(text, name, type, format = null) {
  const lines = text.split("\n");
  const top = parseCwlTopLevel(text);
  const entry = [`  ${name}:`, `    type: ${cwlFlowType(type)}`, ...(format ? [`    format: ${JSON.stringify(format)}`] : [])];
  if (top.inputsStart !== -1) {
    if (stripLineComment(lines[top.inputsStart]).trim() !== "inputs:") {
      lines.splice(top.inputsStart, 1, "inputs:", ...entry); // `inputs: {}`
    } else {
      lines.splice(top.inputsEnd, 0, ...entry);
    }
  } else {
    const at = topLevelInsertIndex(lines, top.outputsStart !== -1 ? top.outputsStart : findStepsLine(lines));
    lines.splice(at, 0, "inputs:", ...entry, "");
  }
  const result = lines.join("\n");
  return format ? ensureNamespaces(result) : result;
}

const IANA_NAMESPACE = "https://www.iana.org/assignments/media-types/";

// Our three extension fields. CWL only allows extension fields with a
// namespace prefix declared in `$namespaces`, so they live in the nLDT
// namespace (see cookbook-registry's cwl_parser.py, which rejects the earlier
// un-namespaced `x-` names).
const NLDT_NAMESPACE = "https://fi-group.github.io/nldt-tb2/ns#";
const EXT_PROCESS_LINK = "nldt:processLink";
const EXT_COMPATIBLE_TOOLS = "nldt:compatibleTools";
const EXT_JSON_SCHEMA = "nldt:jsonSchema";
const COMPATIBLE_TOOLS_HEADER = /^nldt:compatibleTools:\s*$/;

/** Adds `prefix: iri` to the document's `$namespaces` (creating the block,
 * right after the header keys, if there is none) unless that prefix is
 * already mapped. */
function ensureNamespace(text, prefix, iri) {
  const lines = text.split("\n");
  const nsLine = lines.findIndex((l) => /^\$namespaces:/.test(l));
  if (nsLine !== -1) {
    let end = nsLine + 1;
    while (end < lines.length && /^\s+\S/.test(lines[end])) end++;
    if (lines.slice(nsLine, end).some((l) => new RegExp(`^\\s+${prefix}:`).test(l))) return text;
    if (/\{\s*\}\s*$/.test(lines[nsLine])) lines[nsLine] = "$namespaces:";
    lines.splice(end, 0, `  ${prefix}: ${iri}`);
    return lines.join("\n");
  }
  // Right after the header keys (cwlVersion/class/id/label/doc), before inputs.
  const inputsLine = lines.findIndex((l) => /^inputs:/.test(l));
  const at = inputsLine !== -1 ? topLevelInsertIndex(lines, inputsLine) : 0;
  lines.splice(at, 0, "$namespaces:", `  ${prefix}: ${iri}`, "");
  return lines.join("\n");
}

/** A `format: iana:...` value or an `nldt:...` field only means something
 * once the document maps that prefix in its `$namespaces` (standard CWL) —
 * adds whichever mapping the text uses and doesn't declare yet. */
function ensureNamespaces(text) {
  // Only real CWL counts: teaching comments in a recipe may well mention
  // `format: iana:...` without the recipe using it.
  const code = codeLines(text).join("\n");
  let out = text;
  if (/format:\s*"?iana:/.test(code)) out = ensureNamespace(out, "iana", IANA_NAMESPACE);
  if (/^\s*nldt:[A-Za-z]+:/m.test(code)) out = ensureNamespace(out, "nldt", NLDT_NAMESPACE);
  return out;
}

/** Turns a workflow input into a data input — `type: File` (keeping a list
 * `[]` / optional `?` marker) with `format: iana:<mediaType>` — or, with
 * `mediaType === null`, back into a plain parameter (`type: Any`, format
 * removed). Converting to data drops the input's `default` and
 * `nldt:jsonSchema` (a value-shaped default/schema can't describe a File);
 * `asList` forces `File[]`. Flow-form entries are rewritten as blocks. */
function setWorkflowInputData(text, name, mediaType, { asList = false } = {}) {
  const lines = text.split("\n");
  const top = parseCwlTopLevel(text);
  const range = top.inputsStart === -1 ? null : topLevelEntryRange(lines, top.inputsStart, top.inputsEnd, name);
  if (!range) return text;
  const entry = top.inputs.find((i) => i.name === name);
  const oldType = String(entry.type || "Any").replace(/^"|"$/g, "");
  const optional = oldType.endsWith("?");
  const list = asList || oldType.replace(/\?$/, "").endsWith("[]");
  const toData = mediaType !== null;
  const type = toData ? `File${list ? "[]" : ""}${optional && !list ? "?" : ""}` : `Any${optional ? "?" : ""}`;
  const keep = [];
  if (entry.label) keep.push(`    label: ${JSON.stringify(entry.label)}`);
  // Carry over the entry's own doc line (single-line form only); drop
  // default/nldt:jsonSchema when it becomes data, keep them otherwise.
  const [header, end] = range;
  const block = stripLineComment(lines[header]).trim() === `${name}:`;
  const own = block ? lines.slice(header + 1, end) : [];
  // Keys may carry a namespace prefix (`nldt:jsonSchema`).
  const ownKey = (l) => (l.match(/^ {4}([\w$-]+(?::[\w$-]+)?):/) || [])[1];
  const keepKeys = toData ? ["doc"] : ["doc", "default", EXT_JSON_SCHEMA];
  const carried = [];
  for (let k = 0; k < own.length; k++) {
    const key = ownKey(own[k]);
    if (!key || !keepKeys.includes(key)) continue;
    carried.push(own[k]);
    for (let j = k + 1; j < own.length && !ownKey(own[j]) && (own[j].trim() === "" || /^ {5,}/.test(own[j])); j++) carried.push(own[j]);
  }
  const newEntry = [
    `  ${name}:`,
    `    type: ${cwlFlowType(type)}`,
    ...(toData ? [`    format: ${JSON.stringify(mediaTypeToFormat(mediaType))}`] : []),
    ...keep,
    ...carried,
  ];
  lines.splice(header, end - header, ...newEntry);
  const result = lines.join("\n");
  return toData ? ensureNamespaces(result) : result;
}

/** Replaces (or creates) the document's top-level `outputs:` block — the
 * recipe's final result(s), each pointing at one step's output. */
function writeWorkflowOutputs(text, outputs) {
  const lines = text.split("\n");
  const top = parseCwlTopLevel(text);
  // `outputs: {}` rather than a bare `outputs:` (YAML null) when nothing is
  // chosen — the section is required, and an empty mapping still parses.
  const block = [outputs.length ? "outputs:" : "outputs: {}"];
  outputs.forEach((o) => {
    block.push(`  ${o.name}:`, `    type: ${cwlFlowType(o.type)}`, `    outputSource: ${o.source}`);
  });
  if (top.outputsStart !== -1) {
    lines.splice(top.outputsStart, top.outputsEnd - top.outputsStart, ...block);
  } else {
    lines.splice(topLevelInsertIndex(lines, findStepsLine(lines)), 0, ...block, "");
  }
  return lines.join("\n");
}

/** The workflow outputs to write for a set of chosen `step/output` sources:
 * an output already pointing at the same source keeps its name; otherwise
 * the step output's own name, prefixed with its step on a clash. Types come
 * from the step's declared `run.outputs`. */
function workflowOutputsFor(text, chosenSources) {
  const steps = parseCwlSteps(text);
  const currentNames = new Map(
    parseCwlTopLevel(text).outputs.filter((o) => o.outputSource).map((o) => [o.outputSource, o.name])
  );
  const taken = new Set();
  return chosenSources.map((source) => {
    const [stepName, output] = source.split("/");
    const type = steps.find((s) => s.name === stepName)?.runOutputs.find((r) => r.name === output)?.type || "Any";
    let name = currentNames.get(source) || output;
    if (taken.has(name)) name = `${stepName}_${output}`;
    taken.add(name);
    return { name, type, source };
  });
}

/** [first, end) line range of one entry (`  name:` plus its nested lines)
 * inside a top-level block spanning [blockStart, blockEnd). */
function topLevelEntryRange(lines, blockStart, blockEnd, name) {
  const header = lines.findIndex((l, k) => k > blockStart && k < blockEnd && new RegExp(`^  ${name}:`).test(l));
  if (header === -1) return null;
  let end = header + 1;
  while (end < blockEnd && (lines[end].trim() === "" || /^ {3,}\S/.test(lines[end]))) end++;
  while (end > header + 1 && lines[end - 1].trim() === "") end--;
  return [header, end];
}

/** Sets a workflow input's `label:` — the name the Wizard's Parameters step
 * shows for it — converting a flow-form entry to block form if needed. */
function setWorkflowInputLabel(text, name, label) {
  const lines = text.split("\n");
  const top = parseCwlTopLevel(text);
  const range = top.inputsStart === -1 ? null : topLevelEntryRange(lines, top.inputsStart, top.inputsEnd, name);
  if (!range) return text;
  const [header, end] = range;
  const entry = top.inputs.find((i) => i.name === name);
  const labelLine = label ? `    label: ${JSON.stringify(label)}` : null;
  if (stripLineComment(lines[header]).trim() !== `${name}:`) {
    // Flow form (`  name: { type: x }`) — rewrite as a block.
    lines.splice(header, 1, `  ${name}:`, `    type: ${cwlFlowType(entry.type)}`, ...(labelLine ? [labelLine] : []));
  } else {
    const existing = lines.findIndex((l, k) => k > header && k < end && /^ {4}label:/.test(l));
    if (existing !== -1) lines.splice(existing, 1, ...(labelLine ? [labelLine] : []));
    else if (labelLine) lines.splice(end, 0, labelLine);
  }
  return lines.join("\n");
}

/** Deletes one workflow input — collapsing to `inputs: {}` once none are
 * left, since the section itself is required. */
function removeWorkflowInput(text, name) {
  const lines = text.split("\n");
  const top = parseCwlTopLevel(text);
  const range = top.inputsStart === -1 ? null : topLevelEntryRange(lines, top.inputsStart, top.inputsEnd, name);
  if (!range) return text;
  lines.splice(range[0], range[1] - range[0]);
  if (top.inputs.length === 1) lines[top.inputsStart] = "inputs: {}";
  return lines.join("\n");
}

/** Deletes a step, and with it everything that pointed at it: other steps'
 * inputs wired to its outputs go back to "not connected", workflow outputs
 * taken from it are dropped, and so is its nldt:compatibleTools entry. */
function removeStep(text, stepName) {
  const step = parseCwlSteps(text).find((s) => s.name === stepName);
  if (!step) return text;
  const lines = text.split("\n");
  // step.end stops at its last code line (comments/blank lines after it
  // aren't part of it), so after removing it collapse the now-doubled blank
  // separator into one.
  lines.splice(step.start, step.end - step.start);
  while (step.start < lines.length && step.start > 0 && lines[step.start].trim() === "" && lines[step.start - 1].trim() === "") {
    lines.splice(step.start, 1);
  }
  let out = lines.join("\n");

  parseCwlSteps(out).forEach((s) => {
    s.inEntries
      .filter((e) => e.value.replace(/^["']|["']$/g, "").startsWith(`${stepName}/`))
      .forEach((e) => (out = setStepInput(out, s.name, e.name, UNCONNECTED_VALUE)));
  });
  const outputs = parseCwlTopLevel(out).outputs;
  if (outputs.some((o) => (o.outputSource || "").startsWith(`${stepName}/`))) {
    const kept = outputs.filter((o) => o.outputSource && !o.outputSource.startsWith(`${stepName}/`));
    out = writeWorkflowOutputs(out, kept.map((o) => ({ name: o.name, type: o.type, source: o.outputSource })));
  }
  const compatible = parseCompatibleTools(out);
  if (compatible[stepName]) {
    delete compatible[stepName];
    out = writeCompatibleTools(out, compatible);
  }
  return out;
}

// --- The document's header: what CWL itself asks of every recipe ----------

const HEADER_KEYS = ["cwlVersion", "class", "id", "label", "doc"];

/** A YAML scalar's plain value: quotes removed, escapes resolved. */
function unquoteYaml(value) {
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

/** The top-level header keys (HEADER_KEYS) present in `text`, each as
 * {value, start, end} — `end` past any block-scalar continuation lines, so
 * `doc: >` plus its indented paragraph is one entry. Folded (`>`) text comes
 * back as paragraphs separated by a blank line. */
function parseCwlHeader(text) {
  // Keys are matched on comment-stripped lines; a block scalar's body is
  // read from the raw ones (a "#" inside `doc: >` text is literal).
  const raw = text.split("\n");
  const lines = codeLines(text);
  const header = {};
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(cwlVersion|class|id|label|doc):(.*)$/);
    if (!m || header[m[1]]) continue;
    let end = i + 1;
    while (end < lines.length && (lines[end].trim() === "" || /^\s/.test(lines[end]))) end++;
    while (end > i + 1 && lines[end - 1].trim() === "") end--;
    let value = stripYamlComment(m[2].trim());
    if (/^[>|][+-]?$/.test(value)) {
      const body = raw.slice(i + 1, end).map((l) => l.trim());
      value = value.startsWith(">")
        ? body.join("\n").split(/\n\s*\n/).map((p) => p.split("\n").join(" ").trim()).filter(Boolean).join("\n\n")
        : body.join("\n").trim();
    } else {
      value = unquoteYaml(value);
      end = i + 1;
    }
    header[m[1]] = { value, start: i, end };
  }
  return header;
}

/** Plain-text paragraphs, re-wrapped to `width` columns. */
function wrapParagraphs(text, width) {
  return text
    .split(/\n\s*\n/)
    .map((para) => {
      const out = [];
      let line = "";
      para.split(/\s+/).filter(Boolean).forEach((word) => {
        if (line && line.length + 1 + word.length > width) {
          out.push(line);
          line = word;
        } else {
          line = line ? `${line} ${word}` : word;
        }
      });
      if (line) out.push(line);
      return out;
    })
    .filter((p) => p.length)
    .flatMap((p, i) => (i ? ["", ...p] : p));
}

/** Sets (or, with an empty value, removes) one header key, keeping
 * HEADER_KEYS order when it has to be added. `doc` is written as a folded
 * block (`doc: >`), `label` quoted. */
function setHeaderField(text, key, value) {
  const lines = text.split("\n");
  const header = parseCwlHeader(text);
  let newLines = [];
  if (value && key === "doc") newLines = ["doc: >", ...wrapParagraphs(value, 76).map((l) => (l ? `  ${l}` : ""))];
  else if (value && key === "label") newLines = [`label: ${JSON.stringify(value)}`];
  else if (value) newLines = [`${key}: ${value}`];

  const current = header[key];
  if (current) {
    lines.splice(current.start, current.end - current.start, ...newLines);
  } else if (newLines.length) {
    const earlier = HEADER_KEYS.slice(0, HEADER_KEYS.indexOf(key)).map((k) => header[k]).filter(Boolean);
    const at = earlier.length ? Math.max(...earlier.map((h) => h.end)) : 0;
    lines.splice(at, 0, ...newLines);
  }
  return lines.join("\n");
}

/** What a recipe's CWL must (required) and should (recommended) carry at
 * the top level — the Cookbook Registry rejects a document missing any
 * required part (see cookbook-registry's cwl_parser.parse_cwl). */
function cwlRequiredParts(text) {
  const header = parseCwlHeader(text);
  const has = (key) => new RegExp(`^${key}:`, "m").test(text);
  return [
    { key: "cwlVersion", label: "CWL version", hint: "Which version of the CWL standard this is written in (v1.2).", required: true, ok: /^v1\./.test(header.cwlVersion?.value || "") },
    { key: "class", label: "Document type", hint: "class: Workflow, so the document is read as a chain of steps.", required: true, ok: header.class?.value === "Workflow" },
    { key: "inputs", label: "Inputs section", hint: "inputs: the values asked when the recipe runs (may be empty).", required: true, ok: has("inputs") },
    { key: "outputs", label: "Outputs section", hint: "outputs: what the recipe hands back (may be empty while you build).", required: true, ok: has("outputs") },
    { key: "steps", label: "Steps section", hint: "steps: the tools the recipe calls.", required: true, ok: has("steps") },
    { key: "id", label: "Identifier", hint: "id: a short machine name for the recipe.", required: false, ok: Boolean(header.id?.value) },
    { key: "label", label: "Name", hint: "label: the recipe's human-readable name.", required: false, ok: Boolean(header.label?.value) },
    { key: "doc", label: "Description", hint: "doc: what the recipe does, in a sentence or two.", required: false, ok: Boolean(header.doc?.value) },
  ];
}

/** Adds every missing *required* part (see cwlRequiredParts) with a safe
 * default: cwlVersion v1.2, class Workflow, and empty inputs/outputs/steps
 * sections — the skeleton of a valid recipe. Existing parts are untouched
 * (a wrong cwlVersion/class value is corrected). */
function addMissingRequiredParts(text) {
  let out = text;
  const parts = Object.fromEntries(cwlRequiredParts(out).map((p) => [p.key, p]));
  if (!parts.cwlVersion.ok) out = setHeaderField(out, "cwlVersion", "v1.2");
  if (!parts.class.ok) out = setHeaderField(out, "class", "Workflow");
  for (const section of ["inputs", "outputs", "steps"]) {
    if (new RegExp(`^${section}:`, "m").test(out)) continue;
    const lines = out.split("\n");
    // Before the first later section, else at the end — keeping CWL's usual
    // inputs → outputs → steps order.
    const later = ["inputs", "outputs", "steps"].slice(["inputs", "outputs", "steps"].indexOf(section) + 1);
    let at = lines.findIndex((l) => later.some((k) => new RegExp(`^${k}:`).test(l)));
    if (at === -1) {
      while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
      at = lines.length;
      lines.push("");
      at++;
    } else {
      at = topLevelInsertIndex(lines, at);
    }
    lines.splice(at, 0, `${section}: {}`, "");
    out = lines.join("\n");
  }
  return out;
}

function findStepsLine(lines) {
  const i = lines.findIndex((l) => /^steps:/.test(l));
  return i === -1 ? lines.length : i;
}

/** Where to insert a new top-level block in front of line `before` — above
 * any comment lines directly preceding it, since those describe that block,
 * not the new one. */
function topLevelInsertIndex(lines, before) {
  let k = before;
  while (k > 0 && lines[k - 1].startsWith("#")) k--;
  return k;
}

/** Unconnected inputs, dangling references and tool-less steps — what
 * Finalize lists before the author commits to Validate. Advisory only: the
 * Cookbook Registry's validation is still the real gate. */
function recipeIssues(text) {
  const steps = parseCwlSteps(text);
  const { workflowInputs } = connectionSources(text, null);
  const inputNames = new Set(workflowInputs.map((i) => i.name));
  const outputsByStep = new Map(
    steps.map((s) => [s.name, new Set([...s.outNames, ...s.runOutputs.map((o) => o.name)])])
  );
  const issues = cwlRequiredParts(text)
    .filter((p) => p.required && !p.ok)
    .map((p) => `Missing required part: ${p.label} (${p.key}). Add it under Recipe details.`);
  const used = new Set();
  steps.forEach((s) => {
    if (s.idLineIndex === -1 || s.idValue === "custom-tool") {
      issues.push(`Step "${s.name}" has no tool yet — pick one in its panel on the right.`);
    }
    const wired = new Map(s.inEntries.map((e) => [e.name, e.value]));
    const names = [...new Set([...s.runInputs.map((i) => i.name), ...wired.keys()])];
    names.forEach((n) => {
      const raw = (wired.get(n) || "").replace(/^["']|["']$/g, "");
      if (!raw) {
        issues.push(`"${s.name}" → input "${n}" isn't connected yet.`);
        return;
      }
      const ref = raw.match(/^([\w.-]+)\/([\w.-]+)$/);
      if (ref) {
        if (!outputsByStep.get(ref[1])?.has(ref[2])) {
          issues.push(`"${s.name}" → input "${n}" points at "${raw}", which no step produces.`);
        }
      } else if (inputNames.has(raw)) {
        used.add(raw);
      } else {
        issues.push(`"${s.name}" → input "${n}" points at "${raw}", which isn't a workflow input.`);
      }
    });
  });
  workflowInputs.forEach((i) => {
    if (!used.has(i.name)) issues.push(`Workflow input "${i.name}" isn't used by any step.`);
  });
  return issues;
}

/** Shared shell for the three building-block modals — same overlay/panel
 * markup as openAddStepFromUrlModal. `onConfirm(panel)` returns an error
 * string to show (keeping the modal open), or nothing to close it. */
function openBlockModal({ title, intro, bodyHtml, confirmLabel, onOpen, onConfirm }) {
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
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  overlay.innerHTML = `
    <div class="modal-panel" style="max-width:560px;">
      <div class="modal-panel__header">
        <h2>${title}</h2>
        <button type="button" class="modal-panel__close" aria-label="Close">${icons.close}</button>
      </div>
      <div class="modal-panel__body" style="display:block;padding:20px 22px;overflow-y:auto;">
        ${intro ? `<p style="margin:0 0 14px;font-size:.85rem;color:var(--g-900);">${intro}</p>` : ""}
        <div class="block-form">${bodyHtml}</div>
        <div class="block-modal__status" style="margin-top:10px;font-size:.82rem;"></div>
      </div>
      <div class="modal-panel__footer">
        <button type="button" class="btn btn-outline" data-block-cancel>Cancel</button>
        <button type="button" class="btn btn-secondary" data-block-confirm>${confirmLabel}</button>
      </div>
    </div>`;

  const panel = overlay.querySelector(".modal-panel");
  const statusEl = panel.querySelector(".block-modal__status");
  panel.querySelector(".modal-panel__close").addEventListener("click", close);
  panel.querySelector("[data-block-cancel]").addEventListener("click", close);
  panel.querySelector("[data-block-confirm]").addEventListener("click", () => {
    const error = onConfirm(panel);
    if (error) statusEl.innerHTML = `<span style="color:var(--c-error);">${escapeHtml(error)}</span>`;
    else close();
  });
  if (onOpen) onOpen(panel, close);
  return { panel, close };
}

const BLANK_TOOL_VALUE = "__blank__";

/** Building block 2 — appends a new step for a cataloged tool (or a blank one
 * to fill in by hand). Its inputs are all left unconnected: where each value
 * comes from is always the author's own choice, made afterwards in the
 * diagram or with Connect a step — never guessed here. */
function openAddStepModal(textarea, resultEl) {
  const toolFor = (value) =>
    value === BLANK_TOOL_VALUE ? { id: "custom-tool", label: null, inputs: [], outputs: [] } : findTool(value);

  openBlockModal({
    title: "Add a step",
    intro:
      "A step is one call to a tool (an OGC API Process). Pick the tool, name the step, and it's " +
      "appended to the end of <code>steps:</code> with its inputs and outputs already declared. " +
      "You connect its inputs afterwards.",
    bodyHtml: `
      <label>Tool
        <select data-field="tool">
          ${TOOL_CATALOG.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.label)}</option>`).join("")}
          <option value="${BLANK_TOOL_VALUE}">Blank step — choose the tool later</option>
        </select>
        <span class="block-form__hint" data-field="io"></span>
      </label>
      <label>Step name
        <input type="text" data-field="name" />
        <span class="block-form__hint">Letters, digits, - and _ only. Other steps refer to this step's outputs as <code>name/output</code>.</span>
      </label>
      <hr class="block-form__divider" />
      <div style="font-size:.8rem;color:var(--g-900);">
        Tool not listed? <a href="#" data-field="from-url">Fetch it from an OGC API Process URL…</a>
      </div>`,
    confirmLabel: "Add step",
    onOpen(panel, close) {
      const toolSel = panel.querySelector('[data-field="tool"]');
      const nameInput = panel.querySelector('[data-field="name"]');
      const ioEl = panel.querySelector('[data-field="io"]');
      let nameTouched = false;
      nameInput.addEventListener("input", () => (nameTouched = true));
      const sync = () => {
        const tool = toolFor(toolSel.value);
        ioEl.innerHTML = tool.inputs.length || tool.outputs.length ? toolIoSummaryHtml(tool) : "Its tool, inputs and outputs are filled in afterwards.";
        if (!nameTouched) nameInput.value = suggestStepName(textarea.value, toolSel.value === BLANK_TOOL_VALUE ? { id: "step" } : tool);
      };
      toolSel.addEventListener("change", sync);
      sync();
      panel.querySelector('[data-field="from-url"]').addEventListener("click", (e) => {
        e.preventDefault();
        close();
        openAddStepFromUrlModal(textarea, resultEl);
      });
    },
    onConfirm(panel) {
      const tool = toolFor(panel.querySelector('[data-field="tool"]').value);
      const name = panel.querySelector('[data-field="name"]').value.trim();
      if (!/^[A-Za-z0-9_-]+$/.test(name)) return "Give the step a name using only letters, digits, - and _.";
      if (parseCwlSteps(textarea.value).some((s) => s.name === name)) return `There is already a step called "${name}".`;

      insertNewStep(textarea, tool, { name });
      const inputs = tool.inputs.map((i) => i.name);
      resultEl.innerHTML = `
        <div class="notice-banner">
          Added step "<b>${escapeHtml(name)}</b>".
          ${inputs.length ? `<br /><small>Next: connect its inputs (${inputs.map(escapeHtml).join(", ")}). Click the step in the diagram, or use <b>Connect a step</b>.</small>` : ""}
          ${tool.id === "custom-tool" ? `<br /><small>Pick its tool by clicking the step in the diagram.</small>` : ""}
        </div>`;
      showToast(`Added step "${name}".`);
      return null;
    },
  });
}

/** Building block 2 — wires one step input to a workflow input (existing or
 * new) or to another step's output. */
function openConnectStepModal(textarea, resultEl) {
  const steps = parseCwlSteps(textarea.value);
  if (!steps.length) {
    showToast("No steps yet — add a step first.");
    return;
  }
  const NEW_INPUT = "__new_input__";
  const stepInputs = (step) => {
    const wired = new Map(step.inEntries.map((e) => [e.name, e.value]));
    const types = new Map(step.runInputs.map((i) => [i.name, i.type]));
    const formats = new Map(step.runInputs.map((i) => [i.name, i.format]));
    return [...new Set([...types.keys(), ...wired.keys()])].map((name) => {
      const value = (wired.get(name) || "").replace(/^["']|["']$/g, "");
      return { name, type: types.get(name) || "Any", format: formats.get(name) || null, value };
    });
  };
  // Start on the first step that still has something unconnected.
  const firstOpen = steps.find((s) => stepInputs(s).some((i) => !i.value)) || steps[0];

  openBlockModal({
    title: "Connect a step",
    intro:
      "Every step input needs a value: either a <b>workflow input</b> (a parameter the user fills " +
      "in when running the recipe) or the <b>output of another step</b>, which makes this step " +
      "run after it.",
    bodyHtml: `
      <label>Step
        <select data-field="step">
          ${steps.map((s) => `<option value="${escapeHtml(s.name)}" ${s === firstOpen ? "selected" : ""}>${escapeHtml(s.name)}</option>`).join("")}
        </select>
      </label>
      <label>Its input
        <select data-field="input"></select>
      </label>
      <label>Takes its value from
        <select data-field="source"></select>
      </label>
      <label data-field="new-input-row" style="display:none;">New workflow input name
        <input type="text" data-field="new-input" />
        <span class="block-form__hint">Added to the recipe's top-level <code>inputs:</code>, with the step input's type.</span>
      </label>`,
    confirmLabel: "Connect",
    onOpen(panel) {
      const stepSel = panel.querySelector('[data-field="step"]');
      const inputSel = panel.querySelector('[data-field="input"]');
      const sourceSel = panel.querySelector('[data-field="source"]');
      const newRow = panel.querySelector('[data-field="new-input-row"]');
      const newInput = panel.querySelector('[data-field="new-input"]');

      const fillInputs = () => {
        const step = steps.find((s) => s.name === stepSel.value);
        const inputs = stepInputs(step);
        const firstUnwired = inputs.find((i) => !i.value);
        inputSel.innerHTML = inputs.length
          ? inputs
              .map(
                (i) =>
                  `<option value="${escapeHtml(i.name)}" ${i === firstUnwired ? "selected" : ""}>${escapeHtml(i.name)} (${escapeHtml(i.type)}) — ${i.value ? `now ← ${escapeHtml(i.value)}` : "not connected"}</option>`
              )
              .join("")
          : `<option value="" disabled selected>This step's tool declares no inputs</option>`;
        fillSources();
      };
      const fillSources = () => {
        const { workflowInputs, stepOutputs } = connectionSources(textarea.value, stepSel.value);
        const current = stepInputs(steps.find((s) => s.name === stepSel.value)).find((i) => i.name === inputSel.value);
        const opt = (value, label) =>
          `<option value="${escapeHtml(value)}" ${current && current.value === value ? "selected" : ""}>${escapeHtml(label)}</option>`;
        sourceSel.innerHTML = `
          ${workflowInputs.length ? `<optgroup label="Workflow inputs">${workflowInputs.map((w) => opt(w.name, `${w.name} (${w.type})`)).join("")}</optgroup>` : ""}
          ${stepOutputs.length ? `<optgroup label="Outputs of other steps">${stepOutputs.map((o) => opt(o.value, o.value)).join("")}</optgroup>` : ""}
          <option value="${NEW_INPUT}" ${!workflowInputs.length && !stepOutputs.length ? "selected" : ""}>New workflow input…</option>`;
        newInput.value = inputSel.value || "";
        toggleNew();
      };
      const toggleNew = () => {
        newRow.style.display = sourceSel.value === NEW_INPUT ? "" : "none";
      };
      stepSel.addEventListener("change", fillInputs);
      inputSel.addEventListener("change", fillSources);
      sourceSel.addEventListener("change", toggleNew);
      fillInputs();
    },
    onConfirm(panel) {
      const stepName = panel.querySelector('[data-field="step"]').value;
      const inputName = panel.querySelector('[data-field="input"]').value;
      let source = panel.querySelector('[data-field="source"]').value;
      if (!inputName) return "This step has no inputs to connect — pick its tool first.";
      const step = steps.find((s) => s.name === stepName);
      const stepInput = stepInputs(step).find((i) => i.name === inputName);
      const inputType = stepInput?.type || "Any";

      let text = textarea.value;
      if (source === NEW_INPUT) {
        source = panel.querySelector('[data-field="new-input"]').value.trim();
        if (!/^[A-Za-z0-9_-]+$/.test(source)) return "Give the new workflow input a name using only letters, digits, - and _.";
        if (parseCwlTopLevel(text).inputs.some((i) => i.name === source)) return `There is already a workflow input called "${source}" — pick it from the list instead.`;
      } else {
        const fromStep = source.includes("/") ? source.split("/")[0] : null;
        if (fromStep && dependsOn(steps, fromStep, stepName)) {
          return `"${fromStep}" already depends on "${stepName}" — connecting them this way would create a loop.`;
        }
      }
      // Edit the step first, then (re-parsing) the top-level inputs block,
      // so neither edit works from line numbers the other has shifted.
      const isNew = panel.querySelector('[data-field="source"]').value === NEW_INPUT;
      text = setStepInput(text, stepName, inputName, source);
      if (isNew) text = addWorkflowInput(text, source, inputType, isFileType(inputType) ? stepInput?.format || null : null);
      textarea.value = text;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));

      const remaining = recipeIssues(textarea.value).filter((i) => i.includes("isn't connected"));
      resultEl.innerHTML = `
        <div class="notice-banner">
          Connected <b>${escapeHtml(stepName)}</b> → ${escapeHtml(inputName)} ← <b>${escapeHtml(source)}</b>${isNew ? " (new workflow input)" : ""}.
          ${remaining.length ? `<br /><small>${remaining.length} input${remaining.length === 1 ? "" : "s"} still to connect.</small>` : `<br /><small>Every step input is connected — next: <b>Finalize the process</b>.</small>`}
        </div>`;
      return null;
    },
  });
}

/** Building block 3 — picks which step output(s) are the recipe's final
 * result (writing the top-level `outputs:` block), lists anything still
 * unfinished, then runs Validate. */
function openFinalizeModal(textarea, resultEl, validateBtn) {
  const steps = parseCwlSteps(textarea.value);
  if (!steps.length) {
    showToast("No steps yet — add a step first.");
    return;
  }
  const top = parseCwlTopLevel(textarea.value);
  const { stepOutputs } = connectionSources(textarea.value, null);
  const typeOf = (o) => steps.find((s) => s.name === o.step)?.runOutputs.find((r) => r.name === o.output)?.type || "Any";
  const currentSources = new Map(top.outputs.filter((o) => o.outputSource).map((o) => [o.outputSource, o.name]));
  // Nothing chosen yet: default to the outputs no other step consumes — the
  // ends of the pipeline.
  const consumed = new Set(steps.flatMap((s) => s.inEntries.map((e) => e.value.replace(/^["']|["']$/g, ""))));
  const preselect = (o) => (currentSources.size ? currentSources.has(o.value) : !consumed.has(o.value));
  const issues = recipeIssues(textarea.value);

  openBlockModal({
    title: "Finalize the process",
    intro:
      "Choose which step output(s) the recipe hands back as its result. They're written to the " +
      "top-level <code>outputs:</code> block, and the recipe is then validated.",
    bodyHtml: `
      <div>
        <div style="font-weight:600;color:var(--c-navy);margin-bottom:6px;">Recipe result</div>
        ${
          stepOutputs.length
            ? `<div class="block-form__checks">${stepOutputs
                .map(
                  (o) => `
                <label><input type="checkbox" value="${escapeHtml(o.value)}" ${preselect(o) ? "checked" : ""} />
                  <span><code>${escapeHtml(o.value)}</code> <span style="color:var(--g-900);">(${escapeHtml(typeOf(o))})</span></span>
                </label>`
                )
                .join("")}</div>`
            : `<p class="facet__empty" style="margin:0;">No step declares any outputs yet.</p>`
        }
      </div>
      <div>
        <div style="font-weight:600;color:var(--c-navy);margin-bottom:6px;">Checks</div>
        ${
          issues.length
            ? `<ul class="block-form__issues">${issues.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`
            : `<p style="margin:0;font-size:.8rem;color:var(--g-900);">Every step has a tool and every input is connected.</p>`
        }
      </div>`,
    confirmLabel: "Write outputs &amp; Validate",
    onConfirm(panel) {
      const chosen = [...panel.querySelectorAll(".block-form__checks input:checked")].map((cb) =>
        stepOutputs.find((o) => o.value === cb.value)
      );
      if (!chosen.length) return "Choose at least one step output as the recipe's result.";
      const outputs = workflowOutputsFor(textarea.value, chosen.map((o) => o.value));
      textarea.value = writeWorkflowOutputs(textarea.value, outputs);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      validateBtn.click();
      return null;
    },
  });
}

// ---------------------------------------------------------------------------
// Guided builder — the Orchestrator tab's non-CWL view
// ---------------------------------------------------------------------------
// The same recipe definition as the CWL editor, presented as four plain-
// language stages for authors who don't know CWL: which tools, where each
// tool's values come from, what the person running it fills in, and what it
// hands back. The CWL text stays the single source of truth: every stage is
// rendered from it, and every change is written back into it through the
// same helpers the building-block modals use — so switching views never
// loses anything, hand-written comments included.

const ASK_WHEN_RUN = "__ask__";

/** A CWL type, in words. */
function friendlyType(type) {
  const raw = String(type || "Any").replace(/^"|"$/g, "");
  const optional = raw.endsWith("?");
  let base = raw.replace(/\?$/, "");
  const list = base.endsWith("[]");
  base = base.replace(/\[\]$/, "");
  const words = {
    float: "number",
    double: "number",
    int: "whole number",
    long: "whole number",
    string: "text",
    boolean: "yes/no",
    object: "object, e.g. a GeoJSON geometry",
    File: "file (data input)",
    enum: "choice",
    Any: "any value",
  };
  let label = words[base] || base;
  if (list) label = `list of: ${label}`;
  return optional ? `${label} (optional)` : label;
}

/** A short type name for a type written as a flow mapping, e.g.
 * `type: { type: array, items: { type: enum, symbols: [a, b] } }` -> "enum[]". */
function flowMappingType(line) {
  const isArray = /type:\s*array/.test(line);
  const isEnum = /type:\s*enum/.test(line);
  const base = isEnum ? "enum" : "Any";
  return isArray ? `${base}[]` : base;
}

/** Whether a CWL type is a data input (`File`, `File?`, `File[]`). */
function isFileType(type) {
  return /^"?File(\[\])?\??"?$/.test(String(type || ""));
}

/** "data · GeoJSON" / "parameter · number" — how an input is labelled in
 * the diagram and the Guided builder. */
function inputKindLabel(input) {
  if (isFileType(input.type)) return `data · ${mediaTypeLabel(formatToMediaType(input.format))}`;
  return `parameter · ${shortType(input.type)}`;
}

/** The parameter/data switch and media-type picker for one workflow input —
 * shown in the Guided builder's inputs stage and the diagram's input
 * inspector (see wireDataInputControls). */
function dataInputControlsHtml(input) {
  const isData = isFileType(input.type);
  const mediaType = formatToMediaType(input.format);
  const known = DATA_MEDIA_TYPE_OPTIONS.some((o) => o.mediaType === mediaType);
  const list = String(input.type).includes("[]");
  const name = escapeHtml(input.name);
  return `
    <div class="guided-data-input">
      <label class="guided-data-input__switch">
        <input type="checkbox" data-input-data="${name}" ${isData ? "checked" : ""} />
        <span><b>Data input</b> — the user picks a dataset from the Data Catalogue instead of typing a value.
        Written to the CWL as <code>type: File</code> with a <code>format</code>.</span>
      </label>
      ${
        isData
          ? `<div class="guided-data-input__row">
              <label class="guided-field"><span>Format</span>
                <select data-input-media="${name}">
                  ${DATA_MEDIA_TYPE_OPTIONS.map((o) => `<option value="${escapeHtml(o.mediaType)}" ${o.mediaType === mediaType ? "selected" : ""}>${escapeHtml(o.label)} (${escapeHtml(o.mediaType)})</option>`).join("")}
                  <option value="__custom__" ${known ? "" : "selected"}>Other media type…</option>
                </select>
              </label>
              <label class="guided-field" ${known ? 'style="display:none;"' : ""} data-input-media-custom-row="${name}"><span>Media type</span>
                <input type="text" data-input-media-custom="${name}" value="${escapeHtml(known ? "" : mediaType || "")}" placeholder="e.g. application/geo+json" />
              </label>
              <label class="guided-data-input__switch"><input type="checkbox" data-input-list="${name}" ${list ? "checked" : ""} /><span>One or more files (<code>File[]</code>)</span></label>
            </div>`
          : ""
      }
    </div>`;
}

/** Hooks dataInputControlsHtml's controls up to setWorkflowInputData. */
function wireDataInputControls(el, textarea, commit) {
  const current = (name) => parseCwlTopLevel(textarea.value).inputs.find((i) => i.name === name);
  el.querySelectorAll("[data-input-data]").forEach((cb) =>
    cb.addEventListener("change", () => {
      const name = cb.dataset.inputData;
      commit(setWorkflowInputData(textarea.value, name, cb.checked ? DATA_MEDIA_TYPE_OPTIONS[0].mediaType : null));
    })
  );
  el.querySelectorAll("[data-input-media]").forEach((sel) =>
    sel.addEventListener("change", () => {
      const name = sel.dataset.inputMedia;
      if (sel.value === "__custom__") {
        const row = el.querySelector(`[data-input-media-custom-row="${CSS.escape(name)}"]`);
        if (row) row.style.display = "";
        return;
      }
      const input = current(name);
      commit(setWorkflowInputData(textarea.value, name, sel.value, { asList: String(input?.type).includes("[]") }));
    })
  );
  el.querySelectorAll("[data-input-media-custom]").forEach((inp) =>
    inp.addEventListener("change", () => {
      const name = inp.dataset.inputMediaCustom;
      const value = inp.value.trim();
      if (!/^[\w.+-]+\/[\w.+-]+(;.*)?$/.test(value)) return showToast("Enter a media type like application/geo+json.");
      const input = current(name);
      commit(setWorkflowInputData(textarea.value, name, value, { asList: String(input?.type).includes("[]") }));
    })
  );
  el.querySelectorAll("[data-input-list]").forEach((cb) =>
    cb.addEventListener("change", () => {
      const name = cb.dataset.inputList;
      const input = current(name);
      const mediaType = formatToMediaType(input?.format) || DATA_MEDIA_TYPE_OPTIONS[0].mediaType;
      // Drop the list marker first (via a round-trip through a plain File),
      // then re-apply with or without it.
      const plain = setWorkflowInputData(setWorkflowInputData(textarea.value, name, null), name, mediaType);
      commit(cb.checked ? setWorkflowInputData(plain, name, mediaType, { asList: true }) : plain);
    })
  );
}

/** Where every step input currently gets its value from, plus what's
 * unfinished — the shared read model behind all four stages. */
function guidedModel(text) {
  const steps = parseCwlSteps(text);
  const top = parseCwlTopLevel(text);
  const inputNames = new Set(top.inputs.map((i) => i.name));
  const outputsByStep = new Map(steps.map((s) => [s.name, new Set([...s.outNames, ...s.runOutputs.map((o) => o.name)])]));
  const usedBy = new Map(top.inputs.map((i) => [i.name, []]));

  const stepViews = steps.map((s) => {
    const wired = new Map(s.inEntries.map((e) => [e.name, e.value.replace(/^["']|["']$/g, "")]));
    const reshaped = new Map(s.inEntries.map((e) => [e.name, e.valueFrom]));
    const types = new Map(s.runInputs.map((i) => [i.name, i.type]));
    const formats = new Map(s.runInputs.map((i) => [i.name, i.format]));
    const inputs = [...new Set([...types.keys(), ...wired.keys()])].map((name) => {
      const value = wired.get(name) || "";
      const ref = value.match(/^([\w.-]+)\/([\w.-]+)$/);
      let status = "missing";
      if (ref) status = outputsByStep.get(ref[1])?.has(ref[2]) ? "step" : "broken";
      else if (value) status = inputNames.has(value) ? "recipe" : "broken";
      if (status === "recipe") usedBy.get(value).push(`${s.name} → ${name}`);
      return { name, type: types.get(name) || "Any", format: formats.get(name) || null, value, status, valueFrom: reshaped.get(name) || null };
    });
    const tool = s.idValue && s.idValue !== "custom-tool" ? findTool(s.idValue) : null;
    const hasTool = Boolean(s.idValue && s.idValue !== "custom-tool");
    // What to call the step's tool — the same rule as everywhere else (see
    // views/recipeWizard.js's stepAppName): the run block's own label, else
    // the catalog's name, else its bare process id.
    const toolName = hasTool ? s.runLabel || (tool ? tool.label : s.idValue) : null;
    return { ...s, inputs, tool, hasTool, toolName };
  });

  const resultSources = new Set(top.outputs.map((o) => o.outputSource).filter(Boolean));
  const validResults = [...resultSources].filter((src) => {
    const [st, out] = src.split("/");
    return outputsByStep.get(st)?.has(out);
  });
  return {
    steps: stepViews,
    recipeInputs: top.inputs.map((i) => ({ ...i, usedBy: usedBy.get(i.name) || [] })),
    resultSources,
    stageDone: {
      details: cwlRequiredParts(text).every((p) => !p.required || p.ok) && Boolean(parseCwlHeader(text).label?.value),
      tools: stepViews.length > 0 && stepViews.every((s) => s.hasTool),
      connect: stepViews.length > 0 && stepViews.every((s) => s.inputs.every((i) => i.status === "recipe" || i.status === "step")),
      inputs: top.inputs.every((i) => (usedBy.get(i.name) || []).length > 0),
      result: validResults.length > 0 && validResults.length === resultSources.size,
    },
  };
}

const GUIDED_STAGES = [
  { key: "details", title: "Recipe details", hint: "Name, and the CWL basics" },
  { key: "tools", title: "Tools", hint: "Which tools does it use?" },
  { key: "connect", title: "Connect", hint: "Where do their values come from?" },
  { key: "inputs", title: "Recipe inputs", hint: "What does the user fill in?" },
  { key: "result", title: "Result", hint: "What does it hand back?" },
];

function guidedStepTitle(step, idx) {
  const toolName = step.toolName || "No tool chosen yet";
  return `<span class="guided-card__num">Step ${idx + 1}</span>
    <b>${escapeHtml(toolName)}</b>
    <code class="guided-card__name" title="The step's name in the recipe definition">${escapeHtml(step.name)}</code>`;
}

/** A step card's collapsible "Alternative tools" section (see
 * alternativesSectionHtml) — open by default once any are chosen. */
function guidedAlternativesHtml(text, step) {
  const count = stepAlternatives(text, step).length;
  return `
    <details class="guided-alt" ${count ? "open" : ""}>
      <summary>Alternative tools <span>${count ? `${count} chosen` : "optional"}</span></summary>
      ${alternativesSectionHtml(text, step)}
    </details>`;
}

function guidedToolsStageHtml(text, model) {
  const cards = model.steps
    .map(
      (s, idx) => `
      <div class="guided-card">
        <div class="guided-card__head">
          ${guidedStepTitle(s, idx)}
          <button type="button" class="btn btn-outline btn-sm guided-card__remove" data-remove-step="${escapeHtml(s.name)}">Remove</button>
        </div>
        ${
          s.hasTool
            ? `<div class="guided-card__io">
                <div><span class="guided-label">Needs</span> ${s.runInputs.map((i) => `<code>${escapeHtml(i.name)}</code> <small>${escapeHtml(friendlyType(i.type))}</small>`).join(", ") || "nothing"}</div>
                <div><span class="guided-label">Gives back</span> ${s.runOutputs.map((o) => `<code>${escapeHtml(o.name)}</code> <small>${escapeHtml(friendlyType(o.type))}</small>`).join(", ") || "nothing"}</div>
              </div>`
            : `<div class="guided-card__io">
                <span class="guided-chip guided-chip--todo">Pick a tool</span>
                <select data-pick-tool="${escapeHtml(s.name)}">
                  <option value="" selected disabled>Choose a tool…</option>
                  ${TOOL_CATALOG.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.label)}</option>`).join("")}
                </select>
              </div>`
        }
        ${s.hasTool ? guidedAlternativesHtml(text, s) : ""}
      </div>`
    )
    .join("");
  return `
    <p class="guided__intro">
      A recipe is a chain of <b>tools</b>. Each tool is an OGC API Process: a web service that
      takes some values and gives back a result. Add the tools this recipe needs. What each one
      <b>needs</b> and <b>gives back</b> is read from the service itself; you don't type it in.
      Optionally, open <b>Alternative tools</b> on a step to let hubs swap in another tool for it.
    </p>
    ${cards || `<div class="guided__empty">No tools yet. Add the first one below.</div>`}
    <div class="guided__actions">
      <button type="button" class="btn btn-secondary btn-sm" data-guided-action="add-catalog">+ Add a tool from the catalog</button>
      <button type="button" class="btn btn-outline btn-sm" data-guided-action="add-url">+ Add a tool by its OGC API Process URL</button>
    </div>`;
}

function guidedSourceOptionsHtml(model, step, input) {
  const others = model.steps.filter((s) => s.name !== step.name);
  const allSteps = model.steps;
  const sel = (v) => (input.value === v ? "selected" : "");
  const recipeOpts = model.recipeInputs
    .map((r) => `<option value="${escapeHtml(r.name)}" ${sel(r.name)}>${escapeHtml(r.label || r.name)} (${escapeHtml(friendlyType(r.type))})</option>`)
    .join("");
  const stepOpts = others
    .flatMap((o) => {
      const loop = dependsOn(allSteps, o.name, step.name);
      const outs = [...new Set([...o.outNames, ...o.runOutputs.map((r) => r.name)])];
      return outs.map(
        (out) =>
          `<option value="${escapeHtml(`${o.name}/${out}`)}" ${sel(`${o.name}/${out}`)} ${loop ? "disabled" : ""}>${escapeHtml(out)}, from step "${escapeHtml(o.name)}"${loop ? " (would create a loop)" : ""}</option>`
      );
    })
    .join("");
  return `
    <option value="" ${input.status === "missing" ? "selected" : ""}>Choose where this comes from…</option>
    ${input.status === "broken" ? `<option value="${escapeHtml(input.value)}" selected>${escapeHtml(input.value)} (not found)</option>` : ""}
    <option value="${ASK_WHEN_RUN}">Ask the user when the recipe runs (new recipe input)</option>
    ${recipeOpts ? `<optgroup label="Asked when the recipe runs (existing recipe inputs)">${recipeOpts}</optgroup>` : ""}
    ${stepOpts ? `<optgroup label="The result of another step">${stepOpts}</optgroup>` : ""}`;
}

function guidedConnectStageHtml(model) {
  if (!model.steps.length) return `<div class="guided__empty">Add a tool first (stage 2).</div>`;
  const chip = (status) =>
    ({
      recipe: `<span class="guided-chip guided-chip--ok">Asked when run</span>`,
      step: `<span class="guided-chip guided-chip--ok">From a step</span>`,
      broken: `<span class="guided-chip guided-chip--todo">Points at nothing</span>`,
      missing: `<span class="guided-chip guided-chip--todo">Not connected</span>`,
    })[status];
  const cards = model.steps
    .map(
      (s, idx) => `
      <div class="guided-card">
        <div class="guided-card__head">${guidedStepTitle(s, idx)}</div>
        ${
          s.inputs.length
            ? s.inputs
                .map(
                  (i) => `
            <div class="guided-row">
              <div class="guided-row__what"><code>${escapeHtml(i.name)}</code><small>${escapeHtml(friendlyType(i.type))}</small></div>
              <div class="guided-row__arrow" aria-hidden="true">←</div>
              <select data-connect-step="${escapeHtml(s.name)}" data-connect-input="${escapeHtml(i.name)}" data-connect-type="${escapeHtml(i.type)}" data-connect-format="${escapeHtml(i.format || "")}">
                ${guidedSourceOptionsHtml(model, s, i)}
              </select>
              ${chip(i.status)}
              ${
                i.valueFrom
                  ? `<div class="guided-row__reshape" title="${escapeHtml(i.valueFrom)}">Reshaped on the way in with <code>valueFrom</code>: <code>${escapeHtml(i.valueFrom)}</code></div>`
                  : ""
              }
            </div>`
                )
                .join("")
            : `<div class="guided-card__io">This tool needs no values.</div>`
        }
      </div>`
    )
    .join("");
  return `
    <p class="guided__intro">
      Each tool lists the values it <b>needs</b>. Here you say where each one <b>comes from</b>:
    </p>
    <ul class="guided__explain">
      <li><b>Ask the user when the recipe runs.</b> The person running the recipe types it in — or, when the tool input takes data, picks a dataset from the Data Catalogue. This becomes a <i>recipe input</i> (stage 4).</li>
      <li><b>The result of another step.</b> What one tool gives back is passed straight on, so this step runs after that one.</li>
    </ul>
    ${
      model.steps.some((s) => s.inputs.some((i) => i.valueFrom))
        ? `<p class="guided__intro">Some values are <b>reshaped on the way in</b> with CWL's <code>valueFrom</code> — e.g. a data input's file links turned into the shape a tool expects, or one field picked out of a previous step's result. Changing where such a value comes from keeps its <code>valueFrom</code>; edit the CWL directly to change the reshaping itself.</p>`
        : ""
    }
    ${cards}`;
}

function guidedInputsStageHtml(model) {
  const rows = model.recipeInputs
    .map(
      (r) => `
      <div class="guided-card">
        <div class="guided-card__head">
          <code>${escapeHtml(r.name)}</code> <span class="guided-chip ${isFileType(r.type) ? "guided-chip--data" : ""}">${escapeHtml(inputKindLabel(r))}</span>
          ${r.usedBy.length ? "" : `<span class="guided-chip guided-chip--todo">Not used by any tool</span>`}
          ${r.usedBy.length ? "" : `<button type="button" class="btn btn-outline btn-sm guided-card__remove" data-remove-input="${escapeHtml(r.name)}">Remove</button>`}
        </div>
        <label class="guided-field">
          <span>Label shown to the user</span>
          <input type="text" data-input-label="${escapeHtml(r.name)}" value="${escapeHtml(r.label || "")}" placeholder="e.g. ${escapeHtml(r.name.charAt(0).toUpperCase() + r.name.slice(1))}" />
        </label>
        ${dataInputControlsHtml(r)}
        ${r.usedBy.length ? `<div class="guided-card__io"><span class="guided-label">Used by</span> ${r.usedBy.map(escapeHtml).join(", ")}</div>` : ""}
      </div>`
    )
    .join("");
  return `
    <p class="guided__intro">
      These are what the person running the recipe provides. A <b>parameter</b> is a value they
      type in on the Wizard's Parameters step; a <b>data input</b> is a dataset they pick from the
      Data Catalogue on its Data Ingredients step, handed to the tool as a link it fetches itself.
      Inputs are created in stage 3 whenever you choose <i>Ask the user when the recipe runs</i> —
      a tool input that takes data becomes a data input automatically. Give each one a clear label.
    </p>
    ${rows || `<div class="guided__empty">No recipe inputs yet. Every value comes from another step.</div>`}`;
}

function guidedResultStageHtml(model, issues) {
  const options = model.steps.flatMap((s) =>
    [...new Set([...s.outNames, ...s.runOutputs.map((o) => o.name)])].map((out) => {
      const value = `${s.name}/${out}`;
      const type = s.runOutputs.find((o) => o.name === out)?.type;
      return `<label class="guided-check"><input type="checkbox" data-result="${escapeHtml(value)}" ${model.resultSources.has(value) ? "checked" : ""} />
        <span><code>${escapeHtml(out)}</code>, from step "${escapeHtml(s.name)}" <small>${escapeHtml(friendlyType(type))}</small></span></label>`;
    })
  );
  const overview = model.steps
    .map(
      (s) => `<li><b>${escapeHtml(s.toolName || s.name)}</b> <code>${escapeHtml(s.name)}</code>${
        s.inputs.length
          ? `, using ${s.inputs
              .map((i) => {
                const asked = model.recipeInputs.find((r) => r.name === i.value);
                const from =
                  i.status === "recipe"
                    ? `the user's "${escapeHtml(asked?.label || i.value)}"`
                    : i.status === "step"
                      ? `the result of "${escapeHtml(i.value.split("/")[0])}"`
                      : `<i>nothing yet</i>`;
                return `${escapeHtml(i.name)} ← ${from}`;
              })
              .join(", ")}`
          : ""
      }</li>`
    )
    .join("");
  return `
    <p class="guided__intro">Choose what the recipe hands back when it finishes. This is usually the result of the last tool.</p>
    <div class="guided-card">${options.join("") || `<div class="guided__empty">No tool gives anything back yet.</div>`}</div>
    <h4 class="guided__subhead">Overview</h4>
    <ol class="guided__overview">${overview || "<li>No tools yet.</li>"}</ol>
    <h4 class="guided__subhead">Still to do</h4>
    ${
      issues.length
        ? `<ul class="block-form__issues">${issues.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`
        : `<p class="guided__intro" style="margin:0;">Nothing. Every tool is chosen and every value is connected.</p>`
    }
    <div class="guided__actions">
      <button type="button" class="btn btn-secondary btn-sm" data-guided-action="validate">Check the recipe</button>
      <span class="guided__hint">Once the check passes, <b>Save Recipe</b> (top right) is enabled.</span>
    </div>`;
}

// ---------------------------------------------------------------------------
// Recipe diagram — the right half of the split view
// ---------------------------------------------------------------------------
// A live node-link picture of the CWL on the left (same renderer as the
// Recipe Schema on the details page): recipe inputs → steps → result. Every
// box is clickable and opens an inspector underneath that edits the CWL
// through the same helpers as the Guided builder; moving the caret in the
// CWL selects the matching box. Both directions go through the textarea's
// text, so neither side can drift from the other.

const DIAGRAM_KIND_LABELS = { input: "Recipe inputs", tool: "Steps", output: "Result" };

// --- Alternative tools (nldt:compatibleTools) ------------------------------
// The recipe owner's per-step allowlist of other tools a hub may run instead
// of the step's own tool when it uses the recipe (the Wizard's Tool & Engine
// step; enforced by cookbook-registry's apply_tool_overrides). Stored as
// `nldt:compatibleTools: {step: [ownTool, ...alternatives]}`; a step with no
// entry always runs its own tool.

/** The tools `stepName` may be swapped for (its own tool excluded). */
function stepAlternatives(text, step) {
  return (parseCompatibleTools(text)[step.name] || []).filter((id) => id !== step.idValue);
}

/** Writes `stepName`'s alternatives — the step's own tool first, as the
 * allowlist format expects — or drops its entry when there are none. */
function setStepAlternatives(text, stepName, ownToolId, alternativeIds) {
  const map = parseCompatibleTools(text);
  if (alternativeIds.length) map[stepName] = [...new Set([ownToolId, ...alternativeIds].filter(Boolean))];
  else delete map[stepName];
  return writeCompatibleTools(text, map);
}

/** How well `tool` could stand in for `step`'s current tool, in words: does
 * it hand back the same kind of result (so later steps keep working), and
 * does it need values the step doesn't have yet (which the platform then
 * asks the user for when the recipe runs). */
function alternativeFitHtml(step, tool) {
  const sameResult =
    tool.outputs.length === step.runOutputs.length &&
    tool.outputs.every((o, i) => shortType(o.type) === shortType(step.runOutputs[i]?.type));
  const extra = tool.inputs.length - step.runInputs.length;
  const notes = [
    sameResult
      ? `<span class="guided-chip guided-chip--ok">Same kind of result</span>`
      : `<span class="guided-chip guided-chip--todo">Different result: later steps may need reconnecting</span>`,
  ];
  if (extra > 0) notes.push(`<span class="guided-chip guided-chip--info">Needs ${extra} more value${extra === 1 ? "" : "s"}, asked when run</span>`);
  return notes.join(" ");
}

/** The "Alternative tools" section for one step — shared by the diagram's
 * step inspector and the Guided builder's Tools stage. */
function alternativesSectionHtml(text, step) {
  const chosen = new Set(stepAlternatives(text, step));
  const candidates = TOOL_CATALOG.filter((t) => t.id !== step.idValue);
  const list = candidates
    .map(
      (t) => `
      <label class="alt-tool">
        <input type="checkbox" data-alt-step="${escapeHtml(step.name)}" data-alt-own="${escapeHtml(step.idValue || "")}" value="${escapeHtml(t.id)}" ${chosen.has(t.id) ? "checked" : ""} />
        <span class="alt-tool__body">
          <b>${escapeHtml(t.label)}</b>
          <small>Needs ${t.inputs.map((i) => escapeHtml(i.name)).join(", ") || "nothing"} · gives back ${t.outputs.map((o) => escapeHtml(o.name)).join(", ") || "nothing"}</small>
          <span class="alt-tool__fit">${alternativeFitHtml(step, t)}</span>
        </span>
      </label>`
    )
    .join("");
  return `
    <p class="guided__intro" style="margin:0;">
      Other tools a hub may run <b>instead of</b> this one when it uses the recipe (it picks one on
      the Wizard's <i>Tool &amp; Engine</i> step). Leave everything unticked to always use the tool above.
    </p>
    <div class="alt-tools">${list || `<div class="guided-card__io">No other tools in the catalog.</div>`}</div>
    <p class="alt-tools__note">
      Demo: these are the Sandbox Stack's own tools. On the platform, this list is the applications
      registered in its catalog. <a href="#" data-alt-browse="${escapeHtml(step.name)}">Browse the catalog…</a>
    </p>`;
}

/** Hooks the alternatives checkboxes (and "Browse the catalog…") inside `el`
 * up to the CWL. */
function wireAlternatives(el, textarea, commit) {
  el.querySelectorAll("[data-alt-step]").forEach((cb) =>
    cb.addEventListener("change", () => {
      const stepName = cb.dataset.altStep;
      const ids = [...el.querySelectorAll(`[data-alt-step="${CSS.escape(stepName)}"]:checked`)].map((c) => c.value);
      commit(setStepAlternatives(textarea.value, stepName, cb.dataset.altOwn, ids));
    })
  );
  el.querySelectorAll("[data-alt-browse]").forEach((link) =>
    link.addEventListener("click", (e) => {
      e.preventDefault();
      openCompatibleAppsModal(textarea, link.dataset.altBrowse);
    })
  );
}

/** The "Recipe details" form — the CWL standard's required parts as a
 * checklist (with a one-click fix), then the recommended name / identifier /
 * description. Shared by the diagram's inspector and the Guided builder's
 * first stage; wired by wireRecipeDetailsForm. `recipeId` is the id the
 * recipe is actually saved under, which the CWL's own `id` should match. */
function recipeDetailsFormHtml(text, recipeId) {
  const header = parseCwlHeader(text);
  const parts = cwlRequiredParts(text);
  const missing = parts.filter((p) => p.required && !p.ok);
  const shown = (p) => {
    if (p.key === "cwlVersion" || p.key === "class") return header[p.key]?.value ? `${p.key}: ${header[p.key].value}` : `${p.key}: missing`;
    return p.ok ? `${p.key}:` : `${p.key}: missing`;
  };
  const cwlId = header.id?.value || "";
  return `
    <div class="diagram-inspector__section">What the CWL standard requires</div>
    <ul class="cwl-parts">
      ${parts
        .filter((p) => p.required)
        .map(
          (p) => `
        <li class="${p.ok ? "is-ok" : "is-missing"}">
          <span class="cwl-parts__mark" aria-hidden="true">${p.ok ? "✓" : "!"}</span>
          <span><b>${escapeHtml(p.label)}</b> <code>${escapeHtml(shown(p))}</code><small>${escapeHtml(p.hint)}</small></span>
        </li>`
        )
        .join("")}
    </ul>
    ${
      missing.length
        ? `<div class="guided__actions"><button type="button" class="btn btn-secondary btn-sm" data-details-fix>Add the missing part${missing.length === 1 ? "" : "s"}</button>
           <span class="guided__hint">Writes the standard defaults into the CWL. Nothing else changes.</span></div>`
        : ""
    }
    <div class="diagram-inspector__section">About this recipe (recommended)</div>
    <label class="guided-field"><span>Name <code>label</code></span>
      <input type="text" data-header="label" value="${escapeHtml(header.label?.value || "")}" placeholder="e.g. Boundary buffer" />
    </label>
    <label class="guided-field"><span>Identifier <code>id</code></span>
      <input type="text" data-header="id" value="${escapeHtml(cwlId)}" placeholder="${escapeHtml(recipeId || "e.g. boundary-buffer")}" />
      <small data-details-id-error></small>
    </label>
    ${
      recipeId && cwlId && cwlId !== recipeId
        ? `<div class="notice-banner" style="margin:0;">This recipe is saved as <b>${escapeHtml(recipeId)}</b>, but its CWL says <b>${escapeHtml(cwlId)}</b>.
             <button type="button" class="btn btn-outline btn-sm" data-details-use-id style="margin-left:6px;">Use ${escapeHtml(recipeId)}</button></div>`
        : ""
    }
    <label class="guided-field"><span>Description <code>doc</code></span>
      <textarea data-header="doc" rows="4" placeholder="What does this recipe do, and for whom?">${escapeHtml(header.doc?.value || "")}</textarea>
    </label>`;
}

function wireRecipeDetailsForm(el, textarea, commit, recipeId) {
  el.querySelector("[data-details-fix]")?.addEventListener("click", () => commit(addMissingRequiredParts(textarea.value)));
  el.querySelector("[data-details-use-id]")?.addEventListener("click", () => commit(setHeaderField(textarea.value, "id", recipeId)));
  el.querySelectorAll("[data-header]").forEach((field) =>
    field.addEventListener("change", () => {
      const key = field.dataset.header;
      const value = field.value.trim();
      if (key === "id" && value && !/^[A-Za-z0-9_.-]+$/.test(value)) {
        el.querySelector("[data-details-id-error]").textContent = "Letters, digits, '.', '-' and '_' only.";
        return;
      }
      commit(setHeaderField(textarea.value, key, value));
    })
  );
}

/** friendlyType without its parenthetical examples — short enough for a node's sublabel. */
function shortType(type) {
  return friendlyType(type).replace(/, e\.g\..*$/, "");
}

function diagramGraph(text, model) {
  const nodes = [];
  const edges = [];
  const seen = new Set();
  const edge = (from, to) => {
    if (seen.has(`${from}>${to}`)) return;
    seen.add(`${from}>${to}`);
    edges.push({ from, to });
  };
  model.recipeInputs.forEach((r) =>
    nodes.push({
      id: `in:${r.name}`,
      kind: "input",
      label: escapeHtml(r.label || r.name),
      sublabel: escapeHtml(inputKindLabel(r)),
      status: r.usedBy.length ? "default" : "pending",
    })
  );
  model.steps.forEach((s) => {
    const broken = !s.hasTool || s.inputs.some((i) => i.status === "broken");
    const missing = s.inputs.some((i) => i.status === "missing");
    const label = s.toolName || "Choose a tool";
    // Keeps boxes narrow: the step's own name only when it adds something
    // beyond the tool's name ("Centroid · centroid" says nothing twice).
    const squash = (v) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
    // "⇄ 2": this step has two alternative tools a hub may swap in.
    const alternatives = stepAlternatives(text, s).length;
    const sub = [squash(label) === squash(s.name) ? "" : escapeHtml(s.name), alternatives ? `⇄ ${alternatives}` : ""].filter(Boolean);
    nodes.push({
      id: `step:${s.name}`,
      kind: "tool",
      label: escapeHtml(label),
      sublabel: sub.join(" · "),
      status: broken ? "blocked" : missing ? "pending" : "default",
    });
    s.inputs.forEach((i) => {
      if (i.status === "recipe") edge(`in:${i.value}`, `step:${s.name}`);
      else if (i.status === "step") edge(`step:${i.value.split("/")[0]}`, `step:${s.name}`);
    });
  });
  const stepNames = new Set(model.steps.map((s) => s.name));
  parseCwlTopLevel(text).outputs.forEach((o) => {
    const fromStep = (o.outputSource || "").split("/")[0];
    const valid = stepNames.has(fromStep);
    nodes.push({ id: `out:${o.name}`, kind: "output", label: escapeHtml(o.name), status: valid ? "default" : "blocked" });
    if (valid) edge(`step:${fromStep}`, `out:${o.name}`);
  });
  return { nodes, edges };
}

/** "step:add" → ["step", "add"]. */
function splitNodeId(nodeId) {
  const i = nodeId.indexOf(":");
  return [nodeId.slice(0, i), nodeId.slice(i + 1)];
}

/** The CWL line a diagram node is defined on (-1 if not found). */
function nodeLine(text, nodeId) {
  const [kind, name] = splitNodeId(nodeId);
  if (kind === "meta") return 0;
  if (kind === "step") return parseCwlSteps(text).find((s) => s.name === name)?.start ?? -1;
  const top = parseCwlTopLevel(text);
  const [start, end] = kind === "in" ? [top.inputsStart, top.inputsEnd] : [top.outputsStart, top.outputsEnd];
  if (start === -1) return -1;
  return topLevelEntryRange(text.split("\n"), start, end, name)?.[0] ?? -1;
}

/** The diagram node whose definition contains CWL line `line`, if any. */
function lineNode(text, line) {
  if (Object.values(parseCwlHeader(text)).some((h) => line >= h.start && line < h.end)) return "meta:";
  const step = parseCwlSteps(text).find((s) => line >= s.start && line < s.end);
  if (step) return `step:${step.name}`;
  const top = parseCwlTopLevel(text);
  const lines = text.split("\n");
  const blocks = [
    ["in", top.inputsStart, top.inputsEnd, top.inputs],
    ["out", top.outputsStart, top.outputsEnd, top.outputs],
  ];
  for (const [kind, start, end, entries] of blocks) {
    if (start === -1 || line <= start || line >= end) continue;
    for (const entry of entries) {
      const range = topLevelEntryRange(lines, start, end, entry.name);
      if (range && line >= range[0] && line < range[1]) return `${kind}:${entry.name}`;
    }
  }
  return null;
}

function diagramStepInspectorHtml(text, model, step) {
  const toolOptions = [
    ...(!step.hasTool ? [`<option value="" selected disabled>Choose a tool…</option>`] : []),
    ...(step.hasTool && !step.tool ? [`<option value="" selected>${escapeHtml(step.toolName)} (external process)</option>`] : []),
    ...TOOL_CATALOG.map((t) => `<option value="${escapeHtml(t.id)}" ${step.tool && step.tool.id === t.id ? "selected" : ""}>${escapeHtml(t.label)}</option>`),
  ].join("");
  const outputs = [...new Set([...step.outNames, ...step.runOutputs.map((o) => o.name)])];
  return `
    <div class="diagram-inspector__head">
      <span class="guided-card__num">Step</span>
      <b>${escapeHtml(step.toolName || "No tool yet")}</b>
      <code>${escapeHtml(step.name)}</code>
    </div>
    <label class="guided-field"><span>Tool (OGC API Process)</span>
      <select data-insp-tool="${escapeHtml(step.name)}">${toolOptions}</select>
    </label>
    <div class="diagram-inspector__section">Alternative tools (optional)</div>
    ${alternativesSectionHtml(text, step)}
    <div class="diagram-inspector__section">Needs, and where each value comes from</div>
    ${
      step.inputs.length
        ? step.inputs
            .map(
              (i) => `
          <div class="guided-row guided-row--compact">
            <div class="guided-row__what"><code>${escapeHtml(i.name)}</code><small>${escapeHtml(shortType(i.type))}</small></div>
            <div class="guided-row__arrow" aria-hidden="true">←</div>
            <select data-connect-step="${escapeHtml(step.name)}" data-connect-input="${escapeHtml(i.name)}" data-connect-type="${escapeHtml(i.type)}" data-connect-format="${escapeHtml(i.format || "")}">
              ${guidedSourceOptionsHtml(model, step, i)}
            </select>
          </div>`
            )
            .join("")
        : `<div class="guided-card__io">Nothing. This tool needs no values.</div>`
    }
    <div class="diagram-inspector__section">Gives back</div>
    ${
      outputs.length
        ? outputs
            .map((out) => {
              const source = `${step.name}/${out}`;
              const type = step.runOutputs.find((o) => o.name === out)?.type;
              return `<label class="guided-check"><input type="checkbox" data-insp-result="${escapeHtml(source)}" ${model.resultSources.has(source) ? "checked" : ""} />
                <span><code>${escapeHtml(out)}</code> <small>${escapeHtml(shortType(type))}</small>: use as the recipe's result</span></label>`;
            })
            .join("")
        : `<div class="guided-card__io">Nothing declared.</div>`
    }
    <div class="guided__actions">
      <button type="button" class="btn btn-outline btn-sm" data-insp-reveal>Show in CWL</button>
      <button type="button" class="btn btn-outline btn-sm" data-insp-remove-step="${escapeHtml(step.name)}">Remove step</button>
    </div>`;
}

function diagramInputInspectorHtml(input) {
  return `
    <div class="diagram-inspector__head">
      <span class="guided-card__num">Recipe input</span>
      <b>${escapeHtml(input.label || input.name)}</b>
      <code>${escapeHtml(input.name)}</code>
    </div>
    <p class="guided__intro" style="margin:0;">${
      isFileType(input.type)
        ? `A dataset the person running the recipe picks from the Data Catalogue (${escapeHtml(inputKindLabel(input))}).`
        : `A value the person running the recipe fills in (${escapeHtml(friendlyType(input.type))}).`
    }</p>
    <label class="guided-field"><span>Label shown to the user</span>
      <input type="text" data-input-label="${escapeHtml(input.name)}" value="${escapeHtml(input.label || "")}" placeholder="e.g. ${escapeHtml(input.name)}" />
    </label>
    ${dataInputControlsHtml(input)}
    <div class="guided-card__io"><span class="guided-label">Used by</span> ${input.usedBy.length ? input.usedBy.map(escapeHtml).join(", ") : "<i>no step yet</i>"}</div>
    <div class="guided__actions">
      <button type="button" class="btn btn-outline btn-sm" data-insp-reveal>Show in CWL</button>
      ${input.usedBy.length ? "" : `<button type="button" class="btn btn-outline btn-sm" data-remove-input="${escapeHtml(input.name)}">Remove</button>`}
    </div>`;
}

function diagramOutputInspectorHtml(model, output) {
  const options = model.steps
    .flatMap((s) => [...new Set([...s.outNames, ...s.runOutputs.map((o) => o.name)])].map((out) => `${s.name}/${out}`))
    .map((src) => `<option value="${escapeHtml(src)}" ${src === output.outputSource ? "selected" : ""}>${escapeHtml(src.split("/")[1])}, from step "${escapeHtml(src.split("/")[0])}"</option>`)
    .join("");
  return `
    <div class="diagram-inspector__head">
      <span class="guided-card__num">Recipe result</span>
      <b>${escapeHtml(output.name)}</b>
    </div>
    <p class="guided__intro" style="margin:0;">What the recipe hands back when it finishes.</p>
    <label class="guided-field"><span>Taken from</span>
      <select data-insp-output-source="${escapeHtml(output.name)}">
        ${options.includes("selected") ? "" : `<option value="" selected disabled>${escapeHtml(output.outputSource || "nothing")} (not found)</option>`}
        ${options}
      </select>
    </label>
    <div class="guided__actions">
      <button type="button" class="btn btn-outline btn-sm" data-insp-reveal>Show in CWL</button>
      <button type="button" class="btn btn-outline btn-sm" data-insp-remove-output="${escapeHtml(output.name)}">Remove from results</button>
    </div>`;
}

function diagramOverviewHtml(text) {
  const issues = recipeIssues(text);
  return `
    <p class="guided__intro" style="margin:0;">
      <b>Click any box</b> to configure it, or move the cursor in the CWL on the left. Every change
      here is written into the CWL, and every edit there redraws this diagram.
    </p>
    <div class="diagram-legend">
      <span><i class="diagram-legend__dot"></i>Ready</span>
      <span><i class="diagram-legend__dot is-pending"></i>Something still to connect</span>
      <span><i class="diagram-legend__dot is-blocked"></i>Broken or missing a tool</span>
    </div>
    ${
      issues.length
        ? `<div class="diagram-inspector__section">Still to do</div><ul class="block-form__issues">${issues.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`
        : ""
    }`;
}

/** The clickable "Recipe details" card above the graph: the recipe's name
 * and id, and how many required CWL parts are still missing. */
function recipeMetaCardHtml(text, selected) {
  const header = parseCwlHeader(text);
  const missing = cwlRequiredParts(text).filter((p) => p.required && !p.ok).length;
  return `
    <button type="button" class="recipe-meta-card ${selected ? "is-selected" : ""}" data-diagram-meta>
      <span class="recipe-meta-card__icon" aria-hidden="true">i</span>
      <span class="recipe-meta-card__text">
        <b>${escapeHtml(header.label?.value || "Untitled recipe")}</b>
        <small>${escapeHtml(header.id?.value || "no id")} · CWL ${escapeHtml(header.cwlVersion?.value || "?")} ${escapeHtml(header.class?.value || "")} · click for Recipe details</small>
      </span>
      ${
        missing
          ? `<span class="guided-chip guided-chip--todo">${missing} required part${missing === 1 ? "" : "s"} missing</span>`
          : `<span class="guided-chip guided-chip--ok">CWL basics complete</span>`
      }
    </button>`;
}

/** Renders the diagram + inspector into `paneEl` from `textarea`'s CWL.
 * `ctx.state.selected` (a node id) survives re-renders; `ctx.reveal(line)`
 * scrolls the CWL editor to a line; `ctx.onSelect(nodeId)` lets the editor
 * mirror the selection (its step box highlight). */
function renderRecipeDiagram(paneEl, textarea, ctx) {
  const text = textarea.value;
  const model = guidedModel(text);
  const graph = diagramGraph(text, model);
  // "meta:" is the Recipe details card above the graph, not a graph node.
  if (ctx.state.selected && ctx.state.selected !== "meta:" && !graph.nodes.some((n) => n.id === ctx.state.selected)) {
    ctx.state.selected = null;
  }
  const selected = ctx.state.selected;
  const commit = (next) => {
    textarea.value = next;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  };

  let inspector = diagramOverviewHtml(text);
  if (selected) {
    const [kind, name] = splitNodeId(selected);
    if (kind === "meta") {
      inspector = `<div class="diagram-inspector__head"><span class="guided-card__num">Recipe</span><b>Recipe details</b></div>
        ${recipeDetailsFormHtml(text, ctx.recipeId)}`;
    } else if (kind === "step") inspector = diagramStepInspectorHtml(text, model, model.steps.find((s) => s.name === name));
    else if (kind === "in") inspector = diagramInputInspectorHtml(model.recipeInputs.find((r) => r.name === name));
    else inspector = diagramOutputInspectorHtml(model, parseCwlTopLevel(text).outputs.find((o) => o.name === name));
  }

  paneEl.innerHTML = `
    <div class="recipe-diagram__head">
      <div>
        <b>Recipe diagram</b>
        <small>${model.steps.length} step${model.steps.length === 1 ? "" : "s"} · live from the CWL</small>
      </div>
      <button type="button" class="btn btn-secondary btn-sm" data-diagram-add>+ Add a step</button>
    </div>
    ${recipeMetaCardHtml(text, selected === "meta:")}
    ${
      graph.nodes.length
        ? `<div class="recipe-diagram__graph">${graphHtml(graph, { kindLabels: DIAGRAM_KIND_LABELS })}</div>`
        : `<div class="guided__empty">Nothing to draw yet. Paste a CWL recipe on the left, or <b>+ Add a step</b>.</div>`
    }
    <div class="diagram-inspector">
      ${selected ? `<button type="button" class="diagram-inspector__close" data-diagram-deselect aria-label="Close">${icons.close}</button>` : ""}
      ${inspector}
    </div>`;

  const root = paneEl.querySelector("[data-graph-root]");
  if (root) {
    drawGraphConnectors(root, graph.edges);
    paneEl._redraw = () => drawGraphConnectors(root, graph.edges);
    root.querySelectorAll("[data-node]").forEach((nodeEl) => {
      nodeEl.tabIndex = 0;
      nodeEl.classList.toggle("is-selected", nodeEl.dataset.node === selected);
      const choose = () => {
        ctx.state.selected = nodeEl.dataset.node;
        renderRecipeDiagram(paneEl, textarea, ctx);
        const line = nodeLine(textarea.value, nodeEl.dataset.node);
        if (line !== -1) ctx.reveal(line);
      };
      nodeEl.addEventListener("click", choose);
      nodeEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          choose();
        }
      });
    });
  } else {
    paneEl._redraw = null;
  }
  ctx.onSelect(selected);

  paneEl.querySelector("[data-diagram-add]").addEventListener("click", () => openAddStepModal(textarea, ctx.resultEl));
  paneEl.querySelector("[data-diagram-meta]").addEventListener("click", () => {
    ctx.state.selected = "meta:";
    renderRecipeDiagram(paneEl, textarea, ctx);
    ctx.reveal(0);
  });
  wireRecipeDetailsForm(paneEl, textarea, commit, ctx.recipeId);
  paneEl.querySelector("[data-diagram-deselect]")?.addEventListener("click", () => {
    ctx.state.selected = null;
    renderRecipeDiagram(paneEl, textarea, ctx);
  });
  paneEl.querySelector("[data-insp-reveal]")?.addEventListener("click", () => {
    const line = nodeLine(textarea.value, selected);
    if (line !== -1) ctx.reveal(line);
  });

  wireConnectSelects(paneEl, textarea, commit);
  wireAlternatives(paneEl, textarea, commit);
  paneEl.querySelector("[data-insp-tool]")?.addEventListener("change", (e) => {
    const tool = findTool(e.target.value);
    if (tool) applyToolToStep(textarea, e.target.dataset.inspTool, tool);
  });
  paneEl.querySelectorAll("[data-insp-result]").forEach((cb) =>
    cb.addEventListener("change", () => {
      const chosen = new Set(model.resultSources);
      if (cb.checked) chosen.add(cb.dataset.inspResult);
      else chosen.delete(cb.dataset.inspResult);
      commit(writeWorkflowOutputs(textarea.value, workflowOutputsFor(textarea.value, [...chosen])));
    })
  );
  paneEl.querySelector("[data-insp-remove-step]")?.addEventListener("click", (e) => {
    const name = e.target.dataset.inspRemoveStep;
    if (!confirm(`Remove step "${name}"? Anything connected to its result will need connecting again.`)) return;
    ctx.state.selected = null;
    commit(removeStep(textarea.value, name));
  });
  paneEl.querySelector("[data-input-label]")?.addEventListener("change", (e) =>
    commit(setWorkflowInputLabel(textarea.value, e.target.dataset.inputLabel, e.target.value.trim()))
  );
  paneEl.querySelector("[data-remove-input]")?.addEventListener("click", (e) => {
    ctx.state.selected = null;
    commit(removeWorkflowInput(textarea.value, e.target.dataset.removeInput));
  });
  wireDataInputControls(paneEl, textarea, commit);

  // Result edits keep every other output exactly as it is (name, type).
  const outputs = parseCwlTopLevel(text).outputs;
  const writeOutputs = (list) =>
    commit(writeWorkflowOutputs(textarea.value, list.map((o) => ({ name: o.name, type: o.type, source: o.outputSource || '""' }))));
  paneEl.querySelector("[data-insp-output-source]")?.addEventListener("change", (e) => {
    const src = e.target.value;
    const [st, out] = src.split("/");
    const type = model.steps.find((s) => s.name === st)?.runOutputs.find((o) => o.name === out)?.type || "Any";
    writeOutputs(outputs.map((o) => (o.name === e.target.dataset.inspOutputSource ? { ...o, type, outputSource: src } : o)));
  });
  paneEl.querySelector("[data-insp-remove-output]")?.addEventListener("click", (e) => {
    ctx.state.selected = null;
    writeOutputs(outputs.filter((o) => o.name !== e.target.dataset.inspRemoveOutput));
  });
}

/** Writes one "where does this value come from" choice (see
 * guidedSourceOptionsHtml) into the CWL: a recipe input's name, a
 * `step/output`, nothing (back to not connected), or ASK_WHEN_RUN — a new
 * recipe input, named after the step input itself (the clearest default),
 * made unique if that name is already taken. */
function applyConnectChoice(text, stepName, inputName, type, choice, format = null) {
  if (choice !== ASK_WHEN_RUN) return setStepInput(text, stepName, inputName, choice || UNCONNECTED_VALUE);
  const taken = new Set(parseCwlTopLevel(text).inputs.map((i) => i.name));
  let name = inputName;
  if (taken.has(name)) name = `${stepName}_${inputName}`.replace(/-/g, "_");
  for (let n = 2; taken.has(name); n++) name = `${inputName}_${n}`;
  // A tool input that takes data (`File` + format) makes the new recipe
  // input a data input too, in the same format.
  return addWorkflowInput(setStepInput(text, stepName, inputName, name), name, type, isFileType(type) ? format || null : null);
}

/** Hooks every `[data-connect-step]` source dropdown inside `el` up to
 * applyConnectChoice. */
function wireConnectSelects(el, textarea, commit) {
  el.querySelectorAll("[data-connect-step]").forEach((sel) =>
    sel.addEventListener("change", () => {
      const { connectStep, connectInput, connectType, connectFormat } = sel.dataset;
      commit(applyConnectChoice(textarea.value, connectStep, connectInput, connectType, sel.value, connectFormat || null));
    })
  );
}

/** Renders the Guided builder into `el` from `textarea`'s current CWL, and
 * wires every control to write back into it. `ctx.state.stage` survives
 * re-renders (each edit re-renders from the new text, via the textarea's
 * own "input" listener). */
function renderGuidedBuilder(el, textarea, ctx) {
  const model = guidedModel(textarea.value);
  const stage = ctx.state.stage;
  const stageIdx = GUIDED_STAGES.findIndex((s) => s.key === stage);
  const commit = (text) => {
    textarea.value = text;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  };

  let body = "";
  if (stage === "details") {
    body = `
      <p class="guided__intro">
        Every recipe is a CWL document, and the CWL standard asks for a few things at the top
        before any tool: which version of the standard it follows, that it is a
        <i>workflow</i>, and sections for its inputs, outputs and steps. Below that, give the
        recipe a name and a short description so people can find it.
      </p>
      <div class="guided-card">${recipeDetailsFormHtml(textarea.value, ctx.recipeId)}</div>`;
  } else if (stage === "tools") body = guidedToolsStageHtml(textarea.value, model);
  else if (stage === "connect") body = guidedConnectStageHtml(model);
  else if (stage === "inputs") body = guidedInputsStageHtml(model);
  else body = guidedResultStageHtml(model, recipeIssues(textarea.value));

  el.innerHTML = `
    <ol class="guided__stepper">
      ${GUIDED_STAGES.map(
        (s, i) => `
        <li>
          <button type="button" class="guided__stage ${s.key === stage ? "is-active" : ""} ${model.stageDone[s.key] ? "is-done" : ""}" data-stage="${s.key}">
            <span class="guided__num">${model.stageDone[s.key] ? "✓" : i + 1}</span>
            <span class="guided__stage-text"><b>${s.title}</b><small>${s.hint}</small></span>
          </button>
        </li>`
      ).join("")}
    </ol>
    <div class="guided__body">${body}</div>
    <div class="guided__nav">
      ${stageIdx > 0 ? `<button type="button" class="btn btn-outline btn-sm" data-stage="${GUIDED_STAGES[stageIdx - 1].key}">← Back</button>` : "<span></span>"}
      ${stageIdx < GUIDED_STAGES.length - 1 ? `<button type="button" class="btn btn-primary btn-sm" data-stage="${GUIDED_STAGES[stageIdx + 1].key}">Next: ${GUIDED_STAGES[stageIdx + 1].title} →</button>` : ""}
    </div>`;

  el.querySelectorAll("[data-stage]").forEach((btn) =>
    btn.addEventListener("click", () => {
      ctx.state.stage = btn.dataset.stage;
      renderGuidedBuilder(el, textarea, ctx);
      el.scrollIntoView({ block: "nearest" });
    })
  );

  const action = (name) => el.querySelector(`[data-guided-action="${name}"]`);
  action("add-catalog")?.addEventListener("click", () => openAddStepModal(textarea, ctx.resultEl));
  action("add-url")?.addEventListener("click", () => openAddStepFromUrlModal(textarea, ctx.resultEl));
  action("validate")?.addEventListener("click", () => ctx.validateBtn.click());

  el.querySelectorAll("[data-remove-step]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const name = btn.dataset.removeStep;
      if (confirm(`Remove step "${name}"? Anything connected to its result will need connecting again.`)) {
        commit(removeStep(textarea.value, name));
      }
    })
  );
  el.querySelectorAll("[data-pick-tool]").forEach((sel) =>
    sel.addEventListener("change", () => {
      const tool = findTool(sel.value);
      if (tool) applyToolToStep(textarea, sel.dataset.pickTool, tool);
    })
  );

  wireConnectSelects(el, textarea, commit);
  wireRecipeDetailsForm(el, textarea, commit, ctx.recipeId);
  wireAlternatives(el, textarea, commit);

  el.querySelectorAll("[data-input-label]").forEach((input) =>
    input.addEventListener("change", () => commit(setWorkflowInputLabel(textarea.value, input.dataset.inputLabel, input.value.trim())))
  );
  el.querySelectorAll("[data-remove-input]").forEach((btn) =>
    btn.addEventListener("click", () => commit(removeWorkflowInput(textarea.value, btn.dataset.removeInput)))
  );
  wireDataInputControls(el, textarea, commit);

  el.querySelectorAll("[data-result]").forEach((cb) =>
    cb.addEventListener("change", () => {
      const chosen = [...el.querySelectorAll("[data-result]:checked")].map((c) => c.dataset.result);
      commit(writeWorkflowOutputs(textarea.value, workflowOutputsFor(textarea.value, chosen)));
    })
  );
}

function toolIoSummaryHtml(tool) {
  if (!tool) return `<i>Unknown tool — no schema available.</i>`;
  const ins = tool.inputs.map((i) => `${i.name} (${i.type})`).join(", ") || "—";
  const outs = tool.outputs.map((o) => `${o.name} (${o.type})`).join(", ") || "—";
  const url = toolProcessUrl(tool.id);
  const link = url ? `<br /><a href="${url}" target="_blank" rel="noopener">View live process ↗</a>` : "";
  return `<b>In:</b> ${ins}<br /><b>Out:</b> ${outs}${link}`;
}

const PADDING_TOP = 16;
const LINE_HEIGHT = 19.2; // 0.8rem * 1.5 line-height, at the 16px root font-size

// Where the actual code text starts, horizontally — the line-number gutter's
// own width (44px, see .code-editor__gutter) plus the original 18px text
// inset — kept as one constant so the indent guides' own `left` (see
// renderIndentGuides) can never drift out of sync with .code-editor__input's
// / .code-editor__highlight's own padding-left in styles.css, which MUST
// match this value exactly.
const TEXT_LEFT = 62;

// One colour per step, cycled, so adjacent steps' boxes don't blur together.
const STEP_COLORS = [
  "127,208,230", // cyan
  "240,201,135", // amber
  "226,147,196", // pink
  "154,211,159", // green
  "180,160,255", // violet
  "255,150,150", // coral
];

function lineTop(lineIndex, scrollTop) {
  return PADDING_TOP + lineIndex * LINE_HEIGHT - scrollTop;
}

/** Draws a barely-visible coloured box around every step's whole
 * `run:`/`in:`/`out:` block — marking "this is one tool's configuration",
 * distinct per step so adjacent steps don't blur together; the recipe
 * diagram's selection highlights the matching one. Rebuilt from scratch on
 * every edit (cheap at this document size) so it never drifts from the
 * actual CWL text. The parsed steps are kept on `boxesEl._steps` for the
 * scroll/layout passes below. */
function renderStepBoxes(boxesEl, textarea) {
  const steps = parseCwlSteps(textarea.value);
  boxesEl.innerHTML = "";
  boxesEl._steps = steps;

  steps.forEach((step, idx) => {
    const rgb = STEP_COLORS[idx % STEP_COLORS.length];
    const box = document.createElement("div");
    box.className = "step-frame-box";
    box.dataset.step = step.name;
    box.style.top = `${lineTop(step.start, textarea.scrollTop) - 3}px`;
    box.style.transform = `translateX(${-textarea.scrollLeft}px)`;
    // From 3px above the first line to 4px below the last: the step now ends
    // at its last code line, so the border must clear that line's text.
    box.style.height = `${(step.end - step.start) * LINE_HEIGHT + 7}px`;
    box.style.borderColor = `rgba(${rgb},.4)`;
    // No background fill: a guide band's colour depends only on its nesting
    // depth (see INDENT_GUIDE_COLORS above), and a fill across the step
    // would tint every guide under it, so the same depth would look different
    // in different steps. An outline is enough to mark one tool's block.
    boxesEl.appendChild(box);
  });
}

/** Cheap scroll-linked reposition — reuses the steps parsed by the last
 * renderStepBoxes() rather than re-parsing the whole document on every
 * scroll tick. */
function repositionStepBoxes(boxesEl, textarea) {
  const steps = boxesEl._steps || [];
  for (const el of boxesEl.children) {
    const step = steps.find((s) => s.name === el.dataset.step);
    if (!step) continue;
    el.style.top = `${lineTop(step.start, textarea.scrollTop) - 3}px`;
    el.style.transform = `translateX(${-textarea.scrollLeft}px)`;
  }
}

// Horizontal geometry of the step boxes — see .step-frame-box in styles.css.
const BOX_LEFT = 50;
const BOX_MIN_WIDTH = 160; // only a floor for very short steps — boxes hug the code
const BOX_TEXT_PAD = 12; // breathing room between a box's longest line and its right border

let measuredCharWidth = 0;
/** The editor font's advance width, in px — every line is plain monospace
 * text, so a line's rendered width is just its length times this. */
function charWidth(textarea) {
  if (measuredCharWidth) return measuredCharWidth;
  const style = getComputedStyle(textarea);
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.font = `${style.fontSize} ${style.fontFamily}`;
  const width = ctx.measureText("0".repeat(100)).width / 100;
  if (width > 0 && style.fontSize) measuredCharWidth = width;
  return width || 7.7;
}

/** Sizes everything that depends on how long the CWL's lines actually are:
 * every step box is exactly as wide as the steps' longest *code* (comments
 * excluded — they're aligned just outside it, see alignStepComments), so a
 * long href never runs out of its frame — the text scrolls horizontally
 * instead. Re-run on every edit and on every resize of the editor. */
function layoutEditor({ textarea, highlightEl, guidesEl, boxesEl }) {
  const lines = textarea.value.split("\n");
  const textRight = (length) => TEXT_LEFT + length * charWidth(textarea);

  // Code only — trailing comments sit outside the box (see alignStepComments).
  const stepMax = stepCodeLayout(lines, boxesEl._steps || []).width;
  const boxWidth = Math.max(BOX_MIN_WIDTH, textRight(stepMax) + BOX_TEXT_PAD - BOX_LEFT);
  for (const box of boxesEl.children) box.style.width = `${boxWidth}px`;

  // Size the overlays to the textarea's *visible* text area (excluding its
  // own scrollbars, which the overlays don't have): the highlight <pre> must
  // have exactly the same scrollable range as the textarea, or the two drift
  // apart at the far scroll edges; guides and boxes shouldn't paint under
  // the scrollbars either.
  const scrollbarY = textarea.offsetWidth - textarea.clientWidth;
  const scrollbarX = textarea.offsetHeight - textarea.clientHeight;
  for (const el of [highlightEl, guidesEl, boxesEl]) {
    el.style.right = `${scrollbarY}px`;
    el.style.bottom = `${scrollbarX}px`;
  }
  highlightEl.scrollLeft = textarea.scrollLeft;
  highlightEl.scrollTop = textarea.scrollTop;
}

/** Summarizes a single step input/output value for the trace table — a
 * GeoJSON geometry (e.g. Rotterdam Boundary Buffer's boundary/buffered
 * outline) can run to thousands of coordinate pairs, unreadable and mostly
 * pointless dumped inline, so it's summarized the same way resultSummaryHtml
 * already does for the top-level result, instead of JSON.stringify'd raw. */
function summarizeTraceValue(value) {
  if (isGeoJsonLike(value)) {
    const geomType = value.type === "Feature" ? value.geometry && value.geometry.type : value.type;
    return `a ${escapeHtml(geomType || value.type)} (GeoJSON ${value.type === "Feature" ? "Feature" : "geometry"} — too large to show inline)`;
  }
  return escapeHtml(JSON.stringify(value));
}

function summarizeTraceRecord(record) {
  return Object.entries(record)
    .map(([name, value]) => `${escapeHtml(name)}: ${summarizeTraceValue(value)}`)
    .join("<br />");
}

function traceTableHtml(trace) {
  return `
    <div style="overflow-x:auto;">
      <table class="data-table">
        <thead><tr><th>Step</th><th>Process</th><th>Inputs</th><th>Outputs</th></tr></thead>
        <tbody>
          ${trace
            .map(
              (t) =>
                `<tr><td>${t.label}</td><td>${t.process_id}</td><td>${summarizeTraceRecord(t.inputs)}</td><td>${summarizeTraceRecord(t.outputs)}</td></tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>`;
}

/** Renders the Status tab body for a live recipe: the values that will be
 * sent, what is still missing, and the Execute button, which runs the recipe
 * through the Cook Orchestrator (an OGC API Process), follows the job and
 * shows and saves the result. */
export async function renderStatusTab(container, recipe) {
  container.innerHTML = `<div class="empty-state">Loading recipe parameters…</div>`;

  // The Wizard's Parameters step (see views/recipeWizard.js) is the one place
  // these get typed in now — this tab just displays whatever it has
  // collected so far and deploys with it, rather than keeping its own
  // separate fillable form that could drift out of sync with the Wizard's.
  const parameters = getLiveParameters(recipe);
  const toolOverrides = getLiveToolOverrides(recipe);
  // A recipe with CWL `File` inputs (e.g. "Rotterdam Boundary Buffer") also
  // has Data Ingredients (see data.js::ingredientsFromDag) — resolved on the
  // Wizard's Data Ingredients step, not typed here. A recipe without any
  // (add-multiply-demo) makes everything below involving `ingredients` a no-op.
  //
  // getLiveIngredients reads the Wizard's own cached state, which only
  // exists once the Wizard tab has actually been opened for this recipe —
  // landing on Status directly first still needs to show (and block Deploy
  // on) an unresolved ingredient, so this falls back to a plain "nothing
  // selected yet" placeholder built straight from recipe.input_datasets.
  const wizardIngredients = getLiveIngredients(recipe);
  const ingredients = wizardIngredients.length
    ? wizardIngredients
    : (recipe.input_datasets || []).map((ingredient) => ({ ingredient, slots: [{ selectedResource: null }] }));
  const ingredientInputNames = new Set(ingredients.map((ing) => ing.ingredient.workflow_input_name).filter(Boolean));
  const isIngredientResolved = (ing) => ing.slots.every((slot) => !!slot.selectedResource);
  // An optional data input (`File?`) can be left empty — only required ones block Deploy.
  const unresolvedIngredients = ingredients.filter((ing) => !ing.ingredient.optional && !isIngredientResolved(ing));

  // getEffectiveRecipe (not the plain schema/dag endpoints) so that, if the
  // Wizard's Tool & Engine step has a custom configuration active for this
  // run, the required-parameters list and pipeline graph shown here reflect
  // THAT shape — e.g. an override adding a genuinely new parameter — not the
  // recipe's unmodified default. Empty overrides behave identically to the
  // plain endpoints (see cwl_parser.apply_tool_overrides).
  let schema, dag;
  try {
    ({ schema, dag } = await sandboxApi.getEffectiveRecipe(recipe.recipe_id, toolOverrides));
  } catch (err) {
    container.innerHTML = `
      <div class="notice-banner">
        Could not reach the Sandbox Stack backend for this recipe. Is it running
        (<code>docker compose up</code> at the repo root)?<br /><small>${err.message}</small>
      </div>`;
    return;
  }

  const required = new Set(schema.required || []);
  // The same parameter view as the Wizard's Parameters step: each one under
  // the app that reads it, completed by that app's own process description
  // (title, description, default) — see recipeWizard.js's loadProcessHints.
  const appView = { liveDag: dag, liveSchema: schema, toolOverrides };
  await loadProcessHints(appView);
  const props = effectiveParamProps(appView);
  // Ingredient-sourced inputs (e.g. "geometry") are excluded from this typed-
  // parameter list entirely — they're not something a hub hand-types here,
  // they come from whatever resource is picked on the Wizard's Data
  // Ingredients step (see the Data Ingredients section rendered below).
  const paramNames = Object.keys(props).filter((name) => !ingredientInputNames.has(name));
  // What a run sends for each parameter: the Wizard's value, else its
  // default (the recipe's, or else its app's) — so a default shown here is
  // also what Execute sends, even if the Wizard was never opened.
  const runParameters = {};
  paramNames.forEach((name) => {
    const value = parameters[name] !== undefined && parameters[name] !== "" ? parameters[name] : props[name].default;
    if (value !== undefined && value !== null) runParameters[name] = value;
  });
  const missingRequired = paramNames.filter((name) => required.has(name) && runParameters[name] === undefined);
  const overrideCount = Object.keys(toolOverrides).length;
  const blocked = missingRequired.length > 0 || unresolvedIngredients.length > 0;

  const paramValueHtml = (name) => {
    const value = runParameters[name];
    if (value === undefined) {
      return required.has(name)
        ? `<span class="param-field__value is-missing">Not filled in yet</span>`
        : `<span class="param-field__value is-empty">Not set (optional)</span>`;
    }
    const isDefault = JSON.stringify(value) === JSON.stringify(props[name].default);
    const shown =
      typeof value === "object"
        ? `<code style="white-space:pre-wrap;word-break:break-word;">${escapeHtml(JSON.stringify(value))}</code>`
        : escapeHtml(String(value));
    return `<span class="param-field__value">${shown}${isDefault ? ` <span class="param-field__value-note">default</span>` : ""}</span>`;
  };
  const paramHtml = ({ name, extra }, link) => `
    <div class="param-field">
      ${paramHeadHtml(name, props[name], required.has(name), link)}
      ${paramValueHtml(name)}
      ${extra ? `<p class="param-field__help">${extra}</p>` : ""}
    </div>`;
  const { groups: paramGroups, unused: unusedParams } = groupParamsByApp(appView, paramNames);
  const rows = [
    ...paramGroups.map(
      (group) => `
      <div class="wizard-ingredient is-resolved">
        ${appGroupHeadHtml(group, "Selected on the recipe Wizard's Tool &amp; Engine step")}
        <div class="param-list">${group.params.map((p) => paramHtml(p, group.link)).join("")}</div>
      </div>`
    ),
    unusedParams.length
      ? `<div class="wizard-ingredient is-missing">
           <div class="wizard-ingredient__title">Not used by any app</div>
           <div class="param-list">${unusedParams.map((name) => paramHtml({ name, extra: "" }, null)).join("")}</div>
         </div>`
      : "",
  ].join("");

  const ingredientsHtml = ingredients.length
    ? `
      <span class="field-label">Data Ingredients</span>
      <div class="field-value">
        Picked on the <a href="#/recipes/${recipe.recipe_id}/wizard">recipe Wizard</a> tab's Data Ingredients step, from
        the real Data Catalogue. Deploy sends each one as a CWL <code>File</code> — its URL, not its data — and the
        tool fetches it from there.
      </div>
      ${ingredients
        .map((ing) => {
          const resolved = isIngredientResolved(ing);
          const resource = ing.slots[0] && ing.slots[0].selectedResource;
          return `
            <div class="field-group">
              <span class="field-label">${escapeHtml(ing.ingredient.role)}${ing.ingredient.optional ? "" : ' <span class="required-mark">*</span>'}</span>
              ${
                resolved
                  ? `<span class="field-value">${escapeHtml(resource.name)}</span>
                     <span class="badge badge-public">${escapeHtml(resource.format)}</span>
                     <div class="field-value muted" style="font-size:.85rem;">Dataset: ${escapeHtml(resource.datasetTitle)}</div>
                     <div class="field-value muted" style="font-size:.85rem;">Sent as a ${escapeHtml(mediaTypeLabel(ing.ingredient.media_type))} File: <code style="word-break:break-all;">${escapeHtml(resource.location || "")}</code></div>`
                  : `<span class="field-value muted">not yet selected${ing.ingredient.optional ? " (optional)" : ""} — needs ${escapeHtml(mediaTypeLabel(ing.ingredient.media_type))}</span>`
              }
            </div>`;
        })
        .join("")}
    `
    : "";

  container.innerHTML = `
    <div class="status-deploy-panel">
      <div class="status-deploy-panel__row">
        <div class="field-group">
          <span class="field-label">Execution</span>
          <div id="live-deploy-badge"><span class="badge badge-muted">Not yet run</span></div>
        </div>
        <button
          type="button"
          class="btn btn-primary"
          id="deploy-recipe-btn"
          ${blocked ? "disabled" : ""}
          title="${blocked ? "Fill in every required parameter and data ingredient on the recipe Wizard tab first" : ""}"
        >${icons.play} Execute Recipe</button>
      </div>
      ${
        blocked
          ? `<hr class="status-deploy-panel__divider" />
             <div class="field-group">
               <span class="field-label">Warnings</span>
               <p class="status-warning-text">
                 <strong class="required-mark">Missing: ${escapeHtml(
                   [...unresolvedIngredients.map((ing) => ing.ingredient.role), ...missingRequired.map((name) => props[name].title || name)].join(", ")
                 )}</strong>
                 — fill these in on the <a href="#/recipes/${recipe.recipe_id}/wizard">recipe Wizard</a> tab first.
               </p>
             </div>`
          : ""
      }
      <div id="live-run-output"></div>
    </div>

    <div class="field-group">
      <span class="field-label">Execution pattern</span>
      <div class="field-value">${recipe.execution_pattern}${executionPatternHelpHtml(recipe.execution_pattern)}</div>
    </div>

    <span class="field-label">Recipe pipeline</span>
    <div id="live-status-graph"></div>

    ${
      overrideCount
        ? `<div class="notice-banner" style="margin-top:12px;">
             Running with a custom configuration: ${overrideCount} step${overrideCount === 1 ? "" : "s"} using a
             different tool than this recipe's default (set on the
             <a href="#/recipes/${recipe.recipe_id}/wizard">recipe Wizard</a>'s Tool &amp; Engine step). The recipe's own
             stored definition is unchanged.
           </div>`
        : ""
    }

    ${ingredientsHtml}

    <span class="field-label">Parameters</span>
    <div class="field-value" style="margin-bottom:12px;">
      Set on the <a href="#/recipes/${recipe.recipe_id}/wizard">recipe Wizard</a> tab's Parameters step, per app.
      Execute sends these values; a setting left empty there uses its default.
    </div>
    ${rows || `<p class="field-value muted">This recipe takes no other parameters.</p>`}
  `;

  const graphEl = container.querySelector("#live-status-graph");
  const statusGraphHint =
    "Computed live from the recipe's CWL document, reflecting the tool and parameter choices made in the recipe Wizard — not a static illustration.";
  renderGraph(graphEl, dag, [], { hint: statusGraphHint });

  const output = container.querySelector("#live-run-output");
  const badge = container.querySelector("#live-deploy-badge");
  const deployBtn = container.querySelector("#deploy-recipe-btn");

  // Follows one Cook Orchestrator job to the end — live per-step progress,
  // a Cancel button, then the result (or failure) — whether it was started
  // by the Deploy button just now or picked up again after a page reload
  // (see rememberRunningJob). `initial` is its latest status document.
  async function followJob(jobId, initial) {
    rememberRunningJob(recipe.recipe_id, jobId);
    deployBtn.disabled = true;
    badge.innerHTML = `<span class="badge badge-public">Running</span>`;
    output.innerHTML = `
      <div class="deploy-progress">
        <span class="deploy-progress__ring" aria-hidden="true"></span>
        <div class="deploy-progress__body" style="flex:1;">
          <div id="live-job-progress">${jobProgressHtml(initial)}</div>
          <button type="button" class="btn btn-outline btn-sm" id="cancel-job-btn" style="margin-top:10px;">Cancel execution</button>
        </div>
      </div>`;
    const cancelBtn = output.querySelector("#cancel-job-btn");
    cancelBtn.addEventListener("click", async () => {
      cancelBtn.disabled = true;
      cancelBtn.textContent = "Cancelling…";
      try {
        await sandboxApi.cancelRecipeJob(jobId);
      } catch (err) {
        cancelBtn.disabled = false;
        cancelBtn.textContent = "Cancel execution";
        showToast(err.message);
      }
    });
    try {
      const { result, trace } = await sandboxApi.waitForRecipeJob(jobId, {
        initial,
        onStatus: (job) => {
          const progressEl = output.querySelector("#live-job-progress");
          if (progressEl) progressEl.innerHTML = jobProgressHtml(job);
        },
      });
      forgetRunningJob(recipe.recipe_id);
      renderGraph(graphEl, dag, trace, { hint: statusGraphHint });
      output.innerHTML = `
        <div class="notice-banner">${resultSummaryHtml(result)}</div>
        ${traceTableHtml(trace)}
        <div id="save-to-hub-status" style="margin-top:12px;font-size:.85rem;"></div>`;
      badge.innerHTML = `<span class="badge badge-public">Executed</span>`;
      showToast(`${recipe.title} has been executed.`);
      await autoSaveToHub(output.querySelector("#save-to-hub-status"), recipe, result);
    } catch (err) {
      forgetRunningJob(recipe.recipe_id);
      badge.innerHTML = `<span class="badge badge-muted">${err.cancelled ? "Cancelled" : "Failed"}</span>`;
      const lastSteps = output.querySelector("#live-job-progress");
      output.innerHTML = `
        <div class="notice-banner">
          ${err.cancelled ? "Execution cancelled." : "Execution failed."}
          ${err.cancelled ? "" : errorSourceHtml(err.source)}
          <br /><small>${escapeHtml(err.message)}</small>
        </div>
        ${lastSteps ? `<div style="margin-top:12px;">${lastSteps.innerHTML}</div>` : ""}`;
    } finally {
      deployBtn.disabled = false;
    }
  }

  // Picks a run that was still going when the page was left or reloaded
  // back up, instead of it silently cooking on with nobody watching.
  const runningJobId = recalledRunningJob(recipe.recipe_id);
  if (runningJobId) {
    sandboxApi
      .getRecipeJob(runningJobId)
      .then((job) => followJob(runningJobId, job))
      .catch(() => forgetRunningJob(recipe.recipe_id));
  }

  deployBtn.addEventListener("click", async () => {
    // Flips the moment the button is pressed: the badge follows the run —
    // Running, then Executed, or Failed/Cancelled (see followJob).
    badge.innerHTML = `<span class="badge badge-public">Running</span>`;
    output.innerHTML = `
      <div class="deploy-progress">
        <span class="deploy-progress__ring" aria-hidden="true"></span>
        <div class="deploy-progress__body">
          <div class="deploy-progress__title">Executing recipe…</div>
          <div class="deploy-progress__subtitle">Sending it to the Cook Orchestrator</div>
        </div>
      </div>`;
    try {
      // Typed parameters (e.g. bufferDistance) plus, for each resolved data
      // input, a CWL File pointing at the picked resource's URL — a
      // reference, never the data itself. The Cook Orchestrator hands it to
      // the OGC API Process as a by-reference input (`{href, type}`), and the
      // process fetches the data, so a live-sourced resource (the PDOK
      // boundary) is always this run's current data. An array input
      // (`File[]`) gets a one-element list.
      const finalParameters = { ...runParameters };
      for (const ing of ingredients) {
        const resource = ing.slots[0] && ing.slots[0].selectedResource;
        if (!resource) continue;
        const file = cwlFile(resource.location, ing.ingredient.media_type);
        finalParameters[ing.ingredient.workflow_input_name] = ing.ingredient.array ? [file] : file;
      }

      const job = await sandboxApi.startRecipeExecution(recipe.recipe_id, finalParameters, toolOverrides);
      // followJob renders progress, the result (saved to the hub right away)
      // and any failure itself.
      await followJob(job.jobID, job);
    } catch (err) {
      badge.innerHTML = `<span class="badge badge-muted">Failed</span>`;
      // Starting the job itself failed — the Cook Orchestrator refused it or
      // couldn't be reached; no tool was called yet.
      output.innerHTML = `
        <div class="notice-banner">
          Execution failed. ${errorSourceHtml({ source: "cook" })}
          <br /><small>${escapeHtml(err.message)}</small>
        </div>`;
    }
  });
}

/** Who to blame for a failed run, from a job's `errorSource` (see
 * sandboxApi's waitForRecipeJob): the Cook Orchestrator or Cookbook API
 * Registry (this platform's own services), or the OGC API Process tool a
 * step calls — whose error the Cook only relays. No source (e.g. polling the
 * Cook itself failed) counts as the Cook's own. */
function errorSourceHtml(origin) {
  const source = (origin && origin.source) || "cook";
  const step = origin && origin.stepLabel ? ` during step “${escapeHtml(origin.stepLabel)}”` : "";
  if (source === "tool") {
    const tool = origin.processId ? ` <code>${escapeHtml(origin.processId)}</code>` : "";
    const url = origin.url ? `<br /><small>Tool endpoint: ${escapeHtml(origin.url)}</small>` : "";
    return `
      <div style="margin-top:6px;"><b>Error source: external tool${tool}</b>${step}.</div>
      <small>The OGC API Process this step calls reported this error (or could not be reached). The Cook Orchestrator only relays it.</small>${url}`;
  }
  const service = source === "registry" ? "Cookbook API Registry" : "Cook Orchestrator";
  return `
    <div style="margin-top:6px;"><b>Error source: ${service} (this platform)</b>${step}.</div>
    <small>The error comes from this platform itself, not from a step's tool.</small>`;
}

// The id of a recipe's still-running Cook Orchestrator job, kept per browser
// only so a page reload can pick it back up (see followJob) — a
// convenience, so every access tolerates storage being unavailable.
const runningJobKey = (recipeId) => `cook-job:${recipeId}`;
function rememberRunningJob(recipeId, jobId) {
  try {
    localStorage.setItem(runningJobKey(recipeId), jobId);
  } catch {
    /* storage unavailable — reload just won't reattach */
  }
}
function forgetRunningJob(recipeId) {
  try {
    localStorage.removeItem(runningJobKey(recipeId));
  } catch {
    /* ignore */
  }
}
function recalledRunningJob(recipeId) {
  try {
    return localStorage.getItem(runningJobKey(recipeId));
  } catch {
    return null;
  }
}

const STEP_STATUS_BADGE = {
  pending: "badge-muted",
  accepted: "badge-muted",
  running: "badge-public",
  successful: "badge-public",
  failed: "badge-muted",
  dismissed: "badge-muted",
};

const STEP_ERROR_SOURCE_LABEL = {
  tool: "<b>Tool error</b>",
  cook: "<b>Cook Orchestrator error</b>",
  registry: "<b>Cookbook Registry error</b>",
};

function formatElapsed(fromIso) {
  const started = Date.parse(fromIso || "");
  if (Number.isNaN(started)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - started) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The cook's live progress for one job status document (see sandboxApi's
 * getRecipeJob): which step it's on out of how many and that step's state,
 * then every step of the recipe with its own status — pending, the remote
 * job's own accepted/running (plus its progress/message, if the remote
 * process reports any), successful, failed or dismissed. */
function jobProgressHtml(job) {
  const steps = job.steps || [];
  // Independent steps run in parallel, so more than one can be active.
  const activeIndexes = steps.map((s, i) => i).filter((i) => steps[i].status !== "pending" && steps[i].status !== "successful");
  const currentIndex = activeIndexes.length ? activeIndexes[0] : -1;
  const current = currentIndex === -1 ? null : steps[currentIndex];
  const doneCount = steps.filter((s) => s.status === "successful").length;
  const elapsed = formatElapsed(job.started || job.created);
  const headline =
    activeIndexes.length > 1
      ? `Steps: ${activeIndexes.map((i) => escapeHtml(steps[i].label)).join(", ")} (${doneCount} of ${steps.length} done)`
      : current
        ? `Step: ${escapeHtml(current.label)} (${currentIndex + 1} of ${steps.length})`
        : steps.length
          ? `${doneCount} of ${steps.length} steps done`
          : "Starting…";
  const summary = [
    `Status: ${escapeHtml(current ? current.status : job.status)}`,
    typeof job.progress === "number" ? `${job.progress}%` : "",
    elapsed ? `elapsed ${elapsed}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const list = steps
    .map((s, i) => {
      // A failed step's message says whose error it is (see errorSourceHtml).
      const blame = s.status === "failed" && s.errorSource ? `${STEP_ERROR_SOURCE_LABEL[s.errorSource.source] || "Error"}: ` : "";
      const remote = [
        typeof s.remoteProgress === "number" && s.status !== "successful" ? `${s.remoteProgress}%` : "",
        s.message ? `${blame}${escapeHtml(s.message)}` : "",
      ]
        .filter(Boolean)
        .join(" — ");
      return `
        <li style="margin:4px 0;${activeIndexes.includes(i) ? "font-weight:600;" : ""}">
          ${i + 1}. ${escapeHtml(s.label)} <span style="opacity:.7;font-weight:400;">(${escapeHtml(s.processId)})</span>
          <span class="badge ${STEP_STATUS_BADGE[s.status] || "badge-muted"}" style="margin-left:6px;">${escapeHtml(s.status)}</span>
          ${remote ? `<div style="font-size:.8rem;opacity:.75;font-weight:400;">${remote}</div>` : ""}
        </li>`;
    })
    .join("");
  return `
    <div class="deploy-progress__title">${headline}</div>
    <div class="deploy-progress__subtitle">${summary}</div>
    ${list ? `<ol style="list-style:none;padding:0;margin:10px 0 0;font-size:.85rem;">${list}</ol>` : ""}`;
}

/** A result value can be a plain scalar (add-multiply-demo's `result: 20`) or
 * a GeoJSON Feature/geometry (Rotterdam Boundary Buffer's `bufferedOutline`)
 * — the latter can run to thousands of coordinate pairs, unreadable and
 * mostly pointless dumped inline as raw JSON, so it's summarized instead;
 * see hubPreview.js for actually viewing it, once saved to the hub. */
function resultSummaryHtml(result) {
  return Object.entries(result)
    .map(([name, value]) => {
      if (isGeoJsonLike(value)) {
        const geomType = value.type === "Feature" ? (value.geometry && value.geometry.type) : value.type;
        return `<div><b>${escapeHtml(name)}:</b> a ${escapeHtml(geomType || value.type)} (GeoJSON ${
          value.type === "Feature" ? "Feature" : "geometry"
        } — too large to show inline; save to the hub to view it on the map).</div>`;
      }
      return `<div><b>${escapeHtml(name)}:</b> ${escapeHtml(JSON.stringify(value))}</div>`;
    })
    .join("");
}

/** Saves this run's result as a real resource on the Sandbox Stack Recipe
 * Results dataset (see services/hub-datasets) — the actual "LDT hub" save
 * step. A saved resource then shows up
 * for real in the Data Catalogue's "Sandbox Stack Recipe Results" card —
 * Preview on that card opens hubPreview.js's map. Runs automatically right
 * after a deploy's result arrives — no separate confirmation click needed. */
async function autoSaveToHub(statusEl, recipe, result) {
  statusEl.textContent = "Saving to hub…";
  try {
    const geoOutput = Object.entries(result).find(([, v]) => isGeoJsonLike(v));
    const content = geoOutput ? geoOutput[1] : result;
    await sandboxApi.saveHubResource(SANDBOX_RESULTS_DATASET_ID, {
      name: `${recipe.title} — ${new Date().toLocaleString()}`,
      format: geoOutput ? "geojson" : "json",
      content,
    });
    statusEl.innerHTML = `
      Saved — see it on the Data Catalogue's “Sandbox Stack Recipe Results” card by pressing 'Preview'.
      <a class="btn btn-secondary btn-sm" style="margin-left:10px;" href="#/hubs/${SANDBOX_RESULTS_HUB_ID}/details/datasets">Go to Dataset</a>`;
    showToast("Result saved to the hub.");
  } catch (err) {
    statusEl.textContent = `Save failed: ${err.message}`;
  }
}

/** Reads the recipe owner's own per-step allowlist of which cataloged tools
 * a hub may substitute in (mirrors cookbook-registry/app/cwl_parser.py's
 * extract_compatible_tools) from the CURRENT, possibly-unsaved CWL text — an
 * optional `nldt:compatibleTools: {stepId: [id, ...]}` top-level block. */
function parseCompatibleTools(text) {
  const lines = codeLines(text);
  const result = {};
  const start = lines.findIndex((l) => COMPATIBLE_TOOLS_HEADER.test(l));
  if (start === -1) return result;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (!/^\s/.test(line)) break;
    const m = line.trim().match(/^([A-Za-z0-9_-]+):\s*\[([^\]]*)\]\s*$/);
    if (m) result[m[1]] = m[2].split(",").map((s) => s.trim()).filter(Boolean);
  }
  return result;
}

/** Replaces (or inserts, right before `steps:`) the `nldt:compatibleTools:`
 * block with `mapping` — dropping it entirely once every step's allowed set
 * is trivially empty, equivalent to no owner-set allowlist at all. */
function writeCompatibleTools(text, mapping) {
  const lines = text.split("\n");
  const entries = Object.entries(mapping).filter(([, ids]) => ids.length > 0);
  const block = entries.length
    ? [`${EXT_COMPATIBLE_TOOLS}:`, ...entries.map(([stepId, ids]) => `  ${stepId}: [${ids.join(", ")}]`)]
    : [];

  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (COMPATIBLE_TOOLS_HEADER.test(stripLineComment(lines[i]))) {
      start = i;
      let j = i + 1;
      while (j < lines.length && (lines[j].trim() === "" || /^\s/.test(lines[j]))) j++;
      // Trailing blank lines separate the block from what follows — keep them.
      while (j > i + 1 && lines[j - 1].trim() === "") j--;
      end = j;
      break;
    }
  }

  if (start !== -1) {
    lines.splice(start, end - start, ...block);
  } else if (block.length) {
    const stepsIdx = lines.findIndex((l) => /^steps:/.test(l));
    const insertAt = stepsIdx === -1 ? lines.length : stepsIdx;
    lines.splice(insertAt, 0, ...block, "");
  }
  return ensureNamespaces(lines.join("\n"));
}

/** Opens the exact same pop-up shape as the Wizard's own resource picker —
 * the one behind "I have this data and it is ready. → Select Resources"
 * (see recipeWizard.js's openResourceModal): a wide `.modal-panel` with a
 * `.modal-panel__filters` search sidebar and a `.modal-panel__results` list,
 * Cancel/Confirm Selection footer — reused here to curate which cataloged
 * tools a hub is allowed to substitute in for ONE step, via the Wizard's
 * Tool & Engine step (see liveToolEngineStepHtml, which reads this same
 * nldt:compatibleTools block via the effective/dag endpoints). Each candidate
 * is the same `.wizard-app-option` card the Wizard's own "Select from
 * Register" tool picker already uses (logo, name, IO summary) with a
 * checkbox toggle — not a bare checkbox + name — and a step's own current
 * tool is always included, shown locked. The search box narrows the list by
 * name; there's nothing meaningful to facet-filter by in a small tool
 * catalog, so unlike the resource modal there's no facets section. */
function openCompatibleAppsModal(textarea, stepName) {
  const compatible = parseCompatibleTools(textarea.value);
  const steps = parseCwlSteps(textarea.value);
  const step = steps.find((s) => s.name === stepName);
  const currentToolId = step ? step.idValue : null;
  const initial = compatible[stepName] && compatible[stepName].length ? compatible[stepName] : [currentToolId];
  const selected = new Set(initial.filter(Boolean));
  if (currentToolId) selected.add(currentToolId);

  let query = "";

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

  function matchingTools() {
    const q = query.trim().toLowerCase();
    if (!q) return TOOL_CATALOG;
    return TOOL_CATALOG.filter((t) => t.label.toLowerCase().includes(q) || t.id.toLowerCase().includes(q));
  }

  function paint() {
    const results = matchingTools();
    overlay.innerHTML = `
      <div class="modal-panel">
        <div class="modal-panel__header">
          <h2>Alternative tools — Step: ${escapeHtml(stepName)}</h2>
          <button type="button" class="modal-panel__close" aria-label="Close">${icons.close}</button>
        </div>
        <div class="modal-panel__body">
          <aside class="modal-panel__filters">
            <div class="search-box">${icons.search}<input type="text" id="modal-search" placeholder="Search apps" value="${escapeHtml(query)}" /></div>
          </aside>
          <div class="modal-panel__results" style="padding:16px 22px;">
            ${
              results.length
                ? results
                    .map((t) => {
                      const isCurrent = t.id === currentToolId;
                      const checked = selected.has(t.id);
                      return `
              <div class="wizard-app-option">
                <img src="assets/logo.svg" alt="${escapeHtml(t.label)} logo" />
                <div class="wizard-app-option__info">
                  <div><b>${escapeHtml(t.label)}</b>${isCurrent ? ` <span class="badge badge-public">Current tool</span>` : ""}</div>
                  <div class="wizard-ingredient__hint" style="margin:2px 0 0;">${toolIoSummaryHtml(t)}</div>
                </div>
                <label style="display:flex;align-items:center;flex-shrink:0;" title="${isCurrent ? "Always included" : `Allow ${t.label} for this step`}">
                  <input type="checkbox" data-compat-app="${t.id}" ${checked ? "checked" : ""} ${isCurrent ? "disabled" : ""} />
                </label>
              </div>`;
                    })
                    .join("")
                : `<p class="facet__empty">No apps match "${escapeHtml(query)}".</p>`
            }
          </div>
        </div>
        <div class="modal-panel__footer">
          <button type="button" class="btn btn-outline" id="modal-cancel">Cancel</button>
          <button type="button" class="btn btn-primary" id="modal-confirm">Confirm Selection</button>
        </div>
      </div>`;
    wire();
  }

  function wire() {
    overlay.querySelector(".modal-panel__close").addEventListener("click", close);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelector("#modal-cancel").addEventListener("click", close);

    const searchInput = overlay.querySelector("#modal-search");
    searchInput.addEventListener("input", (e) => {
      query = e.target.value;
      paint();
      const el = overlay.querySelector("#modal-search");
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });

    overlay.querySelectorAll("[data-compat-app]").forEach((cb) =>
      cb.addEventListener("change", () => {
        const id = cb.getAttribute("data-compat-app");
        if (cb.checked) selected.add(id);
        else selected.delete(id);
      })
    );
    overlay.querySelector("#modal-confirm").addEventListener("click", () => {
      const next = parseCompatibleTools(textarea.value);
      const list = [...selected];
      next[stepName] = list.length ? list : [currentToolId];
      textarea.value = writeCompatibleTools(textarea.value, next);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      showToast(`Alternative tools for "${stepName}" updated — Validate and Save to publish it.`);
      close();
    });
  }

  paint();
}

/** The toolbar's "+ Add new OGC API Process as a Step" button opens this —
 * paste a process URL, fetch its description (via the Cookbook Registry's
 * proxy, see sandboxApi.fetchExternalProcessDescription), and insert it as a
 * brand-new step (see insertNewStep). Same modal chrome as
 * openCompatibleAppsModal so the two feel like one system, but simpler: no
 * search/filter, just a URL field and a status line for fetch errors. The
 * inserted-step confirmation (with its "wire the in: placeholders" and
 * sync/no-auth caveats) is written into `resultEl` — the same banner area
 * Validate/Reset/Save already use — rather than into the modal, since it
 * needs to stay readable after the modal closes. */
function openAddStepFromUrlModal(textarea, resultEl) {
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
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  overlay.innerHTML = `
    <div class="modal-panel" style="max-width:520px;">
      <div class="modal-panel__header">
        <h2>Add a step from an OGC API Process</h2>
        <button type="button" class="modal-panel__close" aria-label="Close">${icons.close}</button>
      </div>
      <div class="modal-panel__body" style="padding:20px 22px;">
        <p style="margin:0 0 12px;font-size:.85rem;color:var(--g-900);">
          Paste the address of any OGC API Process — one of this stack's own tool services, or a
          fully external one (e.g. https://demo.pygeoapi.io/master/processes/hello-world) — and
          its own process description is fetched and turned into a new step: id, inputs, outputs,
          and an nldt:processLink, all filled in automatically.
        </p>
        <input type="text" id="modal-add-step-url" placeholder="https://.../processes/{id}" style="width:100%;" />
        <div id="modal-add-step-status" style="margin-top:10px;font-size:.82rem;"></div>
      </div>
      <div class="modal-panel__footer">
        <button type="button" class="btn btn-outline" id="modal-add-step-cancel">Cancel</button>
        <button type="button" class="btn btn-secondary" id="modal-add-step-confirm">Fetch &amp; Insert Step</button>
      </div>
    </div>`;

  overlay.querySelector(".modal-panel__close").addEventListener("click", close);
  overlay.querySelector("#modal-add-step-cancel").addEventListener("click", close);

  const urlInput = overlay.querySelector("#modal-add-step-url");
  const statusEl = overlay.querySelector("#modal-add-step-status");
  const confirmBtn = overlay.querySelector("#modal-add-step-confirm");
  urlInput.focus();
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") confirmBtn.click();
  });

  confirmBtn.addEventListener("click", async () => {
    const url = urlInput.value.trim();
    if (!url) {
      statusEl.innerHTML = `<span style="color:var(--c-error);">Paste an OGC API Process URL first.</span>`;
      return;
    }
    confirmBtn.disabled = true;
    const originalLabel = confirmBtn.textContent;
    confirmBtn.textContent = "Fetching…";
    statusEl.innerHTML = `Fetching the process description…`;
    try {
      const description = await sandboxApi.fetchExternalProcessDescription(url);
      const tool = processDescriptionToTool(url, description);
      const stepName = insertNewStep(textarea, tool);
      const ins = tool.inputs.map((i) => `${i.name} (${i.type})`).join(", ") || "none";
      const outs = tool.outputs.map((o) => `${o.name} (${o.type})`).join(", ") || "none";
      resultEl.innerHTML = `
        <div class="notice-banner">
          Inserted step "<b>${escapeHtml(stepName)}</b>" for process <b>${escapeHtml(tool.id)}</b>.
          In: ${escapeHtml(ins)}. Out: ${escapeHtml(outs)}.<br />
          <small>
            Its <code>in:</code> values are placeholders — wire each one to a workflow input or
            another step's output, then Validate. The Cook Orchestrator can only call a process
            that answers synchronously with no auth (see cook-orchestrator/README.md) — this
            step will Validate/Save fine either way, but may still fail when actually run.
          </small>
        </div>`;
      showToast(`Inserted step "${stepName}".`);
      close();
    } catch (err) {
      statusEl.innerHTML = `<span style="color:var(--c-error);">${escapeHtml(err.message)}</span>`;
      confirmBtn.textContent = originalLabel;
      confirmBtn.disabled = false;
    }
  });
}

/** Renders the Orchestrator tab body (see ../js/views/editRecipe.js): the
 * recipe definition editor — CWL text + live diagram, and the Guided
 * builder. The actual CWL document — not a translated summary — is editable
 * in place, gated behind an explicit, successful validation before Save is
 * enabled. Editing the text after a successful validation immediately
 * re-disables Save, so a stale "this was valid" result can never be used to
 * save something that was never actually checked. Saving re-validates
 * server-side regardless (POST /recipes always does, DECISIONS.md D12) — this is
 * a UX gate, not the only safety net. */
export async function renderOrchestratorEditTab(container, recipe) {
  container.innerHTML = `<div class="empty-state">Loading recipe CWL…</div>`;

  let cwlText;
  try {
    cwlText = alignStepComments(await sandboxApi.getRecipeCwl(recipe.recipe_id));
  } catch (err) {
    container.innerHTML = `<div class="notice-banner">Could not load the recipe's CWL.<br /><small>${err.message}</small></div>`;
    return;
  }

  container.innerHTML = `
    <div class="card" style="max-width:none;">
      <div class="recipe-def-header">
        <div>
          <h3 style="margin:0;">Recipe definition</h3>
          <p style="margin:4px 0 0;font-size:.82rem;color:var(--g-900);">
            Write or paste the CWL document the Cook Orchestrator executes on the left, and see and
            configure it as a diagram on the right. Each side updates the other. Prefer not to touch
            CWL at all? Use the <b>Guided builder</b>. Validate, and only once it comes back valid
            can you Save.
          </p>
        </div>
        <div class="view-switch" role="tablist" aria-label="Recipe definition view">
          <button type="button" role="tab" data-view="split">CWL + diagram</button>
          <button type="button" role="tab" data-view="guided">Guided builder</button>
        </div>
      </div>
      <div class="recipe-workspace" id="recipe-workspace">
      <div class="cwl-toolbar">
        <div class="cwl-toolbar__group cwl-toolbar__group--blocks" id="cwl-building-blocks">
          <span class="cwl-toolbar__label">Building blocks:</span>
          <button type="button" class="btn btn-secondary btn-sm" id="btn-block-details">1. Recipe details</button>
          <button type="button" class="btn btn-secondary btn-sm" id="btn-block-add">2. Add a step</button>
          <button type="button" class="btn btn-secondary btn-sm" id="btn-block-connect">3. Connect a step</button>
          <button type="button" class="btn btn-secondary btn-sm" id="btn-block-finalize">4. Finalize the process</button>
          <span class="help-tip" tabindex="0" data-help-text="${BUILDING_BLOCKS_HELP}">${icons.help}</span>
        </div>
        <div class="cwl-toolbar__spacer"></div>
        <div class="cwl-toolbar__group">
          <button type="button" class="btn btn-outline btn-sm" id="btn-reset-cwl">${icons.refresh} Reset</button>
          <span class="help-tip" tabindex="0" data-help-text="${RESET_CWL_HELP}">${icons.help}</span>
          <button type="button" class="btn btn-outline btn-sm" id="btn-validate-cwl">${icons.checkCircle} Validate CWL</button>
          <span class="help-tip" tabindex="0" data-help-text="${VALIDATE_CWL_HELP}">${icons.help}</span>
          <button type="button" class="btn btn-primary btn-sm" id="btn-save-recipe" disabled title="Validate successfully first">Save Recipe</button>
          <button type="button" class="btn-icon-toggle" id="btn-expand" aria-pressed="false" title="Full screen (Esc to exit)" aria-label="Full screen">
            <svg class="when-collapsed" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>
            <svg class="when-expanded" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>
          </button>
        </div>
      </div>
      <div class="guided-builder" id="guided-builder" hidden></div>
      <div class="recipe-split" id="recipe-split">
      <div class="code-editor code-editor--docked" id="cwl-code-editor" style="min-height:520px;">
        <div class="code-editor__gutter" id="cwl-gutter" aria-hidden="true"></div>
        <pre class="json-viewer code-editor__highlight" id="cwl-highlight" aria-hidden="true">${highlightHtml(cwlText)}</pre>
        <div class="indent-guides" id="cwl-indent-guides"></div>
        <div class="step-frame-boxes" id="cwl-step-boxes"></div>
        <textarea
          id="cwl-editor"
          class="code-editor__input"
          spellcheck="false"
          style="width:100%;max-width:none;height:100%;resize:none;"
        >${escapeHtml(cwlText)}</textarea>
      </div>
      <div class="recipe-split__divider" id="recipe-split-divider" role="separator" aria-orientation="vertical" aria-label="Resize the CWL and diagram panes" tabindex="0"></div>
      <div class="recipe-diagram" id="recipe-diagram"><div class="recipe-diagram__scroll" id="recipe-diagram-pane"></div></div>
      </div>
      <div id="cwl-validate-result" class="recipe-workspace__result"></div>
      </div>
    </div>`;

  initHelpTips(container);

  // Fills the editor down to the bottom of the visible content area — a
  // fixed min-height meant the page grew a second, confusing scrollbar below
  // the (already internally-scrollable) textarea on a short window, and left
  // a dead gap of unused space on a tall one. `html`/`body` never actually
  // scroll in this app (see styles.css — `overflow: hidden`); the scrollbar
  // that matters is `#view`/`.app-main`'s own internal one, so this measures
  // against THAT element throughout, not the browser window. Recomputed on
  // resize; the listener removes itself once this tab's own editor element
  // is gone (there's no per-view "unmount" hook in this app's router, which
  // just replaces container.innerHTML on navigation — this is the
  // self-cleaning equivalent, so switching tabs repeatedly can't pile up
  // stale listeners).
  const editorEl = container.querySelector("#cwl-code-editor");
  const scrollParent = editorEl.closest(".app-main");
  const EDITOR_MIN_HEIGHT = 320;
  const EDITOR_BOTTOM_MARGIN = 24;
  const workspaceEl = container.querySelector("#recipe-workspace");
  function fillEditorHeight() {
    if (!document.body.contains(editorEl)) {
      window.removeEventListener("resize", fillEditorHeight);
      return;
    }
    if (!scrollParent) return; // defensive; every route renders inside .app-main
    if (workspaceEl.classList.contains("is-expanded")) return; // full screen sizes itself in CSS
    const available = scrollParent.getBoundingClientRect().bottom - editorEl.getBoundingClientRect().top - EDITOR_BOTTOM_MARGIN;
    editorEl.style.height = `${Math.max(EDITOR_MIN_HEIGHT, available)}px`;
    // The editor isn't the last thing in .app-main — the validate-result
    // banner below it (empty until Validate is clicked, but still carrying
    // its own margin) and the page's own footer still need room of their
    // own, so an initial guess based only on the editor's own top offset
    // can still leave .app-main's content a few pixels taller than its own
    // visible height. Rather than hand-tuning a bottom margin big enough for
    // whatever happens to render below it, measure the actual overflow this
    // produced and shrink by exactly that much.
    const overflow = scrollParent.scrollHeight - scrollParent.clientHeight;
    if (overflow > 0) {
      const shrunk = editorEl.getBoundingClientRect().height - overflow;
      editorEl.style.height = `${Math.max(EDITOR_MIN_HEIGHT, shrunk)}px`;
    }
  }
  fillEditorHeight();
  window.addEventListener("resize", fillEditorHeight);

  const textarea = container.querySelector("#cwl-editor");
  const gutterEl = container.querySelector("#cwl-gutter");
  const highlightEl = container.querySelector("#cwl-highlight");
  const guidesEl = container.querySelector("#cwl-indent-guides");
  const boxesEl = container.querySelector("#cwl-step-boxes");
  const resetBtn = container.querySelector("#btn-reset-cwl");
  const validateBtn = container.querySelector("#btn-validate-cwl");
  const saveBtn = container.querySelector("#btn-save-recipe");
  const resultEl = container.querySelector("#cwl-validate-result");
  const layoutEls = { textarea, highlightEl, guidesEl, boxesEl };
  const relayout = () => {
    layoutEditor(layoutEls);
    repositionStepBoxes(boxesEl, textarea);
    repositionIndentGuides(guidesEl, textarea);
  };
  // Also catches the editor's own height/width changes from fillEditorHeight
  // and window resizes; observing a detached element is a no-op, so this
  // needs no cleanup when the tab is navigated away from.
  new ResizeObserver(relayout).observe(editorEl);

  // Full screen: the toolbar, both panes and the validate banner become a
  // fixed overlay filling the window (see .recipe-workspace.is-expanded).
  // Not the browser's Fullscreen API — that shows only the fullscreen
  // element's own subtree, which would hide the building-block dialogs
  // (appended to <body>) and toasts. Esc exits, unless a dialog is open (it
  // gets the Esc first).
  const expandBtn = container.querySelector("#btn-expand");
  const onExpandedKey = (e) => {
    if (!document.body.contains(workspaceEl)) {
      document.removeEventListener("keydown", onExpandedKey);
      return;
    }
    if (e.key === "Escape" && !document.querySelector(".modal-overlay")) setExpanded(false);
  };
  function setExpanded(on) {
    workspaceEl.classList.toggle("is-expanded", on);
    expandBtn.setAttribute("aria-pressed", String(on));
    expandBtn.title = on ? "Exit full screen (Esc)" : "Full screen (Esc to exit)";
    expandBtn.setAttribute("aria-label", on ? "Exit full screen" : "Full screen");
    if (on) document.addEventListener("keydown", onExpandedKey);
    else {
      document.removeEventListener("keydown", onExpandedKey);
      fillEditorHeight();
    }
  }
  expandBtn.addEventListener("click", () => setExpanded(!workspaceEl.classList.contains("is-expanded")));

  // Validate/Reset/Save/Add-step-from-URL all replace resultEl's content with
  // banners of varying height (a one-line notice vs. a multi-line error) —
  // re-running the same overflow correction whenever that happens, rather
  // than only once at initial render, so none of those actions can
  // reintroduce the page-level scrollbar fillEditorHeight() already removed
  // above.
  new MutationObserver(fillEditorHeight).observe(resultEl, { childList: true, subtree: true });

  let validated = false;


  renderStepBoxes(boxesEl, textarea);
  renderIndentGuides(guidesEl, textarea);
  renderGutter(gutterEl, textarea);
  relayout();

  // Two views of the same textarea text: "split" (CWL on the left, the live
  // recipe diagram on the right — see renderRecipeDiagram) and "guided" (see
  // renderGuidedBuilder, for authors who don't want to see CWL at all). The
  // choice is remembered per viewer; split is the default.
  const VIEW_STORAGE_KEY = "nldt.recipeDefinition.view";
  const SPLIT_STORAGE_KEY = "nldt.recipeDefinition.split";
  const VIEWS = ["split", "guided"];
  const guidedEl = container.querySelector("#guided-builder");
  const blocksGroupEl = container.querySelector("#cwl-building-blocks");
  const splitEl = container.querySelector("#recipe-split");
  const dividerEl = container.querySelector("#recipe-split-divider");
  const diagramEl = container.querySelector("#recipe-diagram");
  const diagramPaneEl = container.querySelector("#recipe-diagram-pane");
  const guidedCtx = { state: { stage: "details" }, resultEl, validateBtn, recipeId: recipe.recipe_id };
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

  // The selected diagram node's step box gets highlighted in the editor too.
  let selectedStep = null;
  const highlightSelectedStep = () => {
    for (const box of boxesEl.children) box.classList.toggle("is-selected", box.dataset.step === selectedStep);
  };
  const diagramCtx = {
    state: { selected: null },
    resultEl,
    validateBtn,
    recipeId: recipe.recipe_id,
    reveal(line) {
      textarea.scrollTop = Math.max(0, line * LINE_HEIGHT - 2 * LINE_HEIGHT);
      textarea.dispatchEvent(new Event("scroll"));
    },
    onSelect(nodeId) {
      selectedStep = nodeId && nodeId.startsWith("step:") ? nodeId.slice(5) : null;
      highlightSelectedStep();
    },
  };
  const renderDiagram = () => renderRecipeDiagram(diagramPaneEl, textarea, diagramCtx);
  // Typing in the CWL redraws the diagram once the burst of keystrokes
  // settles, not on every single one.
  let diagramTimer = null;
  const scheduleDiagram = () => {
    clearTimeout(diagramTimer);
    diagramTimer = setTimeout(renderDiagram, 180);
  };
  new ResizeObserver(() => diagramPaneEl._redraw && diagramPaneEl._redraw()).observe(diagramPaneEl);

  // Caret → diagram: putting the cursor inside a step / input / result in
  // the CWL selects that box (selection only — the editor isn't scrolled).
  const syncSelectionFromCaret = () => {
    if (view !== "split") return;
    const line = textarea.value.slice(0, textarea.selectionStart).split("\n").length - 1;
    const nodeId = lineNode(textarea.value, line);
    if (nodeId && nodeId !== diagramCtx.state.selected) {
      diagramCtx.state.selected = nodeId;
      renderDiagram();
    }
  };
  textarea.addEventListener("click", syncSelectionFromCaret);
  textarea.addEventListener("keyup", (e) => {
    if (/^(Arrow|Page|Home|End)/.test(e.key)) syncSelectionFromCaret();
  });

  // Draggable divider between the two panes (also arrow keys when focused).
  const setSplit = (pct) => {
    const clamped = Math.min(75, Math.max(30, pct));
    splitEl.style.setProperty("--split-left", `${clamped}%`);
    return clamped;
  };
  setSplit(Number(readPref(SPLIT_STORAGE_KEY)) || 54);
  dividerEl.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    dividerEl.setPointerCapture(e.pointerId);
    splitEl.classList.add("is-resizing");
    const onMove = (ev) => {
      const rect = splitEl.getBoundingClientRect();
      writePref(SPLIT_STORAGE_KEY, String(setSplit(((ev.clientX - rect.left) / rect.width) * 100)));
    };
    const onUp = () => {
      splitEl.classList.remove("is-resizing");
      dividerEl.removeEventListener("pointermove", onMove);
      dividerEl.removeEventListener("pointerup", onUp);
    };
    dividerEl.addEventListener("pointermove", onMove);
    dividerEl.addEventListener("pointerup", onUp);
  });
  dividerEl.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const current = parseFloat(splitEl.style.getPropertyValue("--split-left")) || 54;
    writePref(SPLIT_STORAGE_KEY, String(setSplit(current + (e.key === "ArrowLeft" ? -4 : 4))));
  });

  let view = VIEWS.includes(readPref(VIEW_STORAGE_KEY)) ? readPref(VIEW_STORAGE_KEY) : "split";
  function setView(next) {
    view = next;
    writePref(VIEW_STORAGE_KEY, next);
    container.querySelectorAll(".view-switch [data-view]").forEach((btn) => {
      const active = btn.dataset.view === next;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", String(active));
    });
    guidedEl.hidden = next !== "guided";
    splitEl.hidden = next === "guided";
    splitEl.classList.toggle("is-split", next === "split");
    dividerEl.hidden = next !== "split";
    diagramEl.hidden = next !== "split";
    blocksGroupEl.hidden = next === "guided";
    // Full screen is for the CWL + diagram workspace only.
    expandBtn.hidden = next === "guided";
    if (next === "guided") setExpanded(false);
    if (next === "guided") {
      renderGuidedBuilder(guidedEl, textarea, guidedCtx);
      return;
    }
    fillEditorHeight();
    relayout();
    if (next === "split") renderDiagram();
  }
  container.querySelectorAll(".view-switch [data-view]").forEach((btn) =>
    btn.addEventListener("click", () => setView(btn.dataset.view))
  );
  setView(view);

  // The highlight, gutter, step boxes and indent guides follow the
  // textarea's scroll position.
  const syncScroll = () => {
    highlightEl.scrollTop = textarea.scrollTop;
    highlightEl.scrollLeft = textarea.scrollLeft;
    gutterEl.scrollTop = textarea.scrollTop;
    repositionStepBoxes(boxesEl, textarea);
    repositionIndentGuides(guidesEl, textarea);
  };

  // Pasting a whole recipe (rather than a snippet) into a non-empty editor
  // offers to replace the document instead of nesting a second one inside it.
  textarea.addEventListener("paste", (e) => {
    const pasted = (e.clipboardData && e.clipboardData.getData("text")) || "";
    const isWholeRecipe = /^cwlVersion:/m.test(pasted) && /^class:\s*Workflow/m.test(pasted);
    const replacingAll = textarea.selectionStart === 0 && textarea.selectionEnd === textarea.value.length;
    if (!isWholeRecipe || replacingAll || !textarea.value.trim()) return;
    e.preventDefault();
    const replace = confirm(
      "That looks like a complete recipe definition.\n\nOK: replace the whole editor content with it.\nCancel: paste it at the cursor instead."
    );
    if (replace) {
      textarea.value = pasted;
      textarea.scrollTop = 0;
      resultEl.innerHTML = `<div class="notice-banner">Replaced the definition with the pasted recipe. It isn't saved yet: Validate, then Save.</div>`;
    } else {
      textarea.setRangeText(pasted, textarea.selectionStart, textarea.selectionEnd, "end");
    }
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });

  // Trailing comments in steps are kept aligned just outside the step boxes
  // (see alignStepComments) — immediately after a programmatic change (a
  // building block, the diagram, Reset, a whole-recipe paste: untrusted
  // events, caret irrelevant), but for typing only once the editor loses
  // focus, so the cursor never jumps mid-keystroke.
  const realignComments = () => {
    const aligned = alignStepComments(textarea.value);
    if (aligned === textarea.value) return false;
    const { scrollTop, scrollLeft } = textarea;
    textarea.value = aligned;
    textarea.scrollTop = scrollTop;
    textarea.scrollLeft = scrollLeft;
    return true;
  };
  textarea.addEventListener("blur", () => {
    if (realignComments()) textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });

  textarea.addEventListener("input", (e) => {
    if (!e.isTrusted) realignComments();
    highlightEl.innerHTML = highlightHtml(textarea.value);
    renderStepBoxes(boxesEl, textarea);
    renderIndentGuides(guidesEl, textarea);
    renderGutter(gutterEl, textarea);
    relayout();
    highlightSelectedStep();
    if (view === "guided") renderGuidedBuilder(guidedEl, textarea, guidedCtx);
    else if (view === "split") scheduleDiagram();
    if (!validated) return;
    validated = false;
    saveBtn.disabled = true;
    saveBtn.title = "Validate successfully first";
  });

  textarea.addEventListener("scroll", syncScroll);

  resetBtn.addEventListener("click", async () => {
    if (textarea.value.trim() && !confirm("Discard the current editor content and load the recipe's original bundled definition?")) {
      return;
    }
    resultEl.innerHTML = `<div class="empty-state">Loading the original recipe definition…</div>`;
    try {
      const original = await sandboxApi.getRecipeOriginalCwl(recipe.recipe_id);
      textarea.value = original;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      resultEl.innerHTML = `
        <div class="notice-banner">
          Reset to the recipe's original bundled definition — this hasn't been saved yet.
          Click Validate, then Save, to actually apply it.
        </div>`;
      showToast("Editor reset to the original recipe definition.");
    } catch (err) {
      resultEl.innerHTML = `<div class="notice-banner">Could not reset.<br /><small>${err.message}</small></div>`;
    }
  });

  container.querySelector("#btn-block-details").addEventListener("click", () => {
    diagramCtx.state.selected = "meta:";
    renderDiagram();
    diagramCtx.reveal(0);
  });
  container.querySelector("#btn-block-add").addEventListener("click", () => openAddStepModal(textarea, resultEl));
  container.querySelector("#btn-block-connect").addEventListener("click", () => openConnectStepModal(textarea, resultEl));
  container
    .querySelector("#btn-block-finalize")
    .addEventListener("click", () => openFinalizeModal(textarea, resultEl, validateBtn));

  validateBtn.addEventListener("click", async () => {
    resultEl.innerHTML = `<div class="empty-state">Validating against the Cookbook Registry…</div>`;
    try {
      const outcome = await sandboxApi.validateCwl(textarea.value);
      if (outcome.valid) {
        validated = true;
        saveBtn.disabled = false;
        saveBtn.title = "";
        const inputNames = Object.keys(outcome.schema.properties || {}).join(", ") || "none";
        const stepIds = outcome.dag.steps.map((s) => s.id).join(" → ") || "none";
        resultEl.innerHTML = `
          <div class="notice-banner">
            Valid CWL. Inputs: <b>${inputNames}</b>. Steps: <b>${stepIds}</b>.
          </div>`;
      } else {
        validated = false;
        saveBtn.disabled = true;
        saveBtn.title = "Validate successfully first";
        resultEl.innerHTML = `<div class="notice-banner">Invalid CWL — not saved.<br /><small>${outcome.error}</small></div>`;
      }
    } catch (err) {
      validated = false;
      saveBtn.disabled = true;
      resultEl.innerHTML = `<div class="notice-banner">Could not reach the Cookbook Registry to validate.<br /><small>${err.message}</small></div>`;
    }
  });

  saveBtn.addEventListener("click", async () => {
    if (!validated) return;
    saveBtn.disabled = true;
    const originalLabel = saveBtn.textContent;
    saveBtn.textContent = "Saving…";
    try {
      await sandboxApi.saveRecipeCwl(recipe.recipe_id, {
        title: recipe.title,
        description: recipe.description,
        keywords: recipe.theme || [],
        cwl: textarea.value,
      });
      resultEl.innerHTML = `
        <div class="notice-banner">
          Saved. The Cookbook Registry, the catalogue entry, and the execution graph the Cook
          Orchestrator walks all now reflect this version.
        </div>`;
      showToast(`${recipe.title} saved.`);
    } catch (err) {
      resultEl.innerHTML = `<div class="notice-banner">Save failed.<br /><small>${err.message}</small></div>`;
      // Saving failed, but the last client-side validation is still honest
      // about what's in the textarea (it hasn't changed) — re-enable Save
      // rather than forcing a redundant re-validate.
      validated = true;
    } finally {
      saveBtn.textContent = originalLabel;
      saveBtn.disabled = !validated;
    }
  });
}
