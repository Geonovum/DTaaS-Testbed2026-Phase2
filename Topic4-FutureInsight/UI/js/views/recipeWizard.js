import * as api from "../data.js";
import * as sandboxApi from "../sandboxApi.js";
import { showToast, getActiveHubId, getActiveHubName } from "../state.js";
import { icons } from "../icons.js";
import { TOOL_CATALOG, findTool, toolProcessUrl } from "../toolCatalog.js";
import { graphHtml, drawGraphConnectors } from "../recipeGraph.js";
import { catalogueFormatsFor, mediaTypeLabel } from "../dataFormats.js";

// Cross-tab so the Status tab (rendered by ../liveRecipe.js) can read
// whatever progress a hub has made in the Wizard without the two tabs
// needing to share a parent component.
const wizardStateCache = new Map();

function stateKey(recipe) {
  return recipe.recipe_id;
}

function titleCase(str) {
  return str.replace(/\b\w/g, (c) => c.toUpperCase());
}

// Free text (typed parameter values, schema-derived templates, dataset
// titles) goes back into innerHTML escaped.
function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// One data input (a CWL `type: File` workflow input — see data.js's
// ingredientsFromDag) becomes one slot to pick a resource for. `formats` is
// the catalogue formats that fit its media type (see dataFormats.js), or
// null when the media type is unknown and any resource may be picked. An
// array input (`File[]`) still takes one pick here, sent as a one-element
// list.
export function slotsFor(ingredient) {
  return [
    {
      name: titleCase(ingredient.role),
      mediaType: ingredient.media_type || null,
      formatLabel: mediaTypeLabel(ingredient.media_type),
      formats: catalogueFormatsFor(ingredient.media_type),
      description: ingredient.description || "",
      array: !!ingredient.array,
    },
  ];
}

// Whether a catalogue resource can be handed to a slot.
function resourceFitsSlot(slot, resource) {
  return !slot.feature.formats || slot.feature.formats.includes(resource.format);
}

function newIngredientState(ingredient) {
  return { ingredient, slots: slotsFor(ingredient).map(createSlotState) };
}

// The data inputs come from the recipe's CWL, which the Orchestrator tab can
// change at any time (a new `File` input, a different format) — so they're
// re-derived from the freshly fetched DAG on every render, keeping whatever
// resource was already picked for an input that still exists unchanged.
// An older backend without `data_inputs` leaves the list as it was.
function syncIngredients(state) {
  if (!state.liveDag || !state.liveDag.data_inputs) return;
  const previous = new Map(state.ingredients.map((ing) => [ing.ingredient.workflow_input_name, ing]));
  state.ingredients = api.ingredientsFromDag(state.liveDag).map((ingredient) => {
    const old = previous.get(ingredient.workflow_input_name);
    return old && old.ingredient.media_type === ingredient.media_type ? { ...old, ingredient } : newIngredientState(ingredient);
  });
}

// A slot's interactive state — just which of the hub's own resources was
// picked for it (see openResourceModal).
function createSlotState(feature) {
  return { feature, selectedResource: null };
}

function isSlotDataResolved(slot) {
  return !!slot.selectedResource;
}

function isResolved(ing) {
  return ing.slots.every(isSlotDataResolved);
}

// The exact reason a slot is blocking, in plain language — shown as a red
// inline warning right on the slot so a hub doesn't have to guess what's
// missing (null once resolved).
function slotMissingReason(slot) {
  return isSlotDataResolved(slot) ? null : "Select which resource you have.";
}

function computeCartLines(state, recipe) {
  const baseFee = recipe.base_fee || 0;
  const lines = [
    { id: "base", label: "Base Recipe Schema", sublabel: "", price: baseFee, priceLabel: `€${baseFee.toFixed(2)}` },
  ];

  state.ingredients.forEach((ing) => {
    ing.slots.forEach((slot, slotIndex) => {
      if (!slot.selectedResource) return;
      const r = slot.selectedResource;
      lines.push({
        id: `res-${ing.ingredient.input_dataset_id}-${slotIndex}`,
        label: r.name,
        sublabel: `Dataset: ${r.datasetTitle} · Owner Hub: ${r.owner_hub_name}`,
        price: 0,
        priceLabel: "€0 (Owned)",
      });
    });
  });

  // Each of the recipe's own CWL steps is priced at whichever tool currently
  // runs it (its own default, or a per-run override — see
  // state.toolOverrides / liveToolEngineStepHtml).
  ((state.liveDag && state.liveDag.steps) || []).forEach((step) => {
    const tool = findTool(state.toolOverrides[step.id] || step.process_id);
    if (!tool) return;
    const fee = tool.wizard_execution_fee || 0;
    lines.push({
      id: `live-step-${step.id}`,
      label: escapeHtml(stepAppName(state, step)),
      sublabel: `Execution license · Step: ${escapeHtml(stepName(step))}`,
      price: fee,
      priceLabel: `€${fee.toFixed(2)}`,
    });
  });

  return lines;
}

// Recipe-wide "Data Protocols & Formats" and "Execution Constraints" — unlike
// Spatial Feature Requirements, these apply to the whole recipe rather than
// one specific data ingredient, so they're shown once above the ingredient
// list instead of being repeated on every card.
function recipeRequirementsHtml(recipe) {
  const hasProtocols = recipe.data_protocols && recipe.data_protocols.length;
  const hasConstraints = recipe.execution_constraints && recipe.execution_constraints.length;
  if (!hasProtocols && !hasConstraints) return "";
  return `
    <div class="wizard-requirements">
      ${
        hasProtocols
          ? `
      <div class="wizard-requirements__col">
        <div class="field-label">Data Protocols &amp; Formats</div>
        <ul>${recipe.data_protocols.map((f) => `<li>${f}</li>`).join("")}</ul>
      </div>`
          : ""
      }
      ${
        hasConstraints
          ? `
      <div class="wizard-requirements__col">
        <div class="field-label">Execution Constraints</div>
        <ul>${recipe.execution_constraints.map((f) => `<li>${f}</li>`).join("")}</ul>
      </div>`
          : ""
      }
    </div>`;
}

function slotResourcePreviewHtml(slot) {
  if (!slot.selectedResource) return "";
  const r = slot.selectedResource;
  return `
    <div class="wizard-selected wizard-selected--slot">
      <b>Selected:</b> ${r.name} <span class="badge badge-public">${r.format}</span>
      <small>Dataset: ${r.datasetTitle} · Owner Hub: ${r.owner_hub_name}</small>
    </div>`;
}

// Each slot's own resource picker sits directly under it — never pooled with
// other data inputs — so it's always obvious which resource belongs to which
// requirement.
function slotHtml(ingIndex, slot, slotIndex, showValidation) {
  const f = slot.feature;
  const key = `${ingIndex}|${slotIndex}`;
  // Red "blocked" warnings only appear once the hub actually tries to move
  // on and fails — showing them upfront on a pristine, untouched step reads
  // as an accusation before anyone's done anything wrong.
  const missingReason = showValidation ? slotMissingReason(slot) : null;
  return `
    <li class="wizard-slot ${missingReason ? "is-missing" : ""}">
      <span class="wizard-data-input-list__name">${f.name}</span>
      <span class="badge badge-public">${escapeHtml(f.formatLabel)}${f.array ? " · one or more files" : ""}</span>
      ${f.description ? `<div class="wizard-data-input-list__desc">${escapeHtml(f.description)}</div>` : ""}
      <div class="wizard-data-input-list__desc">Needs ${f.mediaType ? `a <b>${escapeHtml(f.formatLabel)}</b> file (<code>${escapeHtml(f.mediaType)}</code>)` : "a file in any format"} — the recipe is given its URL and the tool fetches the data itself.</div>
      ${missingReason ? `<p class="wizard-missing-hint">⚠ ${missingReason}</p>` : ""}
      <div class="wizard-radio-body" style="padding-left:0;">
        <button type="button" class="btn btn-primary btn-sm" data-select-slot="${key}">Select Resources</button>
        ${slotResourcePreviewHtml(slot)}
      </div>
    </li>`;
}

function ingredientHtml(ing, ingIndex, showValidation) {
  const resolved = isResolved(ing);
  return `
    <div class="wizard-ingredient ${resolved ? "is-resolved" : ""}">
      <div class="wizard-ingredient__title">
        ${resolved ? `<span class="wizard-ingredient__check">${icons.checkCircle}</span>` : ""}
        Data Input Required
      </div>
      <div class="wizard-requirement-block">
        <ol class="wizard-data-input-list">
          ${ing.slots.map((slot, slotIndex) => slotHtml(ingIndex, slot, slotIndex, showValidation)).join("")}
        </ol>
      </div>
    </div>`;
}

function dataIngredientsStepHtml(state, showValidation) {
  if (!state.ingredients.length) {
    return `
      <div class="wizard-ingredient is-resolved">
        <div class="wizard-ingredient__title">
          <span class="wizard-ingredient__check">${icons.checkCircle}</span>
          No data input needed
        </div>
        <p style="font-size:.85rem;color:var(--g-900);margin:0;">This recipe has no data ingredients to source.</p>
      </div>`;
  }
  return state.ingredients.map((ing, i) => ingredientHtml(ing, i, showValidation)).join("");
}

// Which of this live recipe's CWL steps actually consumes a given top-level
// workflow input, and under what local input name at that step (a workflow
// input isn't necessarily called the same thing where a step reads it — see
// cwl_parser.py's _step_source_ref) — cross-referenced against
// dag.steps[].inputs, since the parameter schema itself (liveSchema) has no
// notion of which step reads what, only its own type/description. Reflects
// whichever tool currently runs that step (its own default, or a per-run
// override — see toolOverrides), so swapping a step's tool on the Tool &
// Engine step immediately updates which app a parameter is attributed to
// here (see groupParamsByApp, which shows each parameter under its app).
function paramUsage(dag, toolOverrides, name) {
  if (!dag) return [];
  const usage = [];
  dag.steps.forEach((step) => {
    Object.entries(step.inputs || {}).forEach(([localName, ref]) => {
      if (ref.source_type === "workflow_input" && ref.name === name) {
        const toolId = toolOverrides[step.id] || step.process_id;
        usage.push({ step, localName, tool: findTool(toolId), toolId });
      }
    });
  });
  return usage;
}

// A nullable schema (`anyOf: [X, {type: "null"}]`) is edited as plain X —
// leaving the field empty is what sends "nothing" (see the listener in
// wireEvents, which maps an empty field to undefined).
function nonNullSchema(prop) {
  const variants = prop.anyOf || prop.oneOf;
  if (!variants) return prop;
  const nonNull = variants.filter((v) => v && v.type !== "null");
  return nonNull.length === 1 ? { ...prop, ...nonNull[0], anyOf: undefined, oneOf: undefined } : prop;
}

// Which input widget a parameter's JSON Schema (see cwl_parser.py's
// extract_input_schema, incl. an input's own nldt:jsonSchema) gets: plain
// scalar fields as before; an array of enum values as a checkbox group; an
// array of plain scalars as one comma-separated field; and anything
// structured — objects, oneOf variants, `Any` (an empty schema) — as a raw
// JSON editor, since no generic form could do those justice.
function paramWidgetKind(prop) {
  if (prop.type === "array") {
    const items = nonNullSchema(prop.items || {});
    if (Array.isArray(items.enum)) return "enum-multi";
    if (["string", "integer", "number"].includes(items.type)) return `list-${items.type}`;
    return "json";
  }
  if (["string", "integer", "number", "boolean"].includes(prop.type) && !prop.oneOf && !prop.anyOf) return "scalar";
  return "json";
}

// A starting-point value for a JSON-edited parameter, built from its schema:
// consts/defaults/first enum value as-is, objects with their required
// fields, arrays with one item, a oneOf/anyOf's first variant. Only ever a
// placeholder — never sent by itself.
function schemaTemplate(schema) {
  if (!schema || typeof schema !== "object") return null;
  if ("const" in schema) return schema.const;
  if (schema.default !== undefined && schema.default !== null) return schema.default;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  const variants = schema.oneOf || schema.anyOf;
  if (variants) return schemaTemplate(variants.find((v) => v && v.type !== "null") || variants[0]);
  switch (schema.type) {
    case "object": {
      const props = schema.properties || {};
      const keys = schema.required && schema.required.length ? schema.required : Object.keys(props);
      return Object.fromEntries(keys.map((k) => [k, schemaTemplate(props[k])]));
    }
    case "array":
      return [schemaTemplate(schema.items)];
    case "string":
      return "";
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return false;
    default:
      return {};
  }
}

function structuredParamControlHtml(name, prop, kind, value) {
  if (kind === "enum-multi") {
    const options = nonNullSchema(prop.items || {}).enum;
    const picked = Array.isArray(value) ? value : [];
    return `
      <span style="display:flex;gap:14px;flex-wrap:wrap;">
        ${options
          .map(
            (opt) => `
          <label style="display:inline-flex;align-items:center;gap:6px;">
            <input type="checkbox" data-param-name="${name}" data-param-kind="enum-multi" value="${escapeHtml(opt)}" ${picked.includes(opt) ? "checked" : ""} />
            ${escapeHtml(opt)}
          </label>`
          )
          .join("")}
      </span>`;
  }
  if (kind.startsWith("list-")) {
    const hint = Array.isArray(prop.default)
      ? prop.default.join(", ")
      : kind === "list-string"
        ? "comma-separated values"
        : "comma-separated numbers";
    return `
      <input type="text" data-param-name="${name}" data-param-kind="${kind}" placeholder="${escapeHtml(hint)}"
        value="${Array.isArray(value) ? escapeHtml(value.join(", ")) : ""}" />
      <span class="field-value" data-param-error="${name}" style="font-size:.8em;color:var(--c-error);"></span>`;
  }
  // A JSON field works like any other parameter: its placeholder is the
  // value an empty field sends — its default — when it has one, otherwise
  // the shape its schema expects (see schemaTemplate), as a hint only.
  const text = value !== undefined ? JSON.stringify(value, null, 2) : "";
  const placeholder = prop.default !== undefined && prop.default !== null ? prop.default : schemaTemplate(prop);
  return `
    <textarea data-param-name="${name}" data-param-kind="json" rows="${Math.min(12, Math.max(4, text.split("\n").length))}"
      placeholder="${escapeHtml(JSON.stringify(placeholder))}"
      style="font-family:var(--font-mono, monospace);font-size:.8rem;">${escapeHtml(text)}</textarea>
    <span class="field-value" data-param-error="${name}" style="font-size:.8em;color:var(--c-error);"></span>`;
}

// The help line under a parameter field: its description (the recipe's, or
// else its app's — see effectiveParamProp) and any limits its schema sets.
// What an empty field sends is shown once, as the field's "Default" chip.
// Escaped throughout — app descriptions come from third-party servers.
export function paramHelpHtml(prop, extra = "") {
  const parts = [];
  const sentence = (text) => escapeHtml(/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);
  if (prop.description) parts.push(sentence(prop.description));
  if (prop.processDescription) parts.push(sentence(prop.processDescription));
  // OpenAPI 3.0-style schemas mark a bound exclusive with a boolean instead.
  const exMin = typeof prop.exclusiveMinimum === "number" ? prop.exclusiveMinimum : prop.exclusiveMinimum === true ? prop.minimum : undefined;
  const exMax = typeof prop.exclusiveMaximum === "number" ? prop.exclusiveMaximum : prop.exclusiveMaximum === true ? prop.maximum : undefined;
  const limits = [
    prop.minimum !== undefined && prop.exclusiveMinimum !== true && `at least ${prop.minimum}`,
    exMin !== undefined && `more than ${exMin}`,
    prop.maximum !== undefined && prop.exclusiveMaximum !== true && `at most ${prop.maximum}`,
    exMax !== undefined && `less than ${exMax}`,
  ].filter(Boolean);
  if (limits.length) parts.push(`Must be ${limits.map(escapeHtml).join(" and ")}.`);
  if (extra) parts.push(extra);
  return parts.length ? `<p class="param-field__help">${parts.join(" ")}</p>` : "";
}

// One parameter: its readable title (the recipe's label, or else its app's
// input title) with the technical input name beside it — what
// state.parameters is keyed by — a Default/Required chip, the control, and
// one help line. `typed`: whether the user entered this value. A value they
// didn't (i.e. the default, see syncParamDefaults) shows as the control's
// grey placeholder, not as text — typing replaces it, and clearing the field
// brings the default back. Checkboxes simply show their current state.
const EXTERNAL_LINK_ICON =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M10 14 20 4"/><path d="M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6"/></svg>';

/** A parameter's header line: title, technical name, Default/Required chip
 * and — when `link` (see processDescriptionLink) is given — a "Definition"
 * link to the app's own process description, where this input's schema,
 * default and description are published. Shared with ../liveRecipe.js's
 * Status tab. `labelFor`: the id of the control this titles, if any. */
export function paramHeadHtml(name, rawProp, required, link, labelFor) {
  const prop = nonNullSchema(rawProp);
  const kind = paramWidgetKind(prop);
  const hasTitle = prop.title && prop.title.trim().toLowerCase() !== name.toLowerCase();
  const hasDefault = prop.default !== undefined && prop.default !== null;
  const defaultText = Array.isArray(prop.default) ? prop.default.join(", ") : typeof prop.default === "object" ? null : String(prop.default);
  const chip = hasDefault
    ? kind === "enum-multi" || prop.type === "boolean"
      ? ""
      : `<span class="param-chip" title="Used when the field is left empty">Default ${defaultText !== null ? escapeHtml(defaultText) : "in grey"}</span>`
    : required
      ? `<span class="param-chip is-required">Required</span>`
      : `<span class="param-chip is-optional">Optional</span>`;
  const title = escapeHtml(hasTitle ? prop.title : name);
  return `
    <div class="param-field__head">
      ${labelFor ? `<label class="param-field__title" for="${labelFor}">${title}</label>` : `<span class="param-field__title">${title}</span>`}
      ${hasTitle ? `<code class="param-field__name">${escapeHtml(name)}</code>` : ""}
      ${chip}
      ${
        link
          ? `<a class="param-field__source" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer"
               title="Open the app's process description (JSON), where this setting's schema, default and description are defined">Definition ${EXTERNAL_LINK_ICON}</a>`
          : ""
      }
    </div>`;
}

function liveParamFieldHtml(name, rawProp, required, currentValue, typed, extraHelp = "", link = null) {
  const prop = nonNullSchema(rawProp);
  const kind = paramWidgetKind(prop);
  const id = `param-${name}`;
  const hasDefault = prop.default !== undefined && prop.default !== null;
  const head = paramHeadHtml(name, rawProp, required, link, id);

  let control;
  if (kind !== "scalar") {
    const value = typed || kind === "enum-multi" ? currentValue : undefined;
    control = structuredParamControlHtml(name, prop, kind, value).replace(`data-param-name="${name}"`, `id="${id}" data-param-name="${name}"`);
  } else {
    const numeric = prop.type === "number" || prop.type === "integer";
    const inputType = numeric ? "number" : prop.type === "boolean" ? "checkbox" : "text";
    const stepAttr = prop.type === "integer" ? "1" : "any";
    const valueAttr = typed && currentValue !== undefined && inputType !== "checkbox" ? `value="${escapeHtml(currentValue)}"` : "";
    const placeholderAttr = hasDefault && inputType !== "checkbox" ? `placeholder="${escapeHtml(prop.default)}"` : "";
    const checkedAttr = currentValue === true && inputType === "checkbox" ? "checked" : "";
    control = `<input id="${id}" type="${inputType}" data-param-name="${name}" ${numeric ? `step="${stepAttr}"` : ""} ${valueAttr} ${placeholderAttr} ${checkedAttr} />`;
  }
  return `
    <div class="param-field">
      ${head}
      ${control}
      ${paramHelpHtml(prop, extraHelp)}
    </div>`;
}

/** The app that runs a step — one rule for every screen: the name the recipe
 * itself gives it (its Operation's CWL `label`, passed on by the Cookbook
 * Registry as `process_label`; a tool swap replaces it with the new app's),
 * else this stack's own tool's label, else the title its OGC API Process
 * description gives (once fetched, see loadProcessHints), else its process
 * id. `state` is any object with optional {toolOverrides, stepApps}. */
export function stepAppName(state, step) {
  const toolId = (state.toolOverrides && state.toolOverrides[step.id]) || step.process_id;
  const tool = findTool(toolId);
  const described = state.stepApps && state.stepApps[step.id] && state.stepApps[step.id].title;
  return step.process_label || (tool && tool.label) || described || toolId;
}

/** What a step does in the recipe — its CWL step `label`, else its id. It
 * names the step's card and stays the same when its app is swapped. */
export function stepName(step) {
  return step.label || step.id;
}

/** A graph's app node shows the app's name with the step's name beside it
 * — unless that would only repeat the app name or its process id. */
export function stepSublabel(state, step) {
  const name = stepName(step);
  return name === step.process_id || name === stepAppName(state, step) ? "" : name;
}

/** Groups parameter `names` by the app (the step's tool, chosen on the Tool &
 * Engine step) that reads each one, in step order: `{groups: [{step,
 * appName, link, params: [{name, extra}]}], unused: [name]}`. A parameter
 * goes under the first app that reads it; `extra` names any other app that
 * also does. `state` is any {liveDag, toolOverrides, stepApps} object — the
 * Wizard's own, or ../liveRecipe.js's Status tab's (see loadProcessHints). */
export function groupParamsByApp(state, names) {
  const byStep = new Map(); // step id -> [{name, extra}]
  const unused = [];
  names.forEach((name) => {
    const usage = paramUsage(state.liveDag, state.toolOverrides, name);
    if (!usage.length) return unused.push(name);
    const first = stepAppName(state, usage[0].step);
    const others = [...new Set(usage.slice(1).map((u) => stepAppName(state, u.step)))].filter((n) => n !== first);
    const extra = others.length ? `Also used by ${others.map((n) => `<b>${escapeHtml(n)}</b>`).join(", ")}.` : "";
    const stepId = usage[0].step.id;
    if (!byStep.has(stepId)) byStep.set(stepId, []);
    byStep.get(stepId).push({ name, extra });
  });
  const steps = (state.liveDag && state.liveDag.steps) || [];
  const groups = steps
    .filter((step) => byStep.has(step.id))
    .map((step) => ({ step, appName: stepAppName(state, step), link: processDescriptionLink(step), params: byStep.get(step.id) }));
  return { groups, unused };
}

/** A group's heading, in the same shape as the Tool & Engine step: the step
 * title, then the app's own row — logo, name, `subtitle`, and a link to its
 * process description. Shared with ../liveRecipe.js's Status tab. */
export function appGroupHeadHtml(group, subtitle) {
  return `
    <div class="wizard-ingredient__title">
      <span class="wizard-ingredient__check">${icons.checkCircle}</span>
      ${escapeHtml(stepName(group.step))}
    </div>
    <div class="wizard-app-option">
      <img src="assets/logo.svg" alt="" />
      <div class="wizard-app-option__info">
        <div><b>${escapeHtml(group.appName)}</b></div>
        <div class="wizard-ingredient__hint" style="margin:2px 0 0;">${subtitle}</div>
      </div>
      ${
        group.link
          ? `<a class="param-field__source" href="${escapeHtml(group.link)}" target="_blank" rel="noopener noreferrer"
               title="Open this app's OGC API Process description (JSON): every setting's schema, default and description">Process description ${EXTERNAL_LINK_ICON}</a>`
          : ""
      }
    </div>`;
}

// Step 3's content: the typed parameters the recipe's apps need, grouped by
// the app that reads each one (see groupParamsByApp) — so the form reads as
// "this app needs these settings" rather than as the recipe's CWL wiring.
// Built from state.liveSchema (refetched on every render() — re-opening the
// Wizard tab after saving a CWL edit picks up the new shape), completed by
// each app's own process description (see effectiveParamProps). Values are
// collected in state.parameters — the Status tab just displays them
// read-only and deploys with them (see getLiveParameters), so there's one
// place to type values, not two.
function parametersStepHtml(state) {
  if (!state.liveSchema) {
    return `
      <div class="notice-banner">
        Could not reach the Sandbox Stack backend for this recipe's parameter shape. Is it running
        (<code>docker compose up</code> at the repo root)?
      </div>`;
  }
  const required = new Set(state.liveSchema.required || []);
  // Ingredient-sourced inputs (e.g. "geometry") are handled entirely by the
  // Data Ingredients step above — they don't belong on this typed-parameter
  // form too (see ../liveRecipe.js's Status tab, which applies the same
  // exclusion for the same reason).
  const ingredientInputNames = new Set(state.ingredients.map((ing) => ing.ingredient.workflow_input_name).filter(Boolean));
  const props = effectiveParamProps(state);
  const names = Object.keys(props).filter((name) => !ingredientInputNames.has(name));
  if (!names.length) return `<p style="font-size:.85rem;color:var(--g-900);margin:0;">This recipe takes no other parameters.</p>`;

  const { groups, unused } = groupParamsByApp(state, names);
  const field = ({ name, extra }, link) =>
    liveParamFieldHtml(name, props[name], required.has(name), state.parameters[name], state.typedParams.has(name), extra, link);
  const appCards = groups.map(
    (group) => `
      <div class="wizard-ingredient is-resolved">
        ${appGroupHeadHtml(
          group,
          `The app you selected in Tool &amp; Engine · needs ${group.params.length} ${group.params.length === 1 ? "setting" : "settings"}`
        )}
        <div class="param-list">${group.params.map((p) => field(p, group.link)).join("")}</div>
      </div>`
  );
  if (unused.length) {
    appCards.push(`
      <div class="wizard-ingredient is-missing">
        <div class="wizard-ingredient__title">Not used by any app</div>
        <p class="wizard-ingredient__hint">The recipe asks for these, but no step currently reads them, so they have no effect.</p>
        <div class="param-list">${unused.map((name) => field({ name, extra: "" }, null)).join("")}</div>
      </div>`);
  }
  return appCards.join("");
}

/** Reads back whatever parameter values have been collected on the Wizard's
 * Parameters step for a live recipe — `{}` if the Wizard has never been
 * opened for this recipe yet. The Status tab (see ../liveRecipe.js) uses
 * this instead of keeping its own separate fillable form, so there's a
 * single source of truth for what gets sent to the Cook Orchestrator. */
export function getLiveParameters(recipe) {
  const state = wizardStateCache.get(stateKey(recipe));
  return state ? state.parameters : {};
}

// The live recipe's Data Ingredients state (its CWL `File` inputs — see
// data.js's ingredientsFromDag) — read by liveRecipe.js's Status tab to check
// whether every ingredient has a resolved resource yet, and to turn each
// one's picked resource into a CWL File for the workflow input it feeds (via
// ingredient.workflow_input_name) right before deploying.
export function getLiveIngredients(recipe) {
  const state = wizardStateCache.get(stateKey(recipe));
  return state ? state.ingredients : [];
}

// Tool & Engine comes first: which tool actually runs each of the recipe's
// CWL steps decides what data and parameters it needs, so Data Ingredients
// and Parameters read as a consequence of that choice, not independent,
// unrelated steps.
const STEP_DEFS = [
  { n: 1, label: "Tool & Engine" },
  { n: 2, label: "Data Ingredients" },
  { n: 3, label: "Parameters" },
  { n: 4, label: "Output" },
];
const LAST_STEP = STEP_DEFS[STEP_DEFS.length - 1].n;

function adjacentStep(from, dir) {
  return Math.min(LAST_STEP, Math.max(1, from + dir));
}

function isOutputStepDone(state) {
  return !!(state.output.destinationHubId && state.output.destinationDatasetId);
}

// Tool & Engine always has a tool per step (the recipe's own default unless
// overridden), and Parameters is informational only — neither ever blocks.
function isStepDone(state, n) {
  if (n === 2) return state.ingredients.every(isResolved);
  if (n === 4) return isOutputStepDone(state);
  return true;
}

function allStepsDone(state) {
  return STEP_DEFS.every((s) => isStepDone(state, s.n));
}

// The "Recipe Schema" graph shown on the Tool & Engine step: the whole
// recipe as it will run, read off the effective DAG (state.liveDag — the
// recipe with this hub's tool swaps applied, see refreshLiveEffective), so
// swapping an app redraws it with that app's own inputs. Inputs (data and
// parameters) → apps → results → where the result is saved, each coloured
// by this hub's wizard state: green once it's settled (a dataset picked, a
// value or default set), red while still needed, amber for an app swapped
// for this run. Labels are escaped here — graphHtml inserts them as HTML,
// and app and input titles can come from third-party process descriptions.
// Returns null until the wizard has been opened and its DAG fetched.
export function getBuiltGraph(recipe) {
  const state = wizardStateCache.get(stateKey(recipe));
  if (!state || !state.liveDag) return null;
  const dag = state.liveDag;
  const nodes = [];
  const edges = [];
  const props = effectiveParamProps(state);
  const required = new Set((state.liveSchema && state.liveSchema.required) || []);
  const ingredientByInput = new Map(state.ingredients.map((ing) => [ing.ingredient.workflow_input_name, ing]));

  dag.workflow_inputs.forEach((name) => {
    const ing = ingredientByInput.get(name);
    if (ing) {
      const resolved = ing.slots.every(isSlotDataResolved);
      const slot = ing.slots[0];
      const format = slot && ((slot.selectedResource || {}).format || slot.feature.formatLabel);
      nodes.push({
        id: `in:${name}`,
        kind: "input",
        label: escapeHtml(ing.ingredient.role || name),
        sublabel: `data${format ? ` · ${escapeHtml(format)}` : ""}`,
        status: resolved ? "resolved" : ing.ingredient.optional ? "default" : "blocked",
      });
      return;
    }
    const prop = props[name] || {};
    const set = state.parameters[name] !== undefined;
    nodes.push({
      id: `in:${name}`,
      kind: "input",
      label: escapeHtml(prop.title || name),
      sublabel: "parameter",
      status: set ? "resolved" : required.has(name) ? "blocked" : "default",
    });
  });

  dag.steps.forEach((step) => {
    const swapped = !!state.toolOverrides[step.id];
    nodes.push({
      id: `step:${step.id}`,
      kind: "tool",
      label: escapeHtml(stepAppName(state, step)),
      sublabel: swapped ? "changed for this run" : escapeHtml(stepSublabel(state, step)),
      status: swapped ? "pending" : "resolved",
    });
    Object.values(step.inputs || {}).forEach((ref) => {
      edges.push({ from: ref.source_type === "workflow_input" ? `in:${ref.name}` : `step:${ref.step}`, to: `step:${step.id}` });
    });
  });

  const outputIds = [];
  (dag.workflow_outputs || []).forEach((out) => {
    const id = `out:${out.id}`;
    outputIds.push(id);
    nodes.push({ id, kind: "output", label: escapeHtml(out.id) });
    edges.push({ from: out.source_type === "workflow_input" ? `in:${out.name}` : `step:${out.step}`, to: id });
  });

  if (state.output.destinationDatasetId) {
    const hub = state.hubs.find((h) => h.id === state.output.destinationHubId);
    const dataset = state.allDatasets.find((d) => d.id === state.output.destinationDatasetId);
    nodes.push({
      id: "dest:data",
      kind: "destination",
      label: escapeHtml(dataset ? dataset.title : "Saved dataset"),
      sublabel: escapeHtml(hub ? `in ${hub.name}` : "in your hub"),
      status: "resolved",
    });
    outputIds.forEach((id) => edges.push({ from: id, to: "dest:data" }));
  }

  return { nodes, edges };
}

// Column titles for getBuiltGraph's graph (see recipeGraph.js's KIND_LABEL).
const BUILT_GRAPH_LABELS = { input: "Inputs", tool: "Apps", output: "Results", destination: "Saved to" };

// Every step is always reachable — a hub can jump straight to Output on a
// brand new recipe with nothing filled in yet. Nothing forces completing one
// step before seeing another: the Status tab (see ../liveRecipe.js) tracks
// everything still outstanding, and Deploy itself stays gated there.
function stepperHtml(state) {
  return `
    <div class="wizard-stepper">
      ${STEP_DEFS.map((s) => {
        const isCurrent = s.n === state.step;
        const done = isStepDone(state, s.n) && !isCurrent;
        const cls = [done ? "is-complete" : "", isCurrent ? "is-current" : "", "is-reachable"].filter(Boolean).join(" ");
        return `
        <div class="wizard-stepper__step ${cls}" data-goto-step="${s.n}">
          <div class="wizard-stepper__line"></div>
          <div class="wizard-stepper__dot">${done ? "✓" : s.n}</div>
          <div class="wizard-stepper__label">${s.label}</div>
        </div>`;
      }).join("")}
    </div>`;
}

// Next/Previous/Finish are never disabled — every step is reachable at all
// times (see wireEvents, stepperHtml). Leaving a step still marks it
// "attempted" (state.validationAttempted), so its own red warnings show if
// you come back to it — a pristine, never-visited step never greets you with
// a wall of red before you've done anything to it.
function stepNavHtml(state) {
  const isFirst = state.step === 1;
  const isLast = state.step === LAST_STEP;
  // Informational only — Finish always goes to the Status tab regardless;
  // this just sets expectations up front rather than after the click.
  const hint = isLast && !allStepsDone(state)
    ? "This recipe can't be deployed yet — some inputs are still incomplete. See the Status tab for the full list."
    : "";

  return `
    <div class="wizard-step-nav">
      <div>${!isFirst ? `<button type="button" class="btn btn-outline" id="wizard-prev">← Previous</button>` : ""}</div>
      <div style="display:flex;align-items:center;gap:14px;">
        ${hint ? `<span class="wizard-step-nav__hint">${hint}</span>` : ""}
        ${
          isLast
            ? `<button type="button" class="btn btn-primary" id="wizard-finish-btn">Review &amp; Execute</button>`
            : `<button type="button" class="btn btn-primary" id="wizard-next">Next →</button>`
        }
      </div>
    </div>`;
}

// A tool-catalog entry's inputs/outputs, shown wherever a live step's tool
// is picked — same shape as ../liveRecipe.js's own toolIoSummaryHtml (kept as
// a separate small copy rather than imported, for the same reason
// liveParamFieldHtml above is: liveRecipe.js imports FROM this file, so the
// reverse import would be circular).
function liveToolIoSummaryHtml(tool) {
  const ins = tool.inputs.map((i) => `${i.name} (${i.type})`).join(", ") || "—";
  const outs = tool.outputs.map((o) => `${o.name} (${o.type})`).join(", ") || "—";
  const url = toolProcessUrl(tool.id);
  const link = url ? `<br /><a href="${url}" target="_blank" rel="noopener">View live process ↗</a>` : "";
  return `<b>In:</b> ${ins}<br /><b>Out:</b> ${outs}${link}`;
}

// Tool & Engine content: one card per CWL step — the currently bound tool
// shown as an app card with its own icon, a "Change" action opening a register-style picker of
// this step's approved alternates (see TOOL_CATALOG), rather than a plain
// dropdown. Picking a different tool here is a per-run custom configuration
// recorded in state.toolOverrides, applied automatically server-side at
// deploy time (see liveRecipe.js's Status tab) and reflected live in the
// Parameters step (state.liveSchema/liveDag are refreshed via
// refreshLiveEffective whenever an override changes) — the recipe's own
// stored CWL is never touched; that only happens via the separate
// Orchestrator tab's Save Recipe.
function liveToolEngineStepHtml(state) {
  if (!state.liveDag) {
    return `
      <div class="notice-banner">
        Could not reach the Sandbox Stack backend for this recipe's pipeline. Is it running
        (<code>docker compose up</code> at the repo root)?
      </div>`;
  }
  const compatibleTools = state.liveDag.compatible_tools || {};
  return state.liveDag.steps
    .map((step) => {
      const currentToolId = state.toolOverrides[step.id] || step.process_id;
      const isOverridden = !!state.toolOverrides[step.id];
      const currentTool = findTool(currentToolId);
      // The recipe owner's own allowlist for this step (see the Orchestrator
      // tab's "Compatible Apps per Step" panel) — no entry means only this
      // step's own current tool is offered, not the whole catalog, until the
      // owner explicitly opens it up to alternates. The step's own current
      // tool is always included regardless of the allowlist, so what's
      // actually written in the recipe is never hidden from its own picker
      // (e.g. a hand-edited CWL step whose allowlist hasn't caught up yet).
      const allowedIds = new Set([step.process_id, ...(compatibleTools[step.id] || [])]);
      const options = TOOL_CATALOG.filter((t) => allowedIds.has(t.id));
      const pickerOpen = !!state.liveToolPickerOpen[step.id];

      let picker = "";
      if (pickerOpen) {
        picker = options.length
          ? `
        <div class="wizard-radio-body" style="padding-left:0;">
          <div class="field-label">Connected tools matching this requirement</div>
          ${options
            .map((t) => {
              const isBound = t.id === currentToolId;
              const fee = t.wizard_execution_fee || 0;
              return `
          <div class="wizard-app-option">
            <img src="assets/logo.svg" alt="${t.label} logo" />
            <div class="wizard-app-option__info">
              <div><b>${t.label}</b>${t.id === step.process_id ? ` <span class="badge badge-public">Recipe Default</span>` : ""}</div>
              <div class="wizard-ingredient__hint" style="margin:2px 0 0;">€${fee.toFixed(2)} execution fee</div>
              <div class="wizard-ingredient__hint" style="margin:2px 0 0;">${liveToolIoSummaryHtml(t)}</div>
            </div>
            <button type="button" class="btn ${isBound ? "btn-outline" : "btn-primary"} btn-sm" data-bind-live-tool="${step.id}|${t.id}">${isBound ? "Selected ✓" : "Select"}</button>
          </div>`;
            })
            .join("")}
          <button type="button" class="btn btn-outline btn-sm" style="margin-top:4px;" data-toggle-live-tool-picker="${step.id}">Cancel</button>
        </div>`
          : `
        <div class="wizard-radio-body" style="padding-left:0;">
          <p class="wizard-ingredient__hint">No connected tool in this hub matches this requirement yet.</p>
          <button type="button" class="btn btn-outline btn-sm" data-toggle-live-tool-picker="${step.id}">Cancel</button>
        </div>`;
      }

      const currentFee = currentTool ? (currentTool.wizard_execution_fee || 0) : 0;
      return `
        <div class="wizard-ingredient ${isOverridden ? "" : "is-resolved"}">
          <div class="wizard-ingredient__title">
            ${isOverridden ? "" : `<span class="wizard-ingredient__check">${icons.checkCircle}</span>`}
            ${escapeHtml(stepName(step))}
          </div>
          ${
            !pickerOpen
              ? `
          <div class="wizard-app-option">
            <img src="assets/logo.svg" alt="" />
            <div class="wizard-app-option__info">
              <div><b>${escapeHtml(stepAppName(state, step))}</b></div>
              <div class="wizard-ingredient__hint" style="margin:2px 0 0;">€${currentFee.toFixed(2)} execution fee</div>
            </div>
            <button type="button" class="btn btn-outline btn-sm" data-toggle-live-tool-picker="${step.id}" ${options.length < 2 ? "disabled" : ""}>Change</button>
          </div>`
              : ""
          }
          ${
            isOverridden
              ? `<p style="font-size:.78rem;color:var(--g-900);margin:4px 0 0;">Custom configuration for this run only — the recipe's own default is unchanged.</p>`
              : options.length < 2
              ? `<p style="font-size:.78rem;color:var(--g-900);margin:4px 0 0;">Its own default app is approved for this step — no alternates yet. The recipe owner can approve more on the Orchestrator tab.</p>`
              : ""
          }
          ${picker}
        </div>`;
    })
    .join("");
}

/** Re-fetches the effective schema/dag for a live recipe's CURRENT
 * toolOverrides and updates state in place — called after every override
 * change so the Parameters step (and this step's own "current tool" reads)
 * never drift from what a deploy would actually run. */
async function refreshLiveEffective(state, recipe) {
  try {
    const { schema, dag } = await sandboxApi.getEffectiveRecipe(recipe.recipe_id, state.toolOverrides);
    state.liveSchema = schema;
    state.liveDag = dag;
  } catch {
    // Leave the previous schema/dag in place rather than blanking the step —
    // a transient failure here shouldn't lose what was already shown.
  }
  await loadProcessHints(state);
  syncParamDefaults(state);
}

// Each step's OGC API Process description, fetched once per session: process
// URL -> Promise<description | null>. A failure (e.g. a process that is down)
// just means no hints for its inputs, never a broken Parameters step.
const processDescriptionCache = new Map();

// Where a step's OGC API Process description lives, as a browser can reach
// it: this stack's own tools at their browser-facing address (a bundled
// recipe's own href may say localhost), anything else at its process link.
function stepProcessUrl(step) {
  return toolProcessUrl(step.process_id) || (step.process_link && step.process_link.href) || null;
}

/** The same address, for a person to open: asks for JSON explicitly (OGC API
 * `f=json`), since some servers answer a browser with an HTML page. Null when
 * the step has no known process address. */
export function processDescriptionLink(step) {
  const url = stepProcessUrl(step);
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!u.searchParams.has("f")) u.searchParams.set("f", "json");
    return u.toString();
  } catch {
    return url;
  }
}

function stepProcessDescription(step) {
  // This stack's own tools are fetched directly; anything else through the
  // Cookbook Registry's proxy, since a third-party server can't be assumed
  // to allow this origin (CORS).
  const ownUrl = toolProcessUrl(step.process_id);
  const url = stepProcessUrl(step);
  if (!url) return Promise.resolve(null);
  if (!processDescriptionCache.has(url)) {
    const request = ownUrl
      ? fetch(url, { headers: { Accept: "application/json" } }).then((r) => (r.ok ? r.json() : null))
      : sandboxApi.fetchExternalProcessDescription(url);
    processDescriptionCache.set(url, request.catch(() => null));
  }
  return processDescriptionCache.get(url);
}

// What each step's process says about the workflow input wired into it —
// its OGC API Processes input description ({title, description, schema}),
// keyed by workflow input name — in state.processHints, and each step's app
// title in state.stepApps. A slow process is waited on for a few seconds at
// most; its hints then appear on a later render, once its (cached)
// description has arrived. Exported (taking any {liveDag, liveSchema,
// toolOverrides} object, not just the Wizard's state) for ../liveRecipe.js's
// Status tab, which shows the same parameters the same way.
export async function loadProcessHints(state) {
  const steps = (state.liveDag && state.liveDag.steps) || [];
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 5000));
  const descriptions = new Map(
    await Promise.all(steps.map(async (s) => [s.id, await Promise.race([stepProcessDescription(s), timeout])]))
  );
  // Each step's app as its description names it (see stepAppName).
  state.stepApps = Object.fromEntries(
    [...descriptions].filter(([, desc]) => desc).map(([stepId, desc]) => [stepId, { title: desc.title, description: desc.description }])
  );
  const hints = {};
  for (const name of Object.keys((state.liveSchema && state.liveSchema.properties) || {})) {
    for (const u of paramUsage(state.liveDag, state.toolOverrides, name)) {
      const input = descriptions.get(u.step.id)?.inputs?.[u.localName];
      if (input) {
        hints[name] = input;
        break;
      }
    }
  }
  state.processHints = hints;
}

const SCHEMA_LIMITS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "pattern"];

// The schema a parameter's field is drawn from: the recipe's own (from its
// CWL type, label, doc, default and any nldt:jsonSchema), completed by the
// process description of the step it feeds wherever the recipe says nothing
// itself — its title, description, default and limits, and, for an untyped
// (`Any`) input, the whole input schema, so the form can offer a template.
// The recipe always wins; the process only fills gaps.
function effectiveParamProp(prop, hint) {
  if (!hint) return prop;
  const schema = hint.schema || {};
  const untyped = !Object.keys(prop).some((k) => !["title", "description", "default"].includes(k));
  const merged = untyped ? { ...schema, ...prop } : { ...prop };
  if (merged.default === undefined && schema.default !== undefined) merged.default = schema.default;
  SCHEMA_LIMITS.forEach((k) => {
    if (merged[k] === undefined && schema[k] !== undefined) merged[k] = schema[k];
  });
  if (!prop.title && hint.title) merged.title = hint.title;
  if (!prop.description && hint.description) merged.description = hint.description;
  // The recipe's own description may be terser than the process's — show
  // the process's too, after it.
  else if (hint.description && hint.description !== prop.description) merged.processDescription = hint.description;
  return merged;
}

export function effectiveParamProps(state) {
  const props = (state.liveSchema && state.liveSchema.properties) || {};
  const hints = state.processHints || {};
  return Object.fromEntries(Object.entries(props).map(([name, prop]) => [name, effectiveParamProp(prop, hints[name])]));
}

// A parameter the user hasn't typed into takes its default — the recipe's,
// or else its process's — so an untouched field still sends a value. Runs
// on every refresh, so swapping a step's tool picks up the new tool's
// defaults; never touches a value the user entered (state.typedParams).
function syncParamDefaults(state) {
  for (const [name, prop] of Object.entries(effectiveParamProps(state))) {
    if (state.typedParams.has(name)) continue;
    state.parameters[name] = prop.default ?? undefined;
  }
}

/** Reads back whatever per-run tool overrides have been picked on the
 * Wizard's Tool & Engine step for a live recipe — `{}` if the Wizard has
 * never been opened for this recipe yet, or nothing's been changed from its
 * defaults. The Status tab (see ../liveRecipe.js) sends this straight to
 * sandboxApi.executeRecipe rather than persisting it anywhere. */
export function getLiveToolOverrides(recipe) {
  const state = wizardStateCache.get(stateKey(recipe));
  return state ? state.toolOverrides : {};
}

// This recipe's own output format(s) — fixed by whoever built it (e.g. "3D
// Tiles" for a flood extent, "GeoJSON" for a routing result). Never
// user-configurable; the Output step only asks WHERE to persist it, not in
// what shape.
function outputFormatsFor(recipe) {
  return (recipe.output_schema || []).map((o) => o.output_type);
}

function dataDestinationCardHtml(state, recipe) {
  // A recipe with a fixed destination (every live testbed recipe — see
  // data.js's fixed_output_destination) still shows the hub and dataset
  // pickers, so the step reads as it would in a full App Store, but locked
  // to that destination: it's where the Status tab really saves the result.
  const fixed = recipe.fixed_output_destination;
  if (fixed) {
    state.output.destinationHubId = fixed.hubId;
    state.output.destinationDatasetId = fixed.datasetId;
  }
  const lock = fixed ? `disabled aria-disabled="true" title="Fixed for this testbed"` : "";
  const datasetsForHub = state.output.destinationHubId
    ? state.allDatasets.filter((d) => d.owner_hub_id === state.output.destinationHubId)
    : [];
  if (fixed && !datasetsForHub.some((d) => d.id === fixed.datasetId)) {
    datasetsForHub.push({ id: fixed.datasetId, title: fixed.datasetTitle });
  }
  const hubs = fixed && !state.hubs.some((h) => h.id === fixed.hubId) ? [...state.hubs, { id: fixed.hubId, name: fixed.hubName }] : state.hubs;
  const showValidation = state.validationAttempted.has(state.step) && !fixed;
  const formats = outputFormatsFor(recipe);
  return `
    <div class="wizard-output-card">
      <div class="wizard-output-card__title">Data Destination &amp; Export</div>
      ${
        formats.length
          ? `<div class="field-group">
        <span class="field-label">Output format (fixed by this recipe)</span>
        <div class="chip-row" style="margin-bottom:0;">
          ${formats.map((f) => `<span class="badge badge-public">${f}</span>`).join("")}
        </div>
      </div>`
          : ""
      }
      <div class="field-group">
        <label class="field-label" for="wizard-dest-hub">Save to hub</label>
        <select id="wizard-dest-hub" class="${showValidation && !state.output.destinationHubId ? "is-missing" : ""}" ${lock}>
          <option value="">— Select a hub —</option>
          ${hubs
            .map((h) => `<option value="${h.id}" ${state.output.destinationHubId === h.id ? "selected" : ""}>${h.name}</option>`)
            .join("")}
        </select>
      </div>
      <div class="field-group">
        <label class="field-label" for="wizard-dest-dataset">Save to dataset</label>
        <select id="wizard-dest-dataset" class="${showValidation && !state.output.destinationDatasetId && state.output.destinationHubId ? "is-missing" : ""}" ${fixed ? lock : !state.output.destinationHubId ? "disabled" : ""}>
          <option value="">— Select a dataset —</option>
          ${datasetsForHub
            .map((d) => `<option value="${d.id}" ${state.output.destinationDatasetId === d.id ? "selected" : ""}>${d.title}</option>`)
            .join("")}
        </select>
        ${
          state.output.destinationHubId && datasetsForHub.length === 0
            ? `<p class="wizard-ingredient__hint" style="margin-top:6px;">No datasets registered in this hub yet.</p>`
            : ""
        }
      </div>
      ${
        fixed
          ? `<p class="wizard-ingredient__hint" style="margin:-4px 0 0;">
               Fixed for this testbed: every recipe's result is saved to <b>${escapeHtml(fixed.datasetTitle)}</b> in
               ${escapeHtml(fixed.hubName)}. In a full App Store, you would choose the hub and dataset here.
             </p>`
          : ""
      }
      ${showValidation && !(state.output.destinationHubId && state.output.destinationDatasetId) ? `<p class="wizard-missing-hint">⚠ Choose a hub and dataset to continue.</p>` : ""}
    </div>`;
}

function cartHtml(state, recipe) {
  const lines = computeCartLines(state, recipe);
  const total = lines.reduce((s, l) => s + l.price, 0);
  return `
    <div class="wizard-cart__title">${icons.cart} Setup Summary</div>
    ${lines
      .map(
        (l) => `
      <div class="wizard-cart__line">
        <div class="wizard-cart__line-top"><span>${l.label}</span><span>${l.priceLabel}</span></div>
        ${l.sublabel ? `<div class="wizard-cart__line-sub">${l.sublabel}</div>` : ""}
      </div>`
      )
      .join("")}
    <div class="wizard-cart__total"><span>Total</span><span>€${total.toFixed(2)}</span></div>
  `;
}

// Same facet set as the plain Datasets catalogue (unlike the recipe's
// trimmed "Compatible Data" tab), since this popup should offer the full
// filtering functionality — just scoped to resources this ingredient
// actually accepts, and pre-set to the recipe's own accepted formats.
const MODAL_FACETS = [
  // Formats comes first — it's the one facet pre-set by the recipe itself,
  // so putting it at the top makes that preset immediately obvious.
  { key: "format", label: "Formats", values: (d) => d.resources.map((r) => r.format) },
  { key: "owner_hub_name", label: "Owner hubs", values: (d) => [d.owner_hub_name] },
  { key: "part_of_hub", label: "Part of hub", values: (d) => [d.owner_hub_name] },
  { key: "findability", label: "Findability", values: (d) => [d.findability] },
  { key: "tags", label: "Tags", values: (d) => d.tags || [] },
];

function uniqueValues(items, facet) {
  const set = new Set();
  items.forEach((i) => facet.values(i).forEach((v) => set.add(v)));
  return [...set].sort();
}

function modalFacetHtml(facet, datasets, state) {
  const values = uniqueValues(datasets, facet);
  const isOpen = state.openFacets.has(facet.key);
  const hasActive = state.selected[facet.key].size > 0;
  const searchTerm = (state.facetSearch[facet.key] || "").toLowerCase();
  const visibleValues = searchTerm ? values.filter((v) => v.toLowerCase().includes(searchTerm)) : values;

  return `
    <div class="facet ${isOpen ? "is-open" : ""}" data-facet="${facet.key}">
      <button type="button" class="facet__header" data-facet-toggle="${facet.key}">
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
              const checked = state.selected[facet.key].has(v);
              // Count matching occurrences, not matching datasets — a format
              // like "3D Tiles" can appear as several resources within one
              // dataset, and each of those is a separately selectable row.
              const count = datasets.reduce((sum, d) => sum + facet.values(d).filter((x) => x === v).length, 0);
              return `
          <label class="facet__option">
            <input type="checkbox" data-facet-value="${facet.key}|${v}" ${checked ? "checked" : ""} />
            <span class="facet__option-label">${v}</span>
            <span class="facet__count">${count}</span>
          </label>`;
            })
            .join("") || `<p class="facet__empty">No matches.</p>`
        }
      </div>
    </div>`;
}

function modalGeoAndRatingHtml() {
  return `
    <div class="facet" data-facet="geo">
      <button type="button" class="facet__header" data-facet-toggle="geo">
        <span>Geographical search</span>
        ${icons.chevronDown}
      </button>
      <div class="facet__options">
        <input type="text" placeholder="Search by city or postcode" disabled title="Mocked — not wired up in this phase" />
      </div>
    </div>
    <div class="facet" data-facet="ratings">
      <button type="button" class="facet__header" data-facet-toggle="ratings">
        <span>Ratings</span>
        ${icons.chevronDown}
      </button>
      <div class="facet__options">
        ${[5, 4, 3, 2, 1].map((n) => `<label class="facet__option"><input type="checkbox" disabled /><span class="facet__option-label">${"★".repeat(n)}${"☆".repeat(5 - n)} &amp; up</span></label>`).join("")}
      </div>
    </div>`;
}

function sortResults(list, sortBy) {
  const sorted = [...list];
  if (sortBy === "name") sorted.sort((a, b) => a.title.localeCompare(b.title));
  else if (sortBy === "owner") sorted.sort((a, b) => a.owner_hub_name.localeCompare(b.owner_hub_name));
  return sorted;
}

// A dataset is a folder of named resources (e.g. "Rotterdam City Base Data"
// containing "Elevation Model" (WMS), "Tree Inventory (3D)" (3D Tiles), …).
// The popup shows the dataset as a parent row (title + owner hub, since the
// hub owns the whole dataset) and its resources as selectable children
// underneath. When the modal is filling more than one slot at once (e.g. a
// recipe asking for one geojson AND one wms), each resource row shows one
// small radio per slot it's eligible for, so one resource can only ever be
// assigned to one slot.
function resourceChildHtml(resource, slots, assignments, isEligible) {
  const eligible = slots.map((slot, idx) => ({ slot, idx })).filter(({ slot }) => isEligible(slot, resource));
  const allFilled = assignments.every((a) => a !== null);
  const usedElsewhere = (idx) => assignments.some((id, otherIdx) => otherIdx !== idx && id === resource.id);
  const formatBadge = `<span class="resource-tree__child-format"><span class="badge badge-public">${resource.format}</span></span>`;

  if (eligible.length === 0) {
    // Doesn't fit any open slot (e.g. a resource whose
    // format isn't one of the required ones) — shown for context, not pickable.
    return `
    <div class="resource-tree__child">
      <span class="resource-tree__child-name">${resource.name}</span>
      ${formatBadge}
      <span></span>
    </div>`;
  }

  if (eligible.length === 1) {
    // The common case — exactly one slot this resource could fill, so the
    // whole row acts as its radio's label (click anywhere to pick it).
    const { idx } = eligible[0];
    const checked = assignments[idx] === resource.id;
    const disabled = usedElsewhere(idx) || (allFilled && !checked);
    return `
    <label class="resource-tree__child">
      <span class="resource-tree__child-name">
        <input type="radio" name="modal-resource-slot-${idx}" value="${resource.id}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} />
        ${resource.name}
      </span>
      ${formatBadge}
      <span></span>
    </label>`;
  }

  // Eligible for more than one open slot at once (two slots of the same
  // format) — one small labeled radio per slot so it's clear which
  // requirement it fills.
  const picksHtml = eligible
    .map(({ slot, idx }) => {
      const checked = assignments[idx] === resource.id;
      const disabled = usedElsewhere(idx) || (allFilled && !checked);
      return `
        <label class="resource-tree__slot-pick" title="Assign to ${slot.feature.name}">
          <input type="radio" name="modal-resource-slot-${idx}" value="${resource.id}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} />
          <span class="resource-tree__slot-pick-label">${slot.feature.name}</span>
        </label>`;
    })
    .join("");
  return `
    <div class="resource-tree__child">
      <span class="resource-tree__child-name">${picksHtml}${resource.name}</span>
      ${formatBadge}
      <span></span>
    </div>`;
}

function resourceGroupHtml(dataset, state, slots, assignments, isEligible) {
  const isOpen = state.expandedGroups.has(dataset.id);
  return `
    <div class="resource-tree__group">
      <button type="button" class="resource-tree__parent" data-group-toggle="${dataset.id}">
        <span class="resource-tree__parent-name">
          ${isOpen ? icons.chevronDown : icons.chevronRight}
          ${dataset.title}
        </span>
        <span></span>
        <span class="resource-tree__parent-owner">${dataset.owner_hub_name}</span>
      </button>
      ${isOpen ? dataset.resources.map((r) => resourceChildHtml(r, slots, assignments, isEligible)).join("") : ""}
    </div>`;
}

function resourceTreeHtml(groups, state, slots, assignments, isEligible) {
  if (!groups.length) return `<div class="empty-state">No matching resources.</div>`;
  return `
    <div class="resource-tree">
      <div class="resource-tree__header"><span>Name</span><span>Format</span><span>Owner Hub</span></div>
      ${groups.map((d) => resourceGroupHtml(d, state, slots, assignments, isEligible)).join("")}
    </div>`;
}

// A small progress readout above the results when more than one slot needs
// filling — makes it obvious how many of the recipe's required formats are
// still outstanding (e.g. "1 / 2 assigned — still need: wms").
function slotProgressHtml(slots, assignments) {
  const filledCount = assignments.filter(Boolean).length;
  const outstanding = slots.filter((_, idx) => !assignments[idx]).map((s) => s.feature.formatLabel);
  return `
    <p class="wizard-ingredient__hint" style="margin:0 0 10px;">
      <b>${filledCount} / ${slots.length}</b> assigned${outstanding.length ? ` — still need: <b>${outstanding.join(", ")}</b>` : " — all set."}
    </p>`;
}

function findResourceById(datasets, resourceId) {
  for (const dataset of datasets) {
    const resource = dataset.resources.find((r) => r.id === resourceId);
    if (resource) return { dataset, resource };
  }
  return null;
}

// Opens the resource picker for one or more slots at once. Only resources
// matching each slot's required format are shown — picking one for a format
// locks out the rest of that format's resources via the native per-slot
// radio group, and once every slot is filled the whole list locks.
async function openResourceModal(ing, slots, onDone) {
  const datasets = await api.getDatasets();
  // Every catalogue format any slot accepts; null when a slot accepts any
  // format (unknown media type), in which case nothing is filtered out.
  const requiredFormats = slots.some((s) => !s.feature.formats) ? null : [...new Set(slots.flatMap((s) => s.feature.formats))];

  const baseCandidates = datasets
    .map((d) => ({ ...d, resources: d.resources.filter((r) => !requiredFormats || requiredFormats.includes(r.format)) }))
    .filter((d) => d.resources.length > 0);

  const isEligible = resourceFitsSlot;

  // assignments[idx] mirrors slots[idx].selectedResource — the modal works
  // off this local array while open, and only writes back to the real slots
  // (by reference) once Confirm is pressed.
  const assignments = slots.map((s) => (s.selectedResource ? s.selectedResource.id : null));

  const preFilledDatasetIds = assignments.length
    ? datasets.filter((d) => d.resources.some((r) => assignments.includes(r.id))).map((d) => d.id)
    : [];

  // Preset (not lock) the Owner Hubs facet to whichever hub is currently
  // active — the common case opening this picker is "resolve this against
  // my own hub's data," not "browse every dataset from every hub in the
  // platform." Unlike the Format facet, this is a plain, one-time-applied
  // preset: the checkbox is exactly as removable as any other facet value.
  // Skipped where it couldn't help: an active hub that owns none of the
  // current candidates would just preset to a silently empty result.
  const activeHubName = getActiveHubName();
  const presetOwnerHub = !!activeHubName && baseCandidates.some((d) => d.owner_hub_name === activeHubName);

  const state = {
    query: "",
    sortBy: "relevance",
    openFacets: new Set(["format", ...(presetOwnerHub ? ["owner_hub_name"] : [])]),
    facetSearch: {},
    // Every dataset starts expanded, so all candidate resources are visible
    // at once instead of having to open each dataset to find them (a
    // dataset can still be collapsed by clicking its row).
    expandedGroups: new Set([...baseCandidates.map((d) => d.id), ...preFilledDatasetIds]),
    selected: {
      owner_hub_name: new Set(presetOwnerHub ? [activeHubName] : []),
      part_of_hub: new Set(),
      findability: new Set(),
      tags: new Set(),
      format: new Set(requiredFormats || []),
    },
  };

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

  // Narrows each candidate dataset down to just the resources that pass the
  // Formats facet and the search query, then drops datasets left with none.
  function matchingDatasets() {
    const q = state.query.trim().toLowerCase();
    const nonFormatFacets = MODAL_FACETS.filter((f) => f.key !== "format");
    return baseCandidates
      .filter((d) => nonFormatFacets.every((facet) => {
        const chosen = state.selected[facet.key];
        return chosen.size === 0 || facet.values(d).some((v) => chosen.has(v));
      }))
      .map((d) => {
        const resources = d.resources.filter((r) => {
          if (state.selected.format.size > 0 && !state.selected.format.has(r.format)) return false;
          if (q) return d.title.toLowerCase().includes(q) || d.owner_hub_name.toLowerCase().includes(q) || r.name.toLowerCase().includes(q);
          return true;
        });
        return { ...d, resources };
      })
      .filter((d) => d.resources.length > 0);
  }

  function paintModal() {
    const groups = sortResults(matchingDatasets(), state.sortBy);
    const allFilled = assignments.every((a) => a !== null);
    overlay.innerHTML = `
      <div class="modal-panel">
        <div class="modal-panel__header">
          <h2>Select Resources — ${titleCase(ing.ingredient.role)}</h2>
          <button type="button" class="modal-panel__close" aria-label="Close">${icons.close}</button>
        </div>
        <div class="modal-panel__body">
          <aside class="modal-panel__filters">
            <div class="search-box">${icons.search}<input type="text" id="modal-search" placeholder="Search resources" value="${state.query}" /></div>
            <div class="filter-section">
              <div class="filter-section__title">Sort ${icons.sort}</div>
              <div style="padding:10px 2px 14px;">
                <label class="field-label" for="modal-sort" style="margin-bottom:6px;">Sort by</label>
                <select id="modal-sort">
                  <option value="relevance" ${state.sortBy === "relevance" ? "selected" : ""}>Relevance</option>
                  <option value="name" ${state.sortBy === "name" ? "selected" : ""}>Name</option>
                  <option value="owner" ${state.sortBy === "owner" ? "selected" : ""}>Owner</option>
                </select>
              </div>
            </div>
            <div class="filter-section">
              <div class="filter-section__title">Filter ${icons.refresh}</div>
              <div id="modal-filter-facets">
                ${MODAL_FACETS.map((f) => modalFacetHtml(f, baseCandidates, state)).join("")}
                ${modalGeoAndRatingHtml()}
              </div>
            </div>
          </aside>
          <div class="modal-panel__results">
            <div class="notice-banner" style="margin-bottom:12px;">
              ${
                requiredFormats
                  ? `Showing resources in a format that fits <b>${escapeHtml(slots[0].feature.formatLabel)}</b> (${requiredFormats.map(escapeHtml).join(", ")}).`
                  : "This data input doesn't declare a known format, so every resource is listed."
              }
              The recipe receives the picked resource's URL, not a copy of its data.
            </div>
            ${slots.length > 1 ? slotProgressHtml(slots, assignments) : ""}
            ${resourceTreeHtml(groups, state, slots, assignments, isEligible)}
          </div>
        </div>
        <div class="modal-panel__footer">
          <button type="button" class="btn btn-outline" id="modal-cancel">Cancel</button>
          <button type="button" class="btn btn-primary" id="modal-confirm" ${allFilled ? "" : "disabled"}>Confirm Selection</button>
        </div>
      </div>`;
    wireModal();
  }

  function wireModal() {
    overlay.querySelector(".modal-panel__close").addEventListener("click", close);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelector("#modal-cancel").addEventListener("click", close);

    const searchInput = overlay.querySelector("#modal-search");
    searchInput.addEventListener("input", (e) => {
      state.query = e.target.value;
      paintModal();
      const el = overlay.querySelector("#modal-search");
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });

    overlay.querySelector("#modal-sort").addEventListener("change", (e) => {
      state.sortBy = e.target.value;
      paintModal();
    });

    overlay.querySelectorAll("[data-facet-toggle]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-facet-toggle");
        if (state.openFacets.has(key)) state.openFacets.delete(key);
        else state.openFacets.add(key);
        paintModal();
      })
    );

    overlay.querySelectorAll("[data-facet-value]").forEach((cb) =>
      cb.addEventListener("change", () => {
        const [key, value] = cb.getAttribute("data-facet-value").split("|");
        if (cb.checked) state.selected[key].add(value);
        else state.selected[key].delete(value);
        paintModal();
      })
    );

    overlay.querySelectorAll("[data-facet-search]").forEach((input) =>
      input.addEventListener("input", (e) => {
        const key = e.target.getAttribute("data-facet-search");
        state.facetSearch[key] = e.target.value;
        paintModal();
        overlay.querySelector(`[data-facet-search="${key}"]`).focus();
      })
    );

    overlay.querySelectorAll("[data-group-toggle]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const datasetId = btn.getAttribute("data-group-toggle");
        if (state.expandedGroups.has(datasetId)) state.expandedGroups.delete(datasetId);
        else state.expandedGroups.add(datasetId);
        paintModal();
      })
    );

    overlay.querySelectorAll('input[name^="modal-resource-slot-"]').forEach((radio) =>
      radio.addEventListener("change", () => {
        const slotIndex = +radio.name.replace("modal-resource-slot-", "");
        assignments[slotIndex] = radio.value;
        paintModal();
      })
    );

    overlay.querySelector("#modal-confirm").addEventListener("click", () => {
      assignments.forEach((resourceId, idx) => {
        if (!resourceId) return;
        const found = findResourceById(datasets, resourceId);
        if (!found) return;
        slots[idx].selectedResource = {
          id: found.resource.id,
          name: found.resource.name,
          format: found.resource.format,
          // Where the data can be fetched — becomes the CWL File's location
          // at deploy time (see ../liveRecipe.js).
          location: sandboxApi.resourceDataUrl(found.dataset.id, found.resource),
          datasetId: found.dataset.id,
          datasetTitle: found.dataset.title,
          owner_hub_name: found.dataset.owner_hub_name,
        };
      });
      onDone();
      close();
    });
  }

  paintModal();
}

/**
 * Renders the Recipe Wizard tab — a step-by-step flow that picks the tool for
 * each of this recipe's CWL steps, resolves its data ingredients against the
 * hub's own resources, collects its typed parameters, and fixes where its
 * output is saved.
 * options.topTabsHtml: the shared tab bar, rendered above like every other tab.
 */
export async function render(container, recipe, ctx, options = {}) {
  // Reuse the same state across tab switches (Wizard ↔ Status ↔ back) so a
  // hub's selections survive navigating away, and so the Status tab can read
  // them (see getLiveParameters / getLiveIngredients / getLiveToolOverrides).
  let state = wizardStateCache.get(stateKey(recipe));
  if (!state) {
    const [hubs, allDatasets] = await Promise.all([api.getAllHubsFlat(), api.getDatasets()]);

    // liveSchema/liveDag start null here — they're fetched fresh below,
    // *every* render() call (not just this first one), so a CWL change saved
    // via the Orchestrator tab always shows up, not just on first visit.
    state = {
      liveSchema: null,
      liveDag: null,
      // stepId -> tool id — only entries the hub actually changed for THIS
      // run; never written back to the recipe's own stored CWL (see
      // getLiveToolOverrides / liveRecipe.js's Status tab, which sends this
      // straight to executeRecipe rather than persisting it anywhere).
      toolOverrides: {},
      // Which steps' "Change" register picker is currently open — keyed by
      // step id, since state.liveDag.steps are refetched (and thus replaced)
      // on every render() call.
      liveToolPickerOpen: {},
      parameters: {},
      // Parameter names the user has typed a value into. Every other
      // parameter holds its default (see syncParamDefaults), shown as the
      // field's placeholder rather than as typed text.
      typedParams: new Set(),
      processHints: {},
      hubs,
      allDatasets,
      step: 1,
      // Which step numbers have had a Next/Finish click — only then do that
      // step's red warnings actually render (see stepNavHtml).
      validationAttempted: new Set(),
      ingredients: (recipe.input_datasets || []).map(newIngredientState),
      output: {
        // A recipe with a fixed_output_destination (see
        // data.js::liveRecipeToViewShape) always saves there, for real —
        // pre-filled rather than left for a hub to "choose".
        destinationHubId: recipe.fixed_output_destination ? recipe.fixed_output_destination.hubId : getActiveHubId() || null,
        destinationDatasetId: recipe.fixed_output_destination ? recipe.fixed_output_destination.datasetId : null,
      },
    };
    wizardStateCache.set(stateKey(recipe), state);
  }

  // Unlike everything else cached above (which is a hub's own in-progress
  // choices, meant to survive tab switches), the recipe's schema/dag are
  // server truth — refreshed on EVERY render() call, not just the first, so
  // saving a change in the Orchestrator tab (a swapped default tool, a newly
  // approved compatible app, an added step...) shows up the moment the
  // Wizard is reopened, never a stale snapshot from whenever it was first
  // visited this session. It also fills every parameter the hub hasn't typed
  // into with its default (see syncParamDefaults), never a typed value.
  await refreshLiveEffective(state, recipe);
  syncIngredients(state);

  function paint() {
    let stepTitle = "";
    let stepHint = "";
    let body = "";
    // Every step shows the whole recipe's graph above its own controls, so
    // the user always sees what they're configuring and where it fits. Read
    // fresh from wizardStateCache on every single paint() so it can never
    // show a stale shape; `graphNote` says what this step changes in it.
    let graphNote = "";
    if (state.step === 1) {
      stepTitle = "Step 1. Tool &amp; Engine Selection";
      stepHint =
        "This recipe's CWL steps are each backed by a real OGC API Process — pick a different app for any of them to run this recipe with a custom configuration, just for you. The recipe's own default is never changed.";
      graphNote = "Change an app below and the graph updates with that app's own inputs.";
      body = liveToolEngineStepHtml(state);
    } else if (state.step === 2) {
      stepTitle = "Step 2. Select &amp; Validate Data Ingredients";
      stepHint = "The data inputs below are required by this recipe's tools. Select which of your hub's resources to use for each one.";
      graphNote = state.ingredients.length
        ? "Each data input turns green once you pick a dataset for it below."
        : "This recipe needs no datasets — all its inputs are parameters.";
      body =
        (state.ingredients.length ? recipeRequirementsHtml(recipe) : "") +
        dataIngredientsStepHtml(state, state.validationAttempted.has(state.step));
    } else if (state.step === 3) {
      stepTitle = "Step 3. Parameters";
      stepHint =
        "These are the settings each app in this recipe needs. Where an app suggests a value, it is shown in grey and used if you leave the field empty; type to use your own.";
      graphNote = "The parameters below are the inputs each app reads, as shown in the graph.";
      body = parametersStepHtml(state);
    } else {
      stepTitle = "Step 4. Output";
      stepHint = recipe.fixed_output_destination
        ? "This recipe only produces data. Here is where the result is saved once the run finishes."
        : "This recipe only produces data — choose where in the OUP it should be saved once the run finishes.";
      graphNote = "Where the result is saved appears at the end of the graph.";
      body = dataDestinationCardHtml(state, recipe);
    }
    const graph = getBuiltGraph(recipe);
    if (graph) {
      body =
        graphHtml(graph, {
          title: "Recipe Schema",
          hint:
            `The whole recipe as it will run: the data and parameters each app needs, the apps, their results, and where the result is saved. ${graphNote} ` +
            "Green: ready · Red: still needed · Amber: an app you changed for this run.",
          kindLabels: BUILT_GRAPH_LABELS,
        }) + body;
    }

    container.innerHTML = `
      <div class="detail-shell">
        ${options.topTabsHtml || ""}
        ${stepperHtml(state)}
        <div class="wizard-layout">
          <div class="wizard-main">
            <div class="wizard-step is-active">
              <div class="wizard-step__title">${stepTitle}</div>
              <p class="wizard-step__hint">${stepHint}</p>
              ${body}
              ${stepNavHtml(state)}
            </div>
          </div>
          <aside class="wizard-cart">
            ${cartHtml(state, recipe)}
          </aside>
        </div>
      </div>`;

    // Node positions only exist once the HTML above is actually in the live
    // DOM — reading layout right after a mutation forces the browser to
    // compute it, so this can run synchronously right here (same pattern as
    // recipeDetail.js's own graph tabs).
    if (graph) drawGraphConnectors(container.querySelector("[data-graph-root]"), graph.edges);

    wireEvents();
  }

  // Reads one structuredParamControlHtml widget back into a JSON value, or
  // undefined (empty, or not parseable — the reason shown right under it).
  function readStructuredParam(name, kind, el) {
    const errorEl = container.querySelector(`[data-param-error="${name}"]`);
    const fail = (msg) => {
      if (errorEl) errorEl.textContent = msg;
      return undefined;
    };
    if (errorEl) errorEl.textContent = "";
    if (kind === "enum-multi") {
      const picked = [...container.querySelectorAll(`[data-param-name="${name}"]:checked`)].map((c) => c.value);
      return picked.length ? picked : undefined;
    }
    const text = el.value.trim();
    if (!text) return undefined;
    if (kind === "json") {
      try {
        return JSON.parse(text);
      } catch (err) {
        return fail(`Not valid JSON yet: ${err.message}`);
      }
    }
    const parts = text.split(",").map((s) => s.trim()).filter(Boolean);
    if (kind === "list-string") return parts;
    const numbers = parts.map(Number);
    const bad = parts.filter((_, i) => Number.isNaN(numbers[i]) || (kind === "list-integer" && !Number.isInteger(numbers[i])));
    return bad.length ? fail(`Not ${kind === "list-integer" ? "whole numbers" : "numbers"}: ${bad.join(", ")}`) : numbers;
  }

  function wireEvents() {
    // No paint() call here, deliberately — this fires on every keystroke, and
    // paint() fully replaces container.innerHTML, which would drop focus out
    // of the field the user is actively typing into. Nothing else on this
    // step needs to react live to a parameter value changing.
    container.querySelectorAll("[data-param-name]").forEach((el) => {
      const name = el.getAttribute("data-param-name");
      el.addEventListener(el.type === "checkbox" ? "change" : "input", () => {
        const kind = el.getAttribute("data-param-kind");
        // A cleared text field goes back to "not typed", i.e. its default
        // again (see syncParamDefaults) — or, with no default, to "not
        // given", so an optional input is left out. Never an empty string.
        if (el.type !== "checkbox" && el.value.trim() === "") {
          state.typedParams.delete(name);
          syncParamDefaults(state);
          if (kind) readStructuredParam(name, kind, el); // clears a stale error
          return;
        }
        state.typedParams.add(name);
        if (kind) state.parameters[name] = readStructuredParam(name, kind, el);
        else if (el.type === "checkbox") state.parameters[name] = el.checked;
        else if (el.type === "number") state.parameters[name] = Number(el.value);
        else state.parameters[name] = el.value;
      });
    });

    container.querySelectorAll("[data-toggle-live-tool-picker]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const stepId = btn.getAttribute("data-toggle-live-tool-picker");
        state.liveToolPickerOpen[stepId] = !state.liveToolPickerOpen[stepId];
        paint();
      })
    );

    container.querySelectorAll("[data-bind-live-tool]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const [stepId, toolId] = btn.getAttribute("data-bind-live-tool").split("|");
        const step = (state.liveDag.steps || []).find((s) => s.id === stepId);
        // Only record an override when it actually differs from the step's
        // own default — keeps toolOverrides minimal and lets "picking the
        // original tool back" cleanly mean "no override", not "override
        // set to the same thing".
        if (step && toolId === step.process_id) delete state.toolOverrides[stepId];
        else state.toolOverrides[stepId] = toolId;
        state.liveToolPickerOpen[stepId] = false;
        paint();
        await refreshLiveEffective(state, recipe);
        paint();
      })
    );

    container.querySelectorAll("[data-select-slot]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const [ingIndex, slotIndex] = btn.getAttribute("data-select-slot").split("|").map(Number);
        const ing = state.ingredients[ingIndex];
        const slot = ing.slots[slotIndex];
        openResourceModal(ing, [slot], () => paint());
      })
    );

    const destHubSelect = container.querySelector("#wizard-dest-hub");
    if (destHubSelect) destHubSelect.addEventListener("change", (e) => {
      state.output.destinationHubId = e.target.value || null;
      state.output.destinationDatasetId = null;
      paint();
    });

    const destDatasetSelect = container.querySelector("#wizard-dest-dataset");
    if (destDatasetSelect) destDatasetSelect.addEventListener("change", (e) => {
      state.output.destinationDatasetId = e.target.value || null;
      paint();
    });

    // Every step is freely navigable — Next/Previous/the stepper's own step
    // dots/Finish all just move, whether or not the step you're leaving is
    // actually done. Nothing here is a gate: the Status tab already tracks
    // everything still outstanding, and that's also where Deploy itself stays
    // disabled until it's all resolved. Leaving a step still marks it as
    // "attempted" so its own red warnings (see stepNavHtml) show if you come
    // back to it.
    const finishBtn = container.querySelector("#wizard-finish-btn");
    if (finishBtn) finishBtn.addEventListener("click", () => {
      state.validationAttempted.add(state.step);
      showToast("Continue on the Status tab — deploy once everything required is resolved.");
      location.hash = `#/recipes/${recipe.recipe_id}/status`;
    });

    container.querySelectorAll("[data-goto-step]").forEach((el) => {
      const v = el.getAttribute("data-goto-step");
      if (!v) return;
      el.addEventListener("click", () => {
        state.validationAttempted.add(state.step);
        state.step = +v;
        paint();
      });
    });

    const prevBtn = container.querySelector("#wizard-prev");
    if (prevBtn) prevBtn.addEventListener("click", () => {
      state.validationAttempted.add(state.step);
      state.step = adjacentStep(state.step, -1);
      paint();
    });

    const nextBtn = container.querySelector("#wizard-next");
    if (nextBtn) nextBtn.addEventListener("click", () => {
      state.validationAttempted.add(state.step);
      state.step = adjacentStep(state.step, 1);
      paint();
    });
  }

  paint();
}
