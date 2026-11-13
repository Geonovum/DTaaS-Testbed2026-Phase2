cwlVersion: v1.2
class: Workflow
id: playground-1
label: "Playground Recipe 1"
doc: >
  A shared slot for trying out your own recipe. Anyone can edit and save it,
  so it holds whatever was saved last — the starter roofer pipeline (validate,
  reconstruct and convert buildings), or someone else's work in progress. To
  start fresh, open Edit Recipe → Orchestrator and click Reset: that loads the
  starter version, whose comments explain where to begin. Then Validate and
  Save.

# ============================================================================
#  WHAT THIS FILE IS
# ============================================================================
# A CWL (Common Workflow Language) v1.2 Workflow — the exact document the Cook
# Orchestrator executes, step by step, over plain HTTP calls to OGC API
# Processes. This starter calls three EXTERNAL processes on roofer's staging
# server (3D building reconstruction from point clouds):
#   1. validate_point_cloud  — registers the point clouds, hands out ids
#   2. reconstruct_buildings — builds a 3D model from those ids + a BAG selection
#   3. convert_format        — exports that model as CityJSON and/or GeoPackage
#
# Inputs come in two kinds:
#   - DATA inputs: `type: File` (or `File[]`) with a `format`. A dataset the
#     recipe needs — picked from the hub's data catalogue in the Recipe
#     Wizard's Data Ingredients step, never typed in. Its run-time value is a
#     reference, {"class": "File", "location": "<url>"}; the process fetches
#     the data itself. Here: `point_clouds`, LAZ files.
#   - PARAMETERS: every other type. Typed in on the Wizard's Parameters step.
#     Here: `bag`, `name`, `config`, `formats`.
#
# Edit this document from the Orchestrator tab: change something, click
# Validate, and only once it comes back valid does Save become clickable.

# Notes on the roofer staging testbed (it's fake, but it does validate):
# - validate_point_cloud accepts any LAS/LAZ URL and hands out a fresh
#   point_cloud_id for it — it does not download the file; reconstruct_buildings
#   only accepts ids it has handed out — which is exactly why this recipe
#   validates first.
# - The BAG selection is checked too: by building ids works with its
#   16-digit ids ("0000000000000001", ...), by asset needs an existing
#   asset/bag id (e.g. 10007), and by area accepts any polygon in
#   EPSG:28992.

requirements:
  # Needed by CWL for the `valueFrom`s below. The Cook Orchestrator doesn't
  # run JavaScript: it understands only a few fixed expression shapes
  # (picking fields, and mapping a list to objects built from fields or
  # literals) — see cwl_parser.py.
  StepInputExpressionRequirement: {}
  InlineJavascriptRequirement: {}

$namespaces:
  iana: https://www.iana.org/assignments/media-types/
  nldt: https://fi-group.github.io/nldt-tb2/ns#

inputs:
  point_clouds:
    # A data input: one or more LAZ point cloud files. LAZ has no
    # IANA-registered media type; application/vnd.laszip is the one in
    # common use.
    type: File[]
    format: iana:application/vnd.laszip
    label: "Point clouds"
    doc: "The LAZ point cloud files to validate and reconstruct buildings from."
  bag:
    type: Any
    label: "BAG selection"
    doc: >
      Which BAG buildings to reconstruct: a whole BAG asset, a list of
      building ids, or every building within an area (WKT in EPSG:28992).
    default:
      kind: buildings
      building_ids: ["0000000000000001", "0000000000000002"]
    # CWL has no discriminated-union type, so the exact shape comes from
    # roofer's own process description (inputsSchema.properties.bag, with its
    # $refs inlined). The parameter form uses it to offer one JSON template
    # per variant.
    nldt:jsonSchema:
      oneOf:
        - title: "By BAG asset"
          type: object
          additionalProperties: false
          required: [kind, asset_id]
          properties:
            kind: { const: asset, type: string }
            asset_id: { type: integer, exclusiveMinimum: 0 }
        - title: "By building ids"
          type: object
          additionalProperties: false
          required: [kind, building_ids]
          properties:
            kind: { const: buildings, type: string }
            building_ids:
              type: array
              minItems: 1
              uniqueItems: true
              items: { type: string, pattern: "\\S" }
        - title: "By area"
          type: object
          additionalProperties: false
          required: [kind, wkt, crs]
          properties:
            kind: { const: area, type: string }
            wkt: { type: string, pattern: "\\S" }
            crs: { const: "EPSG:28992", type: string }
  name:
    type: string?
    label: "Model name"
    doc: "Optional name for the reconstructed model."
  config:
    type: Any?
    label: "Reconstruction config"
    doc: "Optional roofer configuration overrides, as a JSON object."
    nldt:jsonSchema:
      type: object
      additionalProperties: true
  formats:
    type:
      type: array
      items:
        type: enum
        symbols: [gpkg, cityjson]
    label: "Output formats"
    doc: "Which file formats to convert the model into."
    default: [cityjson]

outputs:
  validation_report:
    type: Any
    outputSource: validate/validation_report
  building_model:
    type: Any
    outputSource: reconstruct/building_model
  converted_model:
    type: Any
    outputSource: convert/converted_model

steps:
  validate:
    label: "Validate point clouds"
    run:
      class: Operation
      id: roofer:validate_point_cloud:v1
      label: "Validate Point Cloud"
      doc: "Calls the 'roofer:validate_point_cloud:v1' OGC API Process."
      nldt:processLink:
        rel: process
        type: application/json
        href: "https://processes.staging.roofer-online.nl/ogcapi/processes/roofer:validate_point_cloud:v1"
        internalHref: "https://processes.staging.roofer-online.nl/ogcapi/processes/roofer:validate_point_cloud:v1"
      inputs:
        point_clouds: { type: Any }
      outputs:
        validation_report: { type: Any }
    in:
      # roofer doesn't take OGC by-reference inputs ({"href": ...}); it wants
      # its own list of {"kind": "url", "url": ...}. `valueFrom` adapts each
      # File (`self` is the list of Files) to that shape: the file's
      # location becomes roofer's url.
      point_clouds:
        source: point_clouds
        valueFrom: '$(self.map(function(f){ return {"kind": "url", "url": f.location}; }))'
    out: [validation_report]

  reconstruct:
    label: "Reconstruct buildings"
    run:
      class: Operation
      id: roofer:reconstruct_buildings:v1
      label: "Reconstruct Buildings"
      doc: "Calls the 'roofer:reconstruct_buildings:v1' OGC API Process."
      nldt:processLink:
        rel: process
        type: application/json
        href: "https://processes.staging.roofer-online.nl/ogcapi/processes/roofer:reconstruct_buildings:v1"
        internalHref: "https://processes.staging.roofer-online.nl/ogcapi/processes/roofer:reconstruct_buildings:v1"
      inputs:
        point_cloud_ids: { type: "int[]" }
        bag: { type: Any }
        name: { type: "string?" }
        config: { type: "Any?" }
      outputs:
        building_model: { type: Any }
    in:
      # Every point_cloud_id from the validation report, as a plain list.
      point_cloud_ids:
        source: validate/validation_report
        valueFrom: "$(self.point_clouds.map(function(p){ return p.point_cloud_id; }))"
      bag: bag
      name: name
      config: config
    out: [building_model]

  convert:
    label: "Convert format"
    run:
      class: Operation
      id: roofer:convert_format:v1
      label: "Convert Format"
      doc: "Calls the 'roofer:convert_format:v1' OGC API Process."
      nldt:processLink:
        rel: process
        type: application/json
        href: "https://processes.staging.roofer-online.nl/ogcapi/processes/roofer:convert_format:v1"
        internalHref: "https://processes.staging.roofer-online.nl/ogcapi/processes/roofer:convert_format:v1"
      inputs:
        model_3d_id: { type: int }
        formats:
          type: { type: array, items: { type: enum, symbols: [gpkg, cityjson] } }
      outputs:
        converted_model: { type: Any }
    in:
      # The id of the model the reconstruct step just built.
      model_3d_id:
        source: reconstruct/building_model
        valueFrom: "$(self.model_3d_id)"
      formats: formats
    out: [converted_model]
