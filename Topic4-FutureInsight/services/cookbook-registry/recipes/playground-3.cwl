cwlVersion: v1.2
class: Workflow
id: playground-3
label: "Playground Recipe 3"
doc: >
  A shared slot for trying out your own recipe. Anyone can edit and save it,
  so it holds whatever was saved last — Varidian's Subsidence Analysis
  process (where subsidence stays below a threshold, and so where
  construction is possible), or someone else's work in progress. To start
  fresh, open Edit Recipe → Orchestrator and click Reset: that loads this
  bundled version. Then Validate and Save.
$namespaces:
  nldt: https://fi-group.github.io/nldt-tb2/ns#
  iana: https://www.iana.org/assignments/media-types/

inputs:
  gw:
    type: float
  thickness:
    type: float
  geojson:
    type: Any
    label: "Surcharge area(s)"
    doc: "Paste a GeoJSON FeatureCollection."
  threshold:
    type: float

outputs:
  buildArea:
    type: File
    outputSource: varidian-cook_subsidence-analysis/buildArea

steps:
  varidian-cook_subsidence-analysis:
    run:
      class: Operation
      id: varidian-cook_subsidence-analysis
      label: "Subsidence Analysis App"
      doc: "Calls the 'varidian-cook_subsidence-analysis' OGC API Process."
      nldt:processLink:
        rel: process
        type: application/json
        href: "https://registry.playground.planspace.nl/processes/varidian-cook_subsidence-analysis"
        internalHref: "https://registry.playground.planspace.nl/processes/varidian-cook_subsidence-analysis"
      # What this tool accepts. geojson is deliberately Any without a format,
      # so the Cook sends the pasted FeatureCollection as-is, not wrapped in
      # {"value": ..., "mediaType": ...}.
      inputs:
        gw: { type: float }
        thickness: { type: float }
        geojson: { type: Any }
        threshold: { type: float }
      outputs:
        buildArea: { type: File }
    in:
      gw: gw
      thickness: thickness
      geojson: geojson
      threshold: threshold
    out: [buildArea]
