cwlVersion: v1.2
class: Workflow
id: playground-2
label: "Playground Recipe 2"
doc: >
  A shared slot for trying out your own recipe. Anyone can edit and save it,
  so it holds whatever was saved last — the starter Geolabs process sampler
  (Hello World services and GDAL/OGR geometry operations on Geonovum's
  ZOO-Project testbed server), or someone else's work in progress. To start
  fresh, open Edit Recipe → Orchestrator and click Reset: that loads the
  starter version, whose comments explain where to begin. Then Validate and
  Save.

# ============================================================================
#  WHAT THIS FILE IS
# ============================================================================
# A CWL (Common Workflow Language) v1.2 Workflow — the exact document the Cook
# Orchestrator executes, over plain HTTP calls to OGC API Processes. This
# starter runs a handful of the Geonovum testbed's EXTERNAL OGC API Processes
# (host1.tb.geonovum.geolabs.fr, a ZOO-Project server) side by side: two
# "Hello World" services in different languages, and a few GDAL/OGR geometry
# operations on one polygon. Most steps don't depend on each other, so the
# Cook Orchestrator runs them at the same time. One step is chained: GetArea
# measures the polygon that Buffer produced.
#
# Inputs come in two kinds:
#   - DATA inputs: `type: File` with a `format`. A dataset the recipe needs —
#     picked from the hub's data catalogue in the Recipe Wizard's Data
#     Ingredients step, never typed in. Its run-time value is a reference,
#     {"class": "File", "location": "<url>"}. Here: `polygon`, a GeoJSON file
#     (e.g. the hub's "Sample Polygon" dataset).
#   - PARAMETERS: every other type. Typed in on the Wizard's Parameters step.
#     Here: `name` and `buffer_distance`.
#
# Edit this document from the Orchestrator tab: change something, click
# Validate, and only once it comes back valid does Save become clickable.

# Notes on these processes (checked 2026-09-28; by-reference inputs checked
# 2026-10-22):
# - The polygon reaches Centroid and Buffer as an OGC by-reference input,
#   {"href": "<the File's location>", "type": "application/json"}: the
#   ZOO-Project server fetches it itself. The `type` comes from the `format`
#   on the step's own `run.inputs` entry (what that process expects). The
#   location must be reachable from the ZOO-Project server — a hub dataset on
#   the publicly deployed stack is; one on localhost is not.
# - A `format` on a step's `run.outputs` entry asks the process for that
#   output in that format: Centroid's result comes back as GeoJSON. Buffer's
#   is left in its default GML, which is exactly what GetArea needs.
# - Expected result for the 100 x 100 sample square buffered by 10: an area
#   of about 14314 (10000 + 4 * 1000 + pi * 100).
# - Not included, because they don't work on the testbed right now: the R
#   services (failR, hellor) never finish, and the OTB.* processes fail
#   with "No OTB Application found."

$namespaces:
  iana: https://www.iana.org/assignments/media-types/
  nldt: https://fi-group.github.io/nldt-tb2/ns#

inputs:
  name:
    type: string
    label: "Name"
    doc: "Who the Hello World services greet."
    default: nLDT
  polygon:
    type: File
    format: iana:application/geo+json
    label: "Polygon"
    doc: "A GeoJSON Polygon geometry file, used by the geometry steps."
  buffer_distance:
    type: float
    label: "Buffer distance"
    doc: "How far to buffer the polygon, in its own coordinate units."
    default: 10

outputs:
  greeting_python:
    type: string
    outputSource: hello_python/Result
  greeting_javascript:
    type: string
    outputSource: hello_javascript/result
  centroid:
    type: Any
    outputSource: centroid/Result
  buffered_polygon:
    type: string
    outputSource: buffer/Result
  buffered_area:
    type: float
    outputSource: area/Area

steps:
  hello_python:
    label: "Hello World (Python)"
    run:
      class: Operation
      id: HelloPy
      label: "Create a welcome message string."
      doc: "Calls the 'HelloPy' OGC API Process."
      nldt:processLink:
        rel: process
        type: application/json
        href: "https://host1.tb.geonovum.geolabs.fr/ogc-api/processes/HelloPy"
        internalHref: "https://host1.tb.geonovum.geolabs.fr/ogc-api/processes/HelloPy"
      inputs:
        a: { type: string }
      outputs:
        Result: { type: string }
    in:
      a: name
    out: [Result]

  hello_javascript:
    label: "Hello World (JavaScript)"
    run:
      class: Operation
      id: hellojs
      label: "HelloWorld Service in JavaScript"
      doc: "Calls the 'hellojs' OGC API Process."
      nldt:processLink:
        rel: process
        type: application/json
        href: "https://host1.tb.geonovum.geolabs.fr/ogc-api/processes/hellojs"
        internalHref: "https://host1.tb.geonovum.geolabs.fr/ogc-api/processes/hellojs"
      inputs:
        S: { type: string }
      outputs:
        result: { type: string }
    in:
      S: name
    out: [result]

  centroid:
    label: "Centroid"
    run:
      class: Operation
      id: Centroid
      label: "Computes the centroid of a polygon."
      doc: "Calls the 'Centroid' OGC API Process."
      nldt:processLink:
        rel: process
        type: application/json
        href: "https://host1.tb.geonovum.geolabs.fr/ogc-api/processes/Centroid"
        internalHref: "https://host1.tb.geonovum.geolabs.fr/ogc-api/processes/Centroid"
      inputs:
        InputPolygon: { type: File, format: "iana:application/json" }
      outputs:
        Result: { type: Any, format: "iana:application/json" }
    in:
      InputPolygon: polygon
    out: [Result]

  buffer:
    label: "Buffer"
    run:
      class: Operation
      id: Buffer
      label: "Create a buffer around a polygon."
      doc: "Calls the 'Buffer' OGC API Process."
      nldt:processLink:
        rel: process
        type: application/json
        href: "https://host1.tb.geonovum.geolabs.fr/ogc-api/processes/Buffer"
        internalHref: "https://host1.tb.geonovum.geolabs.fr/ogc-api/processes/Buffer"
      inputs:
        InputPolygon: { type: File, format: "iana:application/json" }
        BufferDistance: { type: float }
      outputs:
        Result: { type: string }
    in:
      InputPolygon: polygon
      BufferDistance: buffer_distance
    out: [Result]

  area:
    label: "Area of the buffered polygon"
    run:
      class: Operation
      id: GetArea
      label: "Compute geometry area."
      doc: "Calls the 'GetArea' OGC API Process."
      nldt:processLink:
        rel: process
        type: application/json
        href: "https://host1.tb.geonovum.geolabs.fr/ogc-api/processes/GetArea"
        internalHref: "https://host1.tb.geonovum.geolabs.fr/ogc-api/processes/GetArea"
      inputs:
        # No format on Buffer's output above: its default output is GML,
        # which is what GetArea needs — passed on by value, not as a File.
        InputPolygon: { type: string, format: "iana:text/xml" }
      outputs:
        Area: { type: float }
    in:
      InputPolygon: buffer/Result
    out: [Area]
