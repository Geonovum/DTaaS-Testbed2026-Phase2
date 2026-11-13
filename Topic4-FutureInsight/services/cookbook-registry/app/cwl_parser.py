"""A lightweight, purpose-built CWL reader for the nLDT Sandbox Stack.

This is NOT a general CWL processor — no schema-salad, no $import/$include
resolution, no full type system. It understands exactly the subset of CWL 1.2
our recipes are authored in: a single-document Workflow whose steps each `run`
an inline `Operation` — CWL's own class for an abstract, non-executable step
(https://www.commonwl.org/v1.2/Workflow.html#Operation). An Operation's own
`id` is used directly as the OGC API Processes process identifier the Cook
Orchestrator dispatches to; no custom extension field is needed for that.

Recipe authoring is deliberately constrained to this subset for now (mapping-
form `in:`/`steps:`, inline `run:` — no separate files, no scatter/when, no
CommandLineTool). If we outgrow it, this module is the one file that needs to
get smarter — every other service only ever calls these three functions.

Data inputs vs parameters: a workflow input of CWL type `File` (or `File?`,
`File[]`, `{type: array, items: File}`) with a `format` (a media-type IRI,
e.g. `iana:application/geo+json` with `$namespaces: {iana:
https://www.iana.org/assignments/media-types/}`) is a DATA input — a dataset
ingredient, handed to a process by reference. Every other input is a
PARAMETER. This is standard CWL, not an extension: see extract_dag's
`data_inputs` and _file_schema.

Extension fields: the three things a recipe needs that CWL has no field for
are declared in our own namespace, as CWL requires for extensions ("such
extension fields must use a namespace prefix listed in the $namespaces
section of the document"):

    $namespaces:
      nldt: https://fi-group.github.io/nldt-tb2/ns#

    nldt:compatibleTools  (top level)       which alternative tools a hub may swap in per step
    nldt:jsonSchema       (on a workflow input)  the exact JSON Schema of a parameter
    nldt:processLink      (on a step's run)  which concrete OGC API Process runs the step

parse_cwl normalises every spelling of them to the canonical `nldt:` keys
before anything else reads the document: any prefix the document maps to the
nLDT namespace, or the full IRI. The earlier un-namespaced names
(`x-process-link`, `x-compatible-tools`, `x-json-schema`) are rejected with an
error naming the field to use instead — ignoring them silently would drop a
step's process link and break the recipe only at run time.
"""

from __future__ import annotations

import copy
import os
import re

import yaml

# Browser-facing base address of the tool services. It ends up in the `href`
# of each step's nldt:processLink — an address a *person* reading the recipe can
# click — so it has to resolve from wherever the UI is being viewed, not from
# inside the docker network.
#
# This mirrors the two deployment shapes UI/js/sandboxApi.js resolves between
# (see its header for why TLS forces the distinction):
#
#   PUBLIC_TOOL_BASE set — path mode. One origin, each tool behind a path
#     prefix on the reverse proxy that terminates TLS, e.g.
#     PUBLIC_TOOL_BASE=https://nldt-demo.example/api/tools yields
#     https://nldt-demo.example/api/tools/add. Required for HTTPS.
#
#   PUBLIC_TOOL_BASE unset — port mode. http://<PUBLIC_TOOL_HOST>:<port>,
#     matching docker-compose.yml's published ports. Defaults to localhost,
#     which is right for a local `docker compose up`.
#
# The path segments below must agree with sandboxApi.js's TOOL_SERVICES and
# with the proxy config — see deploy/.
_PUBLIC_TOOL_BASE = os.getenv("PUBLIC_TOOL_BASE", "").rstrip("/")
_PUBLIC_TOOL_HOST = os.getenv("PUBLIC_TOOL_HOST", "localhost")
_PUBLIC_TOOL_SCHEME = os.getenv("PUBLIC_TOOL_SCHEME", "http")


def _public_url(port: int, segment: str) -> str:
    if _PUBLIC_TOOL_BASE:
        return f"{_PUBLIC_TOOL_BASE}/{segment}"
    return f"{_PUBLIC_TOOL_SCHEME}://{_PUBLIC_TOOL_HOST}:{port}"


class CWLParseError(ValueError):
    """Raised when a document isn't in the CWL subset this module understands."""


class ToolOverrideError(ValueError):
    """Raised when a tool override names an unknown step or tool id."""


# Mirrors UI/js/toolCatalog.js and the real tool-service instances (see
# ../../tool-service/app/main.py's OPERATIONS and docker-compose.yml's
# tool-add/tool-multiply/tool-multiply3 blocks) — the same static-registry
# pattern already used for TOOL_REGISTRY in cook-orchestrator/app/engine.py,
# extended with each tool's actual input/output shape so a per-run override
# (see apply_tool_overrides) can rewrite a step's wiring for it automatically.
#
# "public_url" is the browser-facing OGC API Processes base address (matches
# docker-compose.yml's published ports and UI/js/sandboxApi.js's
# TOOL_SERVICES) — what a person looking at the recipe can actually click.
# Its host comes from PUBLIC_TOOL_HOST (see _public_url above), the same way
# sandboxApi.js derives its host from the page origin: both must point at
# the machine the stack is published on, which is only 'localhost' when you
# happen to be running it locally.
# "internal_url" is the docker-network address cook-orchestrator itself
# calls (see engine.py's _DEFAULT_TOOL_REGISTRY, which this MUST stay in
# lockstep with — two copies of the same mapping, the same accepted
# duplication tradeoff already documented for TOOL_REGISTRY/TOOL_SERVICES).
# Both feed into a step's `run.nldt:processLink` (see _process_link) so the
# recipe itself carries a real, structured pointer to its tool — not just an
# abstract id a separate registry has to resolve.
TOOL_CATALOG = {
    "add-two-numbers": {
        "label": "Add two numbers",
        "inputs": [("a", "float"), ("b", "float")],
        "output": ("sum", "float"),
        "public_url": _public_url(8010, "add"),
        "internal_url": "http://tool-add:8000",
    },
    "multiply-two-numbers": {
        "label": "Multiply two numbers",
        "inputs": [("x", "float"), ("y", "float")],
        "output": ("product", "float"),
        "public_url": _public_url(8011, "multiply"),
        "internal_url": "http://tool-multiply:8000",
    },
    "multiply-three-numbers": {
        "label": "Multiply three numbers",
        "inputs": [("x", "float"), ("y", "float"), ("z", "float")],
        "output": ("product", "float"),
        "public_url": _public_url(8012, "multiply3"),
        "internal_url": "http://tool-multiply3:8000",
    },
    "buffer-geometry": {
        "label": "Buffer a geometry",
        # (name, CWL type[, CWL format]) — `geometry` is a data input, given
        # by reference (see _file_schema).
        "inputs": [("geometry", "File", "iana:application/geo+json"), ("distance", "float")],
        "output": ("bufferedGeometry", "object"),
        "public_url": _public_url(8013, "geo-buffer"),
        "internal_url": "http://tool-geo-buffer:8000",
    },
}


def _process_link(tool_id: str) -> dict | None:
    """Builds the structured `nldt:processLink` object for a cataloged tool —
    both the address a person can click (`href`) and the one the Cook
    Orchestrator itself must use (`internalHref`, only reachable from inside
    the docker network). Returns None for an uncataloged/freeform tool id —
    the same "no known schema" tolerance as findTool's JS counterpart."""
    tool = TOOL_CATALOG.get(tool_id)
    if not tool:
        return None
    return {
        "rel": "process",
        "type": "application/json",
        "href": f"{tool['public_url']}/processes/{tool_id}",
        "internalHref": f"{tool['internal_url']}/processes/{tool_id}",
    }


NLDT_NAMESPACE = "https://fi-group.github.io/nldt-tb2/ns#"
PROCESS_LINK = "nldt:processLink"
COMPATIBLE_TOOLS = "nldt:compatibleTools"
JSON_SCHEMA = "nldt:jsonSchema"
_RETIRED_EXTENSION_KEYS = {
    "x-process-link": PROCESS_LINK,
    "x-compatible-tools": COMPATIBLE_TOOLS,
    "x-json-schema": JSON_SCHEMA,
}


def _extension_aliases(doc: dict) -> dict[str, str]:
    """Every key spelling that means one of our three extension fields in
    this document -> its canonical `nldt:` key: `<prefix>:<term>` for any
    prefix the document's `$namespaces` maps to the nLDT namespace (plus
    `nldt:` itself) and the full IRI."""
    prefixes = {"nldt"} | {p for p, iri in _namespaces(doc).items() if iri == NLDT_NAMESPACE}
    aliases = {}
    for canonical in (PROCESS_LINK, COMPATIBLE_TOOLS, JSON_SCHEMA):
        term = canonical.split(":", 1)[1]
        aliases[NLDT_NAMESPACE + term] = canonical
        for prefix in prefixes:
            aliases[f"{prefix}:{term}"] = canonical
    return aliases


def _rename_extension_keys(obj, aliases: dict[str, str], where: str) -> None:
    if not isinstance(obj, dict):
        return
    for key in obj:
        if key in _RETIRED_EXTENSION_KEYS:
            raise CWLParseError(
                f"{where}: '{key}' is no longer supported — use '{_RETIRED_EXTENSION_KEYS[key]}' "
                f"and declare the namespace: $namespaces: {{nldt: {NLDT_NAMESPACE}}}"
            )
    for key in [k for k in obj if k in aliases and aliases[k] != k]:
        canonical = aliases[key]
        value = obj.pop(key)
        obj.setdefault(canonical, value)


def _normalize_extensions(doc: dict) -> None:
    """Renames the extension fields to their canonical `nldt:` keys, in the
    three places they are read: the top level, each workflow input, and each
    step's inline `run`."""
    aliases = _extension_aliases(doc)
    _rename_extension_keys(doc, aliases, "Recipe")
    inputs = doc.get("inputs")
    if isinstance(inputs, dict):
        for name, spec in inputs.items():
            _rename_extension_keys(spec, aliases, f"Input '{name}'")
    steps = doc.get("steps")
    if isinstance(steps, dict):
        for step_id, step in steps.items():
            if isinstance(step, dict):
                _rename_extension_keys(step.get("run"), aliases, f"Step '{step_id}'")


def parse_cwl(text: str) -> dict:
    try:
        doc = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise CWLParseError(f"Not valid YAML: {exc}") from exc
    if not isinstance(doc, dict):
        raise CWLParseError("Top-level CWL document must be a mapping")
    if doc.get("class") != "Workflow":
        raise CWLParseError("Only 'class: Workflow' recipes are supported")
    if not str(doc.get("cwlVersion", "")).startswith("v1."):
        raise CWLParseError(f"Unsupported cwlVersion: {doc.get('cwlVersion')!r}")
    for key in ("inputs", "outputs", "steps"):
        if key not in doc:
            raise CWLParseError(f"Workflow is missing required '{key}' section")
    _normalize_extensions(doc)
    return doc


_CWL_TO_JSON_TYPE = {
    "float": "number",
    "double": "number",
    "int": "integer",
    "long": "integer",
    "string": "string",
    "boolean": "boolean",
}


def _normalize_param(entry) -> dict:
    """CWL allows `name: type` shorthand or a full `{type, label, ...}` mapping."""
    if isinstance(entry, str):
        return {"type": entry}
    if isinstance(entry, dict):
        return entry
    raise CWLParseError(f"Unsupported parameter declaration: {entry!r}")


def _split_optional(cwl_type):
    """Strips CWL's two spellings of "may be null" — the `type?` shorthand and
    an explicit `["null", type]` union — returning (base_type, optional)."""
    if isinstance(cwl_type, str) and cwl_type.endswith("?"):
        return cwl_type[:-1], True
    if isinstance(cwl_type, list):
        non_null = [t for t in cwl_type if t != "null"]
        optional = len(non_null) < len(cwl_type)
        return (non_null[0] if len(non_null) == 1 else non_null), optional
    return cwl_type, False


_FILE_TYPE = "File"


def _is_file_type(cwl_type) -> tuple[bool, bool]:
    """(is a File data input, is an array of them) for an input's CWL type
    — already stripped of its optional marker (see _split_optional)."""
    if cwl_type == _FILE_TYPE:
        return True, False
    if isinstance(cwl_type, str) and cwl_type.endswith("[]"):
        return cwl_type[:-2] == _FILE_TYPE, True
    if isinstance(cwl_type, dict) and cwl_type.get("type") == "array":
        return cwl_type.get("items") == _FILE_TYPE, True
    return False, False


def _file_schema(media_type: str | None) -> dict:
    """JSON Schema of one CWL File value: a reference, never inline content —
    `{"class": "File", "location": "<URL>", "format": "<media-type IRI>"}`.
    `x-cwl-type`/`x-media-type` let a client recognise it as a data input
    without re-reading the CWL."""
    schema = {
        "type": "object",
        "required": ["class", "location"],
        "properties": {
            "class": {"const": "File"},
            "location": {"type": "string", "format": "uri"},
            "format": {"type": "string"},
        },
        "x-cwl-type": "File",
    }
    if media_type:
        schema["x-media-type"] = media_type
    return schema


def _cwl_type_to_json_schema(cwl_type) -> dict:
    """CWL type -> JSON Schema, for the subset of CWL types our recipes use:
    the scalars in _CWL_TO_JSON_TYPE, arrays (`int[]` shorthand or the
    `{type: array, items: ...}` form), enums (`{type: enum, symbols: [...]}`)
    and `Any` (anything — the UI edits it as raw JSON). Anything else falls
    back to "string", same as before arrays were understood at all. Shapes
    CWL itself can't describe (e.g. a discriminated oneOf) go in the input's
    own `nldt:jsonSchema` instead — see extract_input_schema."""
    if isinstance(cwl_type, str):
        if cwl_type.endswith("[]"):
            return {"type": "array", "items": _cwl_type_to_json_schema(cwl_type[:-2])}
        if cwl_type == "Any":
            return {}
        return {"type": _CWL_TO_JSON_TYPE.get(cwl_type, "string")}
    if isinstance(cwl_type, dict):
        if cwl_type.get("type") == "array":
            return {"type": "array", "items": _cwl_type_to_json_schema(cwl_type.get("items", "Any"))}
        if cwl_type.get("type") == "enum":
            # CWL symbols may be written as full IRIs (`#formats/cityjson`);
            # only the last segment is the actual value sent to a process.
            symbols = [str(s).rsplit("/", 1)[-1].lstrip("#") for s in cwl_type.get("symbols") or []]
            return {"type": "string", "enum": symbols}
    if isinstance(cwl_type, list):
        return {"anyOf": [_cwl_type_to_json_schema(t) for t in cwl_type]}
    return {"type": "string"}


def _input_is_optional(spec: dict) -> bool:
    """Whether a workflow input may be left unset: either its type allows
    null, or it declares a `default` (CWL fills that in when omitted)."""
    return _split_optional(spec.get("type", "string"))[1] or "default" in spec


def extract_input_schema(doc: dict) -> dict:
    """Derives a JSON Schema for the workflow's top-level inputs.

    Used by the frontend to generate the parameter form. Always computed fresh
    from the CWL, never cached, so it can never drift from the recipe itself.

    An input may carry an optional `nldt:jsonSchema` extension field — the full
    JSON Schema of the value, typically copied straight from the OGC API
    Process description of the step that consumes it. When present it wins
    over the schema derived from the CWL type, so constraints CWL can't
    express (oneOf variants, minItems, patterns, ...) still reach the form.

    A `File` input (see _file_schema) always gets the File reference schema,
    even with an `nldt:jsonSchema`: its value is a reference to the data, not
    the data itself, so a schema of the data's content doesn't apply to it.
    """
    namespaces = _namespaces(doc)
    properties: dict[str, dict] = {}
    required: list[str] = []
    for name, raw in (doc.get("inputs") or {}).items():
        spec = _normalize_param(raw)
        base_type, _ = _split_optional(spec.get("type", "string"))
        is_file, is_array = _is_file_type(base_type)
        override = spec.get(JSON_SCHEMA)
        if is_file:
            file_schema = _file_schema(_media_type(spec.get("format"), namespaces))
            prop: dict = {"type": "array", "items": file_schema} if is_array else file_schema
        else:
            prop = copy.deepcopy(override) if isinstance(override, dict) else _cwl_type_to_json_schema(base_type)
        if spec.get("label"):
            prop["title"] = spec["label"]
        if spec.get("doc"):
            prop["description"] = spec["doc"]
        if "default" in spec:
            prop["default"] = spec["default"]
        properties[name] = prop
        if not _input_is_optional(spec):
            required.append(name)
    return {"type": "object", "properties": properties, "required": required}


def _step_source_ref(source: str) -> dict:
    """A step's `in:` value is either a top-level workflow input name, or
    `stepId/outputName` referring to another step's output."""
    if "/" in source:
        step_id, output_name = source.split("/", 1)
        return {"source_type": "step_output", "step": step_id, "output": output_name}
    return {"source_type": "workflow_input", "name": source}


# The only CWL expression forms we evaluate — recognized by pattern, never
# run as JavaScript (there is no JS engine here), no inputs.* access:
#   $(self.a.b)                                      pick a (nested) field, e.g. the
#                                                    `model_3d_id` inside a step's
#                                                    structured `building_model` output
#   $(self.a.map(function(x){ return x.b.c; }))      pick a field from every item of a
#                                                    list, e.g. each `point_cloud_id` in a
#                                                    validation report's `point_clouds`
# Both parse to a path like ["a", "b"] or ["a", "*", "b", "c"], where "*"
# means "for each item" (see cook-orchestrator/app/engine.py's _pick_path).
#
# Two object-template forms build a new object per value, for a process that
# wants its data input in its own shape rather than as an OGC reference (e.g.
# roofer's `[{kind: "url", url: ...}]` from a list of CWL Files):
#   $(self.map(function(f){ return {"kind": "url", "url": f.location}; }))
#   $({"kind": "url", "url": self.location})
# `self.<fields>` may precede `.map(...)` to pick a list first. Each value in
# the object is the item/self itself or a field path on it, or a string,
# number, true/false/null literal — nothing else (no nesting, no operators).
# They parse to a "template" ({"map": bool, "fields": {key: {"path": [...]} |
# {"literal": v}}}) next to the optional "path" (see _step_inputs).
_IDENT = r"[A-Za-z_][A-Za-z0-9_]*"
_FIELDS = rf"(?:\.{_IDENT})"
_SELF_PATH_EXPR = re.compile(rf"^\$\(self({_FIELDS}+)\)$")
_SELF_MAP_EXPR = re.compile(
    rf"^\$\(self({_FIELDS}+)\.map\(\s*function\s*\(\s*({_IDENT})\s*\)\s*"
    rf"\{{\s*return\s+({_IDENT})({_FIELDS}+)\s*;?\s*\}}\s*\)\)$"
)
_SELF_MAP_OBJECT_EXPR = re.compile(
    rf"^\$\(self({_FIELDS}*)\.map\(\s*function\s*\(\s*({_IDENT})\s*\)\s*"
    rf"\{{\s*return\s*(\{{.*\}})\s*;?\s*\}}\s*\)\)$",
    re.DOTALL,
)
_SELF_OBJECT_EXPR = re.compile(r"^\$\(\s*(\{.*\})\s*\)$", re.DOTALL)
_OBJECT_KEY = re.compile(rf"^(?:({_IDENT})|\"([^\"]*)\"|'([^']*)')$")
_OBJECT_REF = re.compile(rf"^({_IDENT})({_FIELDS}*)$")
_NUMBER = re.compile(r"^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$")


def _fields(dotted: str) -> list[str]:
    return dotted.lstrip(".").split(".")


def _split_top_level(text: str, sep: str = ",") -> list[str]:
    """Splits on `sep` outside quotes (object literals here have no nesting)."""
    parts, current, quote = [], [], None
    for ch in text:
        if quote:
            current.append(ch)
            if ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
            current.append(ch)
        elif ch == sep:
            parts.append("".join(current))
            current = []
        else:
            current.append(ch)
    parts.append("".join(current))
    return parts


def _object_template(literal: str, var: str, where: str) -> dict:
    """{key: {"path": [...]} | {"literal": v}} for a flat object literal whose
    values reference `var` (the map item, or `self`) or are literals."""
    body = literal.strip()[1:-1].strip()
    fields: dict[str, dict] = {}
    entries = [e for e in _split_top_level(body) if e.strip()] if body else []
    for entry in entries:
        key_text, colon, value_text = entry.partition(":")
        key_match = _OBJECT_KEY.match(key_text.strip())
        if not colon or not key_match:
            raise CWLParseError(f"{where}: can't read object entry {entry.strip()!r}")
        key = next(g for g in key_match.groups() if g is not None)
        value = value_text.strip()
        ref = _OBJECT_REF.match(value)
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            fields[key] = {"literal": value[1:-1]}
        elif _NUMBER.match(value):
            fields[key] = {"literal": float(value) if any(c in value for c in ".eE") else int(value)}
        elif value in ("true", "false", "null"):
            fields[key] = {"literal": {"true": True, "false": False, "null": None}[value]}
        elif ref and ref.group(1) == var:
            fields[key] = {"path": _fields(ref.group(2)) if ref.group(2) else []}
        else:
            raise CWLParseError(
                f"{where}: unsupported value {value!r} for '{key}' (only {var}, {var}.field, "
                "or a string/number/true/false/null literal)"
            )
    return fields


def _value_from(expr, step_id: str, input_name: str) -> tuple[list[str] | None, dict | None]:
    """A step input's `valueFrom`, as (path, template) — see the forms above."""
    text = expr.strip() if isinstance(expr, str) else ""
    where = f"Step '{step_id}': valueFrom for '{input_name}'"
    match = _SELF_PATH_EXPR.match(text)
    if match:
        return _fields(match.group(1)), None
    match = _SELF_MAP_EXPR.match(text)
    if match and match.group(2) == match.group(3):
        return [*_fields(match.group(1)), "*", *_fields(match.group(4))], None
    match = _SELF_MAP_OBJECT_EXPR.match(text)
    if match:
        path = _fields(match.group(1)) if match.group(1) else None
        return path, {"map": True, "fields": _object_template(match.group(3), match.group(2), where)}
    match = _SELF_OBJECT_EXPR.match(text)
    if match:
        return None, {"map": False, "fields": _object_template(match.group(1), "self", where)}
    raise CWLParseError(
        f"{where}: unsupported expression {expr!r} (supported: '$(self.field.subfield)', "
        "'$(self.list.map(function(x){ return x.field; }))', "
        "'$(self.map(function(x){ return {\"key\": x.field, ...}; }))' and '$({\"key\": self.field, ...})')"
    )


def _step_inputs(step: dict, step_id: str) -> dict[str, dict]:
    raw_in = step.get("in") or {}
    if not isinstance(raw_in, dict):
        raise CWLParseError(f"Step '{step_id}': only mapping-form 'in:' is supported")
    resolved = {}
    for input_name, binding in raw_in.items():
        source, path, template = binding, None, None
        if isinstance(binding, dict):
            source = binding.get("source")
            if "valueFrom" in binding:
                path, template = _value_from(binding["valueFrom"], step_id, input_name)
        if not isinstance(source, str):
            raise CWLParseError(f"Step '{step_id}': unsupported 'in' binding for '{input_name}': {binding!r}")
        ref = _step_source_ref(source)
        if path:
            ref["path"] = path
        if template:
            ref["template"] = template
        resolved[input_name] = ref
    return resolved


def extract_compatible_tools(doc: dict) -> dict[str, list[str]]:
    """Reads the recipe owner's own per-step allowlist of which cataloged
    tools a hub is allowed to substitute in for that step (see the
    Orchestrator tab's "Compatible Apps per Step" panel) — an optional,
    hand-authored `nldt:compatibleTools: {stepId: [toolId, ...]}` extension
    field, not part of core CWL. A step with no entry here has no owner-set
    allowlist yet; callers (see apply_tool_overrides) treat that as "only
    this step's own current tool", not "anything goes" — the safe default
    until an owner explicitly opens a step up to alternates. Unknown tool
    ids are dropped rather than raising, since this is optional metadata a
    hand-edit could easily get slightly wrong without invalidating the
    whole recipe.
    """
    raw = doc.get(COMPATIBLE_TOOLS)
    if not isinstance(raw, dict):
        return {}
    result: dict[str, list[str]] = {}
    for step_id, tool_ids in raw.items():
        if not isinstance(tool_ids, list):
            continue
        result[step_id] = [t for t in tool_ids if isinstance(t, str) and t in TOOL_CATALOG]
    return result


_IANA_PREFIXES = ("iana:", "https://www.iana.org/assignments/media-types/", "http://www.iana.org/assignments/media-types/")


def _namespaces(doc: dict) -> dict[str, str]:
    """The document's own `$namespaces` (prefix -> IRI), which CWL uses to
    expand `prefix:name` identifiers such as formats."""
    raw = doc.get("$namespaces")
    if not isinstance(raw, dict):
        return {}
    return {k: v for k, v in raw.items() if isinstance(k, str) and isinstance(v, str)}


def _media_type(fmt, namespaces: dict[str, str] | None = None) -> str | None:
    """A CWL `format` as a plain media type. CWL spells formats as IRIs,
    for media types conventionally `iana:text/xml` with `$namespaces:
    {iana: https://www.iana.org/assignments/media-types/}`. The prefix is
    expanded through the document's own `$namespaces`; an IRI under the IANA
    media-types registry then becomes the bare media type. `iana:` is also
    understood without a `$namespaces` entry, and a bare `text/xml` is
    accepted too, since that's what people will write. Anything else (e.g.
    an EDAM format IRI) isn't a media type: None."""
    if not isinstance(fmt, str) or not fmt.strip():
        return None
    fmt = fmt.strip()
    prefix, sep, rest = fmt.partition(":")
    if sep and namespaces and prefix in namespaces and not rest.startswith("//"):
        fmt = namespaces[prefix] + rest
    for base in _IANA_PREFIXES:
        if fmt.startswith(base):
            return fmt[len(base):] or None
    return fmt if "/" in fmt and ":" not in fmt else None


def _step_formats(run: dict, key: str, namespaces: dict[str, str] | None = None) -> dict[str, str]:
    """{name: media type} for every input or output (`key`) of a step's
    Operation that declares a CWL `format` — see extract_dag."""
    formats = {}
    for name, spec in (run.get(key) or {}).items():
        media_type = _media_type(spec.get("format"), namespaces) if isinstance(spec, dict) else None
        if media_type:
            formats[name] = media_type
    return formats


def _step_process_link(run: dict) -> dict | None:
    """Reads a step's own `run.nldt:processLink` — the structured, resolvable
    pointer to its real OGC API Process (see _process_link) — tolerantly:
    anything malformed (not a mapping, missing an href) is treated as absent
    rather than raising, since this is optional per-step metadata a hand-edit
    could easily get wrong without invalidating the whole recipe. Absent
    entirely for an older-shaped recipe authored before this field existed —
    callers (the Cook Orchestrator) fall back to their own tool registry."""
    link = run.get(PROCESS_LINK)
    if not isinstance(link, dict) or not isinstance(link.get("href"), str):
        return None
    return link


def extract_dag(doc: dict) -> dict:
    """Derives the execution graph the Cook Orchestrator actually walks: one
    entry per step, in topological (dependency) order, each carrying the OGC
    API Processes process id to call and where each of its inputs comes from.
    """
    steps_raw = doc.get("steps") or {}
    if not isinstance(steps_raw, dict):
        raise CWLParseError("Only mapping-form 'steps:' is supported")
    namespaces = _namespaces(doc)

    steps: dict[str, dict] = {}
    for step_id, step in steps_raw.items():
        run = step.get("run")
        if not isinstance(run, dict) or run.get("class") != "Operation":
            raise CWLParseError(
                f"Step '{step_id}': only inline 'run: {{class: Operation}}' steps are supported"
            )
        process_id = run.get("id")
        if not process_id:
            raise CWLParseError(f"Step '{step_id}': its Operation must declare an 'id'")
        steps[step_id] = {
            "id": step_id,
            # What the step does in this recipe (the step's own `label`) —
            # stays the same when a hub swaps the app that runs it.
            "label": step.get("label", step_id),
            "process_id": process_id,
            # The app that runs it: its Operation's own `label`, as the recipe
            # names it (None if it has none). A tool swap rewrites the
            # Operation, and with it this name (see apply_tool_overrides).
            "process_label": run.get("label"),
            "process_link": _step_process_link(run),
            "inputs": _step_inputs(step, step_id),
            "outputs": list(step.get("out") or []),
            # CWL `format`s on the Operation's own inputs/outputs, as media
            # types. The Cook Orchestrator sends an input with a format as an
            # OGC qualified value ({"value": ..., "mediaType": ...}), and asks
            # the process for each output with a format in that format. A
            # File value (a data input, see data_inputs below) is sent by
            # reference instead: {"href": ..., "type": <this media type>}.
            "input_formats": _step_formats(run, "inputs", namespaces),
            "output_formats": _step_formats(run, "outputs", namespaces),
        }

    order = _topological_order(steps)

    outputs = []
    for out_id, out_spec in (doc.get("outputs") or {}).items():
        spec = _normalize_param(out_spec)
        source = spec.get("outputSource")
        if not source:
            raise CWLParseError(f"Workflow output '{out_id}' has no outputSource")
        outputs.append({"id": out_id, **_step_source_ref(source)})

    # What the Cook Orchestrator needs to know about a parameter the caller
    # didn't send: fill in its CWL `default`, or — if it's optional with no
    # default — leave it out of the step's execute request entirely.
    input_specs = {name: _normalize_param(raw) for name, raw in (doc.get("inputs") or {}).items()}

    return {
        "workflow_inputs": list(input_specs.keys()),
        "input_defaults": {name: spec["default"] for name, spec in input_specs.items() if "default" in spec},
        "optional_inputs": [name for name, spec in input_specs.items() if _input_is_optional(spec)],
        "workflow_outputs": outputs,
        "steps": [steps[step_id] for step_id in order],
        "compatible_tools": extract_compatible_tools(doc),
        "data_inputs": _data_inputs(input_specs, namespaces),
    }


def _data_inputs(input_specs: dict[str, dict], namespaces: dict[str, str]) -> dict[str, dict]:
    """The workflow inputs that are DATA (CWL `File`/`File[]`, see
    _is_file_type) rather than parameters — what a client offers as dataset
    ingredients picked from a catalogue, instead of a form field. Always a
    mapping; empty for a recipe with only parameters."""
    result = {}
    for name, spec in input_specs.items():
        base_type, optional = _split_optional(spec.get("type", "string"))
        is_file, is_array = _is_file_type(base_type)
        if not is_file:
            continue
        fmt = spec.get("format") if isinstance(spec.get("format"), str) else None
        result[name] = {
            "media_type": _media_type(fmt, namespaces),
            "format": fmt,
            "array": is_array,
            "optional": optional or "default" in spec,
            "label": spec.get("label"),
            "doc": spec.get("doc"),
        }
    return result


def _topological_order(steps: dict[str, dict]) -> list[str]:
    dependencies = {
        step_id: {ref["step"] for ref in step["inputs"].values() if ref["source_type"] == "step_output"}
        for step_id, step in steps.items()
    }
    ordered: list[str] = []
    visiting: set[str] = set()

    def visit(step_id: str, path: tuple[str, ...]) -> None:
        if step_id in ordered:
            return
        if step_id in visiting:
            raise CWLParseError(f"Cycle detected in steps: {' -> '.join(path + (step_id,))}")
        if step_id not in steps:
            raise CWLParseError(f"Step references unknown step '{step_id}'")
        visiting.add(step_id)
        for dep in dependencies[step_id]:
            visit(dep, path + (step_id,))
        visiting.discard(step_id)
        ordered.append(step_id)

    for step_id in steps:
        visit(step_id, ())
    return ordered


def apply_tool_overrides(doc: dict, overrides: dict[str, str]) -> dict:
    """Returns a NEW doc (the original is never mutated) with the given
    steps' tools swapped for a different cataloged one — for a hub running
    this recipe with a custom configuration, never for the recipe's own
    stored default (that's the Orchestrator tab's Save Recipe, a completely
    separate path). Nothing here is persisted; this is purely an in-memory,
    per-request reshaping, called fresh for every /recipes/{id}/effective
    request and every execution that carries overrides.

    For each overridden step: rewrites its `run:` block for the new tool,
    remaps its `in:` wiring to the new tool's input names by position
    (reusing existing wiring where a slot already existed — same value, same
    meaning), and for any input the new tool needs beyond what the old one
    had, adds a brand-new top-level workflow input of that name/type and
    wires the step directly to it. If the new tool's output name differs
    from the old one, every other step's `in:` and the workflow's own
    `outputs:` that referenced `stepId/oldOutputName` are rewritten to
    `stepId/newOutputName` — so swapping a step whose output feeds a later
    step never silently breaks that wiring.
    """
    if not overrides:
        return doc

    compatible_tools = extract_compatible_tools(doc)
    doc = copy.deepcopy(doc)
    steps = doc.get("steps") or {}
    workflow_inputs = doc.setdefault("inputs", {})

    for step_id, new_tool_id in overrides.items():
        if step_id not in steps:
            raise ToolOverrideError(f"Unknown step '{step_id}'")
        tool = TOOL_CATALOG.get(new_tool_id)
        if not tool:
            raise ToolOverrideError(f"Unknown tool '{new_tool_id}'")

        step = steps[step_id]
        old_run = step.get("run") or {}
        old_output_names = list((old_run.get("outputs") or {}).keys())
        old_in = step.get("in") or {}
        old_input_names = list(old_in.keys())

        # The recipe owner's own allowlist for this step (see
        # extract_compatible_tools) — no entry means only the step's own
        # current tool is allowed, i.e. this override is necessarily
        # rejected (an override is by definition a *different* tool).
        old_process_id = old_run.get("id")
        allowed = compatible_tools.get(step_id) or ([old_process_id] if old_process_id else [])
        if new_tool_id not in allowed:
            raise ToolOverrideError(
                f"'{new_tool_id}' is not an approved app for step '{step_id}' — "
                f"the recipe owner has only allowed: {', '.join(allowed) or '(none)'}"
            )

        tool_inputs = [(entry[0], entry[1], entry[2] if len(entry) > 2 else None) for entry in tool["inputs"]]
        new_input_names = [name for name, _, _ in tool_inputs]
        new_output_name, new_output_type = tool["output"]

        step["run"] = {
            "class": "Operation",
            "id": new_tool_id,
            "label": tool["label"],
            "doc": f"Calls the '{new_tool_id}' OGC API Process.",
            "inputs": {name: ({"type": t, "format": fmt} if fmt else {"type": t}) for name, t, fmt in tool_inputs},
            "outputs": {new_output_name: {"type": new_output_type}},
        }
        link = _process_link(new_tool_id)
        if link:
            step["run"][PROCESS_LINK] = link

        new_in = {}
        for i, (name, input_type, input_format) in enumerate(tool_inputs):
            if i < len(old_input_names):
                new_in[name] = old_in[old_input_names[i]]
            else:
                new_in[name] = name
                if name not in workflow_inputs:
                    workflow_inputs[name] = {"type": input_type, "label": name.capitalize()}
                    if input_format:
                        workflow_inputs[name]["format"] = input_format
        step["in"] = new_in
        step["out"] = [new_output_name]

        if old_output_names and old_output_names[0] != new_output_name:
            old_ref = f"{step_id}/{old_output_names[0]}"
            new_ref = f"{step_id}/{new_output_name}"
            for other_id, other_step in steps.items():
                if other_id == step_id:
                    continue
                for in_name, source in (other_step.get("in") or {}).items():
                    if source == old_ref:
                        other_step["in"][in_name] = new_ref
                    elif isinstance(source, dict) and source.get("source") == old_ref:
                        source["source"] = new_ref
            for out_spec in (doc.get("outputs") or {}).values():
                if isinstance(out_spec, dict) and out_spec.get("outputSource") == old_ref:
                    out_spec["outputSource"] = new_ref

    return doc
