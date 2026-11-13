cwlVersion: v1.2
class: Workflow
id: recipe-add-multiply-demo
label: "Add then Multiply"
doc: >
  Minimal two-step nLDT recipe used to validate the Sandbox Stack orchestration
  plumbing: sums two numbers, then multiplies the sum by a third number.
  result = (a + b) * c
$namespaces:
  nldt: https://fi-group.github.io/nldt-tb2/ns#

inputs:
  a:
    type: float
    label: "First addend"
  b:
    type: float
    label: "Second addend"
  c:
    type: float
    label: "Multiplier"

outputs:
  result:
    type: float
    outputSource: multiply/product

# The recipe owner's own per-step allowlist of which cataloged tools a hub is
# allowed to substitute in for that step, via the Wizard's Tool & Engine
# step — a per-run custom configuration, never touching this document (see
# cookbook-registry/app/cwl_parser.py::apply_tool_overrides). A step with no
# entry here only allows its own current tool. Can be edited under a step's
# "Alternative tools" in the Orchestrator editor.
nldt:compatibleTools:
  add: [add-two-numbers]
  multiply: [multiply-two-numbers, multiply-three-numbers]

# Each step's run.nldt:processLink is a structured, resolvable pointer to its
# real OGC API Process — the recipe telling the Cook Orchestrator directly
# where it lives, rather than the orchestrator having to already know via its
# own hardcoded registry (see cook-orchestrator/app/engine.py's
# _DEFAULT_TOOL_REGISTRY, kept as a fallback for steps with no link at all).
# Hand-authored here to mirror cookbook-registry/app/cwl_parser.py's
# TOOL_CATALOG exactly; the Orchestrator editor generates this block when a
# step's tool is added or changed through the UI.
steps:
  add:
    label: "Step 1 — Add"
    run:
      class: Operation
      id: add-two-numbers
      label: "Add two numbers"
      doc: "Calls the 'add-two-numbers' OGC API Process."
      nldt:processLink:
        rel: process
        type: application/json
        href: "https://nldt-tb2.clearly.app/api/tools/add/processes/add-two-numbers"
        internalHref: "http://tool-add:8000/processes/add-two-numbers"
      inputs:
        a: { type: float }
        b: { type: float }
      outputs:
        sum: { type: float }
    in:
      a: a
      b: b
    out: [sum]

  multiply:
    label: "Step 2 — Multiply"
    run:
      class: Operation
      id: multiply-two-numbers
      label: "Multiply two numbers"
      doc: "Calls the 'multiply-two-numbers' OGC API Process."
      nldt:processLink:
        rel: process
        type: application/json
        href: "https://nldt-tb2.clearly.app/api/tools/multiply/processes/multiply-two-numbers"
        internalHref: "http://tool-multiply:8000/processes/multiply-two-numbers"
      inputs:
        x: { type: float }
        y: { type: float }
      outputs:
        product: { type: float }
    in:
      x: add/sum
      y: c
    out: [product]
