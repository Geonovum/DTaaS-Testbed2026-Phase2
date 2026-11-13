cwlVersion: v1.2
class: Workflow
id: recipe-rotterdam-buffer-demo
label: "Rotterdam Boundary Buffer"
doc: >
  A minimal one-step nLDT recipe over real geodata: buffers Rotterdam's
  municipal outline by a given distance. The boundary is a data input — a
  GeoJSON file the recipe receives by reference (e.g. PDOK's Bestuurlijke
  Gebieden boundary, served live by the hub's "PDOK Rotterdam Boundary Data"
  dataset). Only the buffer distance is a typed parameter.

# Data inputs vs parameters: a workflow input of `type: File` (with a
# `format`) is a DATA input — a dataset the recipe needs, picked from a
# catalogue when the recipe is set up and passed by reference: its run-time
# value is {"class": "File", "location": "<url>"}, and the Cook Orchestrator
# hands the process an OGC API Processes by-reference input,
# {"href": "<url>", "type": "application/geo+json"}, which the process
# fetches itself. Every other input type (float here) is a PARAMETER — a
# value typed in when the recipe is run.
$namespaces:
  iana: https://www.iana.org/assignments/media-types/
  nldt: https://fi-group.github.io/nldt-tb2/ns#

inputs:
  geometry:
    type: File
    format: iana:application/geo+json
    label: "Input boundary"
    doc: "The boundary to buffer, as a GeoJSON geometry or Feature file (WGS84)."
  bufferDistance:
    type: float
    label: "Buffer distance (meters)"

outputs:
  bufferedOutline:
    type: Any
    outputSource: buffer/bufferedGeometry

# See cookbook-registry/app/cwl_parser.py::TOOL_CATALOG and
# cook-orchestrator/app/engine.py::_DEFAULT_TOOL_REGISTRY, which this step's
# nldt:processLink must stay in lockstep with (see add-multiply-demo.cwl's own
# comment on this for the full explanation of why three copies exist).
steps:
  buffer:
    label: "Step 1 — Buffer"
    run:
      class: Operation
      id: buffer-geometry
      label: "Buffer a geometry"
      doc: "Calls the 'buffer-geometry' OGC API Process."
      nldt:processLink:
        rel: process
        type: application/json
        href: "https://nldt-tb2.clearly.app/api/tools/geo-buffer/processes/buffer-geometry"
        internalHref: "http://tool-geo-buffer:8000/processes/buffer-geometry"
      inputs:
        geometry: { type: File, format: "iana:application/geo+json" }
        distance: { type: float }
      outputs:
        bufferedGeometry: { type: Any }
    in:
      geometry: geometry
      distance: bufferDistance
    out: [bufferedGeometry]
