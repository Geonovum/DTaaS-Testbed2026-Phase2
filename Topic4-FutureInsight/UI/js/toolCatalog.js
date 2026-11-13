import { TOOL_SERVICES } from "./sandboxApi.js";

// Static catalog of the real OGC API Processes tool-services (see
// ../../services/tool-service and docker-compose.yml's tool-add/tool-multiply/
// tool-multiply3 blocks) — mirrors sandboxApi.TOOL_SERVICES and the Cook
// Orchestrator's own TOOL_REGISTRY_JSON (DECISIONS.md, D10), extended with each
// tool's actual input/output names so a recipe author can see — and pick —
// what a step's tool needs without reading its CWL `run:` block by hand.
export const TOOL_CATALOG = [
  {
    id: "add-two-numbers",
    label: "Add two numbers",
    inputs: [
      { name: "a", type: "float" },
      { name: "b", type: "float" },
    ],
    outputs: [{ name: "sum", type: "float" }],
    // Fake execution fees, same style/units as apps.json's wizard_execution_fee
    // — these tool services aren't real commercial apps, but the wizard's
    // Setup Summary cart (see recipeWizard.js's computeCartLines) expects every
    // bound tool to price like one.
    wizard_execution_fee: 15,
  },
  {
    id: "multiply-two-numbers",
    label: "Multiply two numbers",
    inputs: [
      { name: "x", type: "float" },
      { name: "y", type: "float" },
    ],
    outputs: [{ name: "product", type: "float" }],
    wizard_execution_fee: 20,
  },
  // Deliberately a different arity (three inputs, not two) — picking this for
  // a step is the clearest proof the swap is genuine: the step's inputs/in:
  // block actually changes shape, not just its id. "x" is typically wired to
  // a previous step's output (or a workflow input) the same way the default
  // recipe's multiply step wires its own "x" to the add step's "sum".
  {
    id: "multiply-three-numbers",
    label: "Multiply three numbers",
    inputs: [
      { name: "x", type: "float" },
      { name: "y", type: "float" },
      { name: "z", type: "float" },
    ],
    outputs: [{ name: "product", type: "float" }],
    wizard_execution_fee: 35,
  },
  {
    id: "buffer-geometry",
    label: "Buffer a geometry",
    inputs: [
      { name: "geometry", type: "object" },
      { name: "distance", type: "float" },
    ],
    outputs: [{ name: "bufferedGeometry", type: "object" }],
    wizard_execution_fee: 25,
  },
];

/** Looks up a tool by its CWL `run.id`. Returns null for a step referencing a
 * tool id not in the catalog — e.g. a placeholder/future tool a user typed by
 * hand — which callers should treat as "no known schema", not an error. */
export function findTool(toolId) {
  return TOOL_CATALOG.find((t) => t.id === toolId) || null;
}

/** The real, live OGC API Processes URL for a cataloged tool — derived from
 * sandboxApi.TOOL_SERVICES (the same registry the app already uses to call
 * it), not a second copy of the same mapping. Used to show "View live
 * process" wherever a tool is picked. Null for a tool id with no registered
 * service (e.g. a freeform custom id). */
export function toolProcessUrl(toolId) {
  const service = TOOL_SERVICES.find((s) => s.processId === toolId);
  return service ? `${service.baseUrl}/processes/${toolId}` : null;
}

// The docker-network address each tool is actually reachable at from
// *inside* the Cook Orchestrator's own container — never reachable from a
// browser, so it can't be derived from TOOL_SERVICES (which only ever needs
// the public one). Mirrors docker-compose.yml's service names and MUST stay
// in lockstep with cook-orchestrator/app/engine.py's _DEFAULT_TOOL_REGISTRY
// and cookbook-registry/app/cwl_parser.py's TOOL_CATALOG "internal_url" —
// three copies of the same mapping, the same accepted duplication tradeoff
// already documented for TOOL_REGISTRY/TOOL_SERVICES generally.
const TOOL_INTERNAL_BASE = {
  "add-two-numbers": "http://tool-add:8000",
  "multiply-two-numbers": "http://tool-multiply:8000",
  "multiply-three-numbers": "http://tool-multiply3:8000",
  "buffer-geometry": "http://tool-geo-buffer:8000",
};

/** Builds the same structured `{rel, type, href, internalHref}` object the
 * Python side's `_process_link` generates (cookbook-registry/app/
 * cwl_parser.py) — used by applyToolToStep (../liveRecipe.js) to write a
 * step's `run.nldt:processLink` so a recipe the owner edits and saves from the
 * Orchestrator tab is immediately, fully correct — not missing a field until
 * some later server round-trip patches it in. Null for an uncataloged tool
 * id (same tolerance as findTool/toolProcessUrl). */
export function toolProcessLink(toolId) {
  const href = toolProcessUrl(toolId);
  const internalBase = TOOL_INTERNAL_BASE[toolId];
  if (!href || !internalBase) return null;
  return {
    rel: "process",
    type: "application/json",
    href,
    internalHref: `${internalBase}/processes/${toolId}`,
  };
}

/** Same shape as toolProcessLink(), for a process the recipe author pasted
 * in directly rather than picked from the catalog (see
 * processDescriptionToTool below). An external process has no separate
 * docker-internal address the way this stack's own tool services do — the
 * Cook Orchestrator just calls the same public URL — so `href` and
 * `internalHref` are simply the same pasted address. */
export function externalProcessLink(url) {
  return { rel: "process", type: "application/json", href: url, internalHref: url };
}

/** Best-effort JSON Schema type -> CWL type, for turning a fetched OGC API
 * Process description's `schema` into the type string applyToolToStep/
 * insertNewStep (../liveRecipe.js) write into a step's `inputs:`/`outputs:`.
 * Deliberately not a full JSON Schema type system — mirrors the scope of
 * cwl_parser.py's own _CWL_TO_JSON_TYPE, which only goes the other
 * direction. Anything this doesn't recognize (object, oneOf/anyOf, missing
 * schema, …) becomes CWL's own escape-hatch "Any" type rather than guessing
 * wrong or throwing — the author can still tighten it by hand afterwards. */
function jsonSchemaToCwlType(schema) {
  if (!schema) return "Any";
  // An input that takes data rather than a value (see dataInputOf) is a CWL
  // File — a reference the process fetches itself.
  if (schema.type !== "array" && dataInputOf(schema)) return "File";
  // Nullable (`anyOf: [X, {type: "null"}]`, pydantic's Optional[X]) -> "X?".
  const variants = schema.anyOf || schema.oneOf;
  if (variants) {
    const nonNull = variants.filter((v) => v && v.type !== "null");
    if (nonNull.length === 1 && nonNull.length < variants.length) {
      const inner = jsonSchemaToCwlType(nonNull[0]);
      return inner === "Any" || inner.endsWith("[]") ? inner : `${inner}?`;
    }
    return "Any";
  }
  if (schema.type === "array") {
    const itemType = jsonSchemaToCwlType(schema.items);
    return `${itemType}[]`;
  }
  switch (schema.type) {
    case "string":
      return "string";
    case "integer":
      return "int";
    case "number":
      return "float";
    case "boolean":
      return "boolean";
    default:
      return "Any";
  }
}

/** Whether a process input's JSON Schema says it takes DATA (a file or a
 * reference to one) rather than a plain value — and in which media type, if
 * it says. Only what the schema states machine-readably counts:
 * `contentMediaType`; `format: uri | uri-reference | binary | byte`; an OGC
 * `format: {mediaType}`; or a `oneOf`/`anyOf` variant that is an `{href}`
 * link (OGC API Processes' by-reference input). A description that only says
 * "a URL to a LAZ file" in prose (roofer's) can't be recognised — the author
 * marks such an input as data by hand in the Orchestrator editor.
 * Returns `{mediaType}` (mediaType may be null) or null for a parameter. */
export function dataInputOf(schema) {
  if (!schema || typeof schema !== "object") return null;
  if (schema.type === "array" && schema.items) return dataInputOf(schema.items);
  if (typeof schema.contentMediaType === "string") return { mediaType: schema.contentMediaType };
  if (schema.format && typeof schema.format === "object" && typeof schema.format.mediaType === "string") {
    return { mediaType: schema.format.mediaType };
  }
  if (["uri", "uri-reference", "binary", "byte"].includes(schema.format)) return { mediaType: null };
  const variants = schema.oneOf || schema.anyOf;
  if (Array.isArray(variants)) {
    const isLink = (v) => v && v.type === "object" && v.properties && v.properties.href;
    if (variants.some(isLink)) {
      const typed = variants.map((v) => (isLink(v) ? null : dataInputOf(v))).find((d) => d && d.mediaType);
      return { mediaType: typed ? typed.mediaType : null };
    }
    const nonNull = variants.filter((v) => v && v.type !== "null");
    if (nonNull.length === 1) return dataInputOf(nonNull[0]);
  }
  return null;
}

/** Converts a real OGC API Processes process description (the JSON `GET
 * /processes/{id}` returns per Part 1 of the spec — `inputs`/`outputs`
 * objects keyed by name, each `{schema, minOccurs, maxOccurs, ...}`) into
 * the same `{id, label, inputs: [{name,type}], outputs: [{name,type}]}`
 * shape a TOOL_CATALOG entry has — so applyToolToStep/insertNewStep
 * (../liveRecipe.js) can render it as a CWL step exactly the same way,
 * whether the tool came from the static catalog or was fetched live from an
 * arbitrary external server. `url` is the process's own address, used to
 * build its `nldt:processLink` (see externalProcessLink above). */
export function processDescriptionToTool(url, description) {
  const toIo = (entries) =>
    Object.entries(entries || {}).map(([name, def]) => {
      const schema = unwrapNamedSchema(name, def && def.schema);
      let type = jsonSchemaToCwlType(schema);
      const optional = def && def.minOccurs === 0;
      // A data input that may be given more than once (maxOccurs > 1 or
      // "unbounded") takes a list of Files.
      const data = dataInputOf(schema);
      const many = def && (def.maxOccurs === "unbounded" || def.maxOccurs > 1);
      if (data && many && !type.endsWith("[]")) type = `${type}[]`;
      if (optional && !type.endsWith("?")) type = `${type}?`;
      return { name, type, schema, ...(data && data.mediaType ? { format: `iana:${data.mediaType}` } : {}) };
    });
  return {
    id: description.id,
    label: description.title || description.id,
    inputs: toIo(description.inputs),
    outputs: toIo(description.outputs),
    // The process description's own address, never its execute endpoint —
    // the Cook Orchestrator appends "/execution" itself (see engine.py's
    // _execution_url), and a pasted ".../execution" URL is accepted by the
    // fetch-description proxy too, so normalize it here.
    processUrl: url.replace(/\/+$/, "").replace(/\/execution$/, ""),
  };
}

/** Some OGC API Processes servers (e.g. roofer's, generated from pydantic
 * models) wrap every input's schema in a one-property object named after the
 * input itself — `point_cloud_ids: {schema: {type: object, properties:
 * {point_cloud_ids: <the real schema>}}}` — while the value the execute
 * request actually expects is the inner one (compare the same server's
 * flat top-level `inputsSchema`). Unwraps exactly that shape and nothing
 * else, so a genuine object-valued input with one same-named field — rare,
 * but possible — is the only thing this could get wrong. */
function unwrapNamedSchema(name, schema) {
  const props = schema && schema.type === "object" && schema.properties;
  const keys = props ? Object.keys(props) : [];
  return keys.length === 1 && keys[0] === name ? props[name] : schema;
}
