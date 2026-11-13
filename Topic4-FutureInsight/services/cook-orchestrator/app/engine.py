"""Executes a recipe: fetches its execution DAG from the Cookbook API Registry,
then calls each step's OGC API Process tool service in the DAG's (already
topologically sorted) order, piping one step's declared output into the next
step's mapped input exactly as described by the DAG's `source_type` references.

This is the actual "DAG Traversal + Parameter Injection + Data Piping" the
architecture names as the Cook Orchestrator's job.

Data inputs: a recipe's data ingredients arrive as CWL File values,
`{"class": "File", "location": "<URL>", "format": "<media-type IRI>"}` — a
reference, never the data itself. Each one is handed to its process as an
OGC API Processes by-reference input, `{"href": "<URL>", "type": "<media
type>"}`, and the process fetches the data (see _to_ogc_reference).
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from urllib.parse import urljoin

import httpx

COOKBOOK_URL = os.getenv("COOKBOOK_URL", "http://cookbook-registry:8000")

# Maps a CWL Operation's `id` (see cookbook-registry/app/cwl_parser.py) to the
# base URL of the concrete OGC API Processes service that implements it. This
# is deliberately a static, overridable mapping rather than a discovery
# mechanism — see DECISIONS.md, D10.
_DEFAULT_TOOL_REGISTRY = {
    "add-two-numbers": "http://tool-add:8000",
    "multiply-two-numbers": "http://tool-multiply:8000",
    "multiply-three-numbers": "http://tool-multiply3:8000",
    "buffer-geometry": "http://tool-geo-buffer:8000",
}
TOOL_REGISTRY: dict[str, str] = {
    **_DEFAULT_TOOL_REGISTRY,
    **json.loads(os.getenv("TOOL_REGISTRY_JSON", "{}")),
}
REQUEST_TIMEOUT = float(os.getenv("TOOL_REQUEST_TIMEOUT", "10.0"))
# For a tool that answers with an async job (see call_tool): how often to
# poll it, and how long one step's job may run before it's given up on (and
# dismissed on the remote server).
JOB_POLL_INTERVAL = float(os.getenv("TOOL_JOB_POLL_INTERVAL", "2.0"))
JOB_TIMEOUT = float(os.getenv("TOOL_JOB_TIMEOUT", "300.0"))
# How long one whole recipe run may take, all steps together — the cook's
# own "stop cooking" time, however many steps are still to go.
COOK_TIMEOUT = float(os.getenv("COOK_TIMEOUT", "900.0"))
# How many independent steps (none waiting on another's output) may run at
# the same time.
COOK_MAX_PARALLEL = max(1, int(os.getenv("COOK_MAX_PARALLEL", "4")))

# Rewrites of a data input's URL for a tool reached on the internal Docker
# network — {"<public prefix>": "<internal prefix>"}, e.g.
# {"http://localhost:8014": "http://hub-datasets:8000"}. A browser hands the
# Cook a File whose `location` it can itself reach (a published port or the
# gateway's public origin), which a container usually can't; external
# processes (anything not on this stack's network) always get the public URL
# unchanged. See _rewrite_location.
LOCATION_REWRITES: dict[str, str] = json.loads(os.getenv("LOCATION_REWRITES", "{}") or "{}")

# Marks an optional workflow input the caller didn't send and that has no
# default — dropped from the step's execute request rather than sent as null.
_OMIT = object()


class ExecutionError(RuntimeError):
    """Raised for any failure while resolving or executing a recipe. Carries a
    human-readable message that's safe to return to an API caller, and where
    the failure came from (see origin): `source` is "cook" (this orchestrator
    itself — a missing parameter, a time limit, a bug), "registry" (the
    Cookbook API Registry) or "tool" (a step's OGC API Process: it answered
    with an error, its job failed, or it couldn't be reached), with the
    `process_id`/`url` it concerns. `step`/`step_label` are filled in by
    _run_step for a failure during one step."""

    def __init__(self, message: str, source: str = "cook", process_id: str | None = None, url: str | None = None):
        super().__init__(message)
        self.source = source
        self.process_id = process_id
        self.url = url
        self.step: str | None = None
        self.step_label: str | None = None

    def origin(self) -> dict:
        """{source, processId?, url?, step?, stepLabel?} — what a caller
        needs to tell "our cook failed" from "the tool reported an error"."""
        fields = {
            "source": self.source,
            "processId": self.process_id,
            "url": self.url,
            "step": self.step,
            "stepLabel": self.step_label,
        }
        return {k: v for k, v in fields.items() if v is not None}


class ExecutionCancelled(ExecutionError):
    """Raised when a run is stopped on request (see jobs.dismiss_job)."""


class _Run:
    """One recipe run's shared state: the overall COOK_TIMEOUT deadline, an
    optional cancel flag (a threading.Event, set by jobs.dismiss_job), an
    internal `abort` flag (set when one step fails, to stop the others
    running alongside it), and per-step progress reported through an
    optional `on_progress(steps)` callback — `steps` being one dict per DAG
    step, in DAG order: {id, label, processId, status, remoteStatus,
    remoteProgress, message, errorSource}, where `status` is "pending" (not
    started yet), then the step's remote job status as it runs ("accepted"/
    "running"), then "successful", "failed" or "dismissed"; `errorSource`
    is a failed step's ExecutionError.origin().

    Steps running in parallel each get their own view (see for_step), which
    is what call_tool/_wait_for_job are handed as their `run`."""

    def __init__(self, cancel=None, on_progress=None, steps=None):
        self.deadline = time.monotonic() + COOK_TIMEOUT
        self.cancel = cancel
        self.abort = threading.Event()
        self.abort_reason = ""
        self.root = self  # views share the root's abort_reason
        self.on_progress = on_progress or (lambda steps: None)
        self.lock = threading.Lock()
        self.steps = [
            {
                "id": s["id"],
                "label": s.get("label", s["id"]),
                "processId": s["process_id"],
                "status": "pending",
                "remoteStatus": None,
                "remoteProgress": None,
                "message": None,
                "errorSource": None,
            }
            for s in steps or []
        ]
        self.progress: dict | None = None  # this view's own step, if any

    def for_step(self, progress: dict) -> "_Run":
        """A view onto this run for one step: same deadline, flags and
        callback, but update() changes that step's progress."""
        view = object.__new__(_Run)
        view.__dict__.update(self.__dict__)
        view.progress = progress
        return view

    def update(self, **fields) -> None:
        """Updates this view's step's progress and reports all steps."""
        with self.lock:
            if self.progress is not None:
                self.progress.update(fields)
            snapshot = [dict(s) for s in self.steps]
        self.on_progress(snapshot)

    def remaining(self) -> float:
        return self.deadline - time.monotonic()

    def stopped(self) -> bool:
        return (self.cancel is not None and self.cancel.is_set()) or self.abort.is_set()

    def check(self, where: str) -> None:
        if self.cancel is not None and self.cancel.is_set():
            raise ExecutionCancelled(f"Cancelled {where}")
        if self.abort.is_set():
            raise ExecutionCancelled(f"Stopped {where}, because {self.root.abort_reason}")
        if self.remaining() <= 0:
            raise ExecutionError(f"Recipe run exceeded its {COOK_TIMEOUT:.0f}s time limit {where}")

    def sleep(self, seconds: float) -> None:
        """Sleeps, but wakes within a fraction of a second on cancel/abort."""
        until = time.monotonic() + max(0.0, min(seconds, self.remaining()))
        while not self.stopped():
            left = until - time.monotonic()
            if left <= 0:
                return
            if self.cancel is not None:
                self.cancel.wait(min(left, 0.25))
            else:
                self.abort.wait(min(left, 0.25))


def fetch_dag(recipe_id: str, tool_overrides: dict[str, str] | None = None) -> dict:
    """Fetches the execution DAG to actually run. With no overrides, this is
    the recipe's own stored/default shape (GET .../dag). `tool_overrides`
    (stepId -> tool id) is a hub's own per-run custom configuration — e.g.
    from the UI's Wizard Tool & Engine step — never written back to the
    recipe; it's applied fresh via POST .../effective for this execution
    only, the same endpoint the UI itself calls to preview the resulting
    parameter shape before deploying."""
    if tool_overrides:
        url = f"{COOKBOOK_URL}/recipes/{recipe_id}/effective"
        try:
            resp = httpx.post(url, json={"toolOverrides": tool_overrides}, timeout=REQUEST_TIMEOUT)
        except httpx.HTTPError as exc:
            raise ExecutionError(f"Could not reach Cookbook Registry for '{recipe_id}': {exc}", "registry", url=url) from exc
        if resp.status_code == 404:
            raise ExecutionError(f"Recipe '{recipe_id}' not found in Cookbook Registry", "registry", url=url)
        if resp.status_code >= 400:
            raise ExecutionError(f"Cookbook Registry returned {resp.status_code} for '{recipe_id}': {resp.text}", "registry", url=url)
        return resp.json()["dag"]

    url = f"{COOKBOOK_URL}/recipes/{recipe_id}/dag"
    try:
        resp = httpx.get(url, timeout=REQUEST_TIMEOUT)
    except httpx.HTTPError as exc:
        raise ExecutionError(f"Could not reach Cookbook Registry for '{recipe_id}': {exc}", "registry", url=url) from exc
    if resp.status_code == 404:
        raise ExecutionError(f"Recipe '{recipe_id}' not found in Cookbook Registry", "registry", url=url)
    if resp.status_code >= 400:
        raise ExecutionError(f"Cookbook Registry returned {resp.status_code} for '{recipe_id}': {resp.text}", "registry", url=url)
    return resp.json()


def _pick_path(value, path: list[str] | None, where: str):
    """Applies a step input's `valueFrom` (see cookbook-registry/app/
    cwl_parser.py's _value_from_path), already parsed to a path like
    ["a", "b"] — or ["a", "*", "b"], where "*" applies the rest of the path
    to every item of the list at that point."""
    for i, key in enumerate(path or []):
        if key == "*":
            if not isinstance(value, list):
                raise ExecutionError(f"{where}: expected a list at '{'.'.join(path[:i])}' (valueFrom map)")
            return [_pick_path(item, path[i + 1 :], where) for item in value]
        if not isinstance(value, dict) or key not in value:
            raise ExecutionError(f"{where}: value has no field '{key}' (valueFrom path {'.'.join(path)})")
        value = value[key]
    return value


def _apply_template(value, template: dict | None, where: str):
    """Applies a step input's object-template `valueFrom` (see cookbook-
    registry/app/cwl_parser.py's _object_template): builds one new object
    from `value` — or, for a `map` template, one per item of the list
    `value` — whose fields are literals or field paths on it. This is how a
    recipe hands a data input to a process in that process's own shape,
    e.g. roofer's `[{kind: "url", url: <File location>}]`."""
    if not template:
        return value

    def build(item):
        out = {}
        for key, spec in template["fields"].items():
            out[key] = spec["literal"] if "literal" in spec else _pick_path(item, spec["path"], where)
        return out

    if template.get("map"):
        if not isinstance(value, list):
            raise ExecutionError(f"{where}: expected a list for valueFrom map, got {type(value).__name__}")
        return [build(item) for item in value]
    return build(value)


def _resolve(ref: dict, parameters: dict, step_outputs: dict[str, dict], dag: dict | None = None):
    """A workflow input the caller didn't send falls back to its CWL
    `default` (dag.input_defaults), or — if it's optional with no default —
    resolves to _OMIT so the caller can leave it out of the request."""
    dag = dag or {}
    if ref["source_type"] == "workflow_input":
        name = ref["name"]
        if parameters.get(name) is not None:
            value = parameters[name]
        elif name in (dag.get("input_defaults") or {}):
            value = dag["input_defaults"][name]
        elif name in (dag.get("optional_inputs") or []):
            return _OMIT
        else:
            raise ExecutionError(f"Missing required parameter '{name}'")
        where = f"Parameter '{name}'"
        return _apply_template(_pick_path(value, ref.get("path"), where), ref.get("template"), where)
    step_id, output_name = ref["step"], ref["output"]
    if step_id not in step_outputs:
        raise ExecutionError(f"Step '{step_id}' has not produced output yet — DAG ordering bug")
    if output_name not in step_outputs[step_id]:
        raise ExecutionError(f"Step '{step_id}' did not produce declared output '{output_name}'")
    where = f"Output '{step_id}/{output_name}'"
    return _apply_template(_pick_path(step_outputs[step_id][output_name], ref.get("path"), where), ref.get("template"), where)


_IANA_PREFIXES = ("iana:", "https://www.iana.org/assignments/media-types/", "http://www.iana.org/assignments/media-types/")


def _media_type(fmt) -> str | None:
    """A File's own `format` (a media-type IRI, `iana:` prefix, or bare
    media type) as a plain media type — same reading as cookbook-registry's
    cwl_parser._media_type, minus `$namespaces` (a File value carries its
    format already expanded, or in one of these spellings)."""
    if not isinstance(fmt, str) or not fmt.strip():
        return None
    fmt = fmt.strip()
    for prefix in _IANA_PREFIXES:
        if fmt.startswith(prefix):
            return fmt[len(prefix):] or None
    return fmt if "/" in fmt and ":" not in fmt else None


def _is_cwl_file(value) -> bool:
    return isinstance(value, dict) and value.get("class") == "File" and isinstance(value.get("location"), str)


def _rewrite_location(location: str) -> str:
    """`location` with the longest matching LOCATION_REWRITES prefix
    swapped for its internal counterpart (unchanged if none matches)."""
    for public in sorted(LOCATION_REWRITES, key=len, reverse=True):
        if location.startswith(public):
            return LOCATION_REWRITES[public] + location[len(public):]
    return location


def _to_ogc_reference(value, media_type: str | None, internal: bool):
    """A CWL File value (or a list of them) as an OGC API Processes
    by-reference input, `{"href": location, "type": media type}`. The media
    type is the step's own declared input format (what the process says it
    accepts) if any, else the File's own format. `internal`: the tool is on
    this stack's Docker network, so LOCATION_REWRITES apply. Anything that
    isn't a File is returned unchanged — including a value a valueFrom
    already reshaped (e.g. roofer's {kind, url})."""
    if isinstance(value, list) and value and all(_is_cwl_file(v) for v in value):
        return [_to_ogc_reference(v, media_type, internal) for v in value]
    if not _is_cwl_file(value):
        return value
    href = _rewrite_location(value["location"]) if internal else value["location"]
    reference = {"href": href}
    mt = media_type or _media_type(value.get("format"))
    if mt:
        reference["type"] = mt
    return reference


def _is_internal_tool(step: dict) -> bool:
    """Whether the Cook reaches this step's tool on the internal Docker
    network: its nldt:processLink has an `internalHref` different from its
    public `href` (this stack's own tools), or it has no link and resolves
    through TOOL_REGISTRY. External processes declare one URL for both."""
    link = step.get("process_link") or {}
    internal_href = link.get("internalHref")
    if not internal_href:
        return True
    return internal_href.rstrip("/") != str(link.get("href") or "").rstrip("/")


def _execution_url(process_id: str, internal_href: str | None) -> str:
    """Where to actually POST an execution request for this step. Prefers the
    recipe's own declared `run.nldt:processLink.internalHref` (see
    cookbook-registry/app/cwl_parser.py) — the recipe telling Cook directly
    where it lives, rather than Cook having to already know — and falls back
    to TOOL_REGISTRY (a step with no link at all, e.g. an older-shaped
    recipe) so nothing that worked before this field existed breaks. Pure and
    network-free so it's directly assertable in a test."""
    if internal_href:
        # Tolerate a link that already points at the execute endpoint itself
        # (easy to paste by hand) instead of at the process description.
        base = internal_href.rstrip("/")
        if base.endswith("/execution"):
            base = base[: -len("/execution")]
        return f"{base}/execution"
    base_url = TOOL_REGISTRY.get(process_id)
    if not base_url:
        raise ExecutionError(f"No tool service registered for process '{process_id}'")
    return f"{base_url}/processes/{process_id}/execution"


_INLINE_VALUE_KEYS = {"value", "mediaType", "encoding", "schema", "format"}


_MULTIPART_BOUNDARY = re.compile(r'boundary="?([^";\s]+)"?', re.IGNORECASE)
_PART_HEADER = re.compile(r"^[A-Za-z][A-Za-z0-9-]*: ")


def _parse_multipart_text(text: str) -> dict | None:
    """{name: value} from a multipart/related results body, as ZOO-Project
    returns one for a job with several outputs: as the body *text* of a
    response labelled application/json, starting with its own
    `Content-Type: Multipart/Related; boundary=...` line. Each part is named
    by its Content-ID, and its value follows its headers, running straight
    into the next boundary. Values that parse as JSON (numbers, objects)
    are returned parsed, anything else as text. None if `text` isn't one."""
    head = text[:500]
    if "multipart/" not in head.lower():
        return None
    match = _MULTIPART_BOUNDARY.search(head)
    if not match:
        return None
    outputs = {}
    for part in text.split(f"--{match.group(1)}")[1:]:
        lines = part.replace("\r\n", "\n").split("\n")
        name = next((l.split(":", 1)[1].strip() for l in lines if l.lower().startswith("content-id:")), None)
        if not name:
            continue
        # Drop the part's leading header (and blank) lines; the rest is its value.
        i = 0
        while i < len(lines) and (not lines[i].strip() or _PART_HEADER.match(lines[i])):
            i += 1
        raw = "\n".join(lines[i:]).strip()
        try:
            outputs[name] = json.loads(raw)
        except ValueError:
            outputs[name] = raw
    return outputs or None


def _normalize_outputs(process_id: str, body, declared_outputs: list[str]) -> dict:
    """Turns whatever an OGC API Process returned into {outputName: value}.

    Accepts this stack's own tool services' `{"outputs": {...}}`, a standard
    Part 1 results document (`{outputName: value}` or `{outputName: {"value":
    ...}}`), ZOO-Project's multipart text for several outputs (see
    _parse_multipart_text), and the raw value a server may return for a
    single-output process — assigned to that step's one declared output."""
    if isinstance(body, str):
        parts = _parse_multipart_text(body)
        if parts is not None:
            return parts
    if isinstance(body, dict) and isinstance(body.get("outputs"), dict):
        return body["outputs"]
    if isinstance(body, dict) and declared_outputs and set(body) & set(declared_outputs):
        return {
            name: value["value"]
            if isinstance(value, dict) and "value" in value and set(value) <= _INLINE_VALUE_KEYS
            else value
            for name, value in body.items()
        }
    if len(declared_outputs) == 1:
        return {declared_outputs[0]: body}
    raise ExecutionError(f"Tool '{process_id}' returned an unexpected response shape: {body!r}", "tool", process_id)


def _link(body: dict, rel: str) -> str | None:
    for link in body.get("links") or []:
        if isinstance(link, dict) and link.get("rel") == rel and link.get("href"):
            return link["href"]
    return None


def _json_or_text(resp: httpx.Response):
    """A results body: JSON if it parses, else the raw text. Part 1 lets a
    single-output process return its bare value in its own media type, and
    some servers (ZOO-Project) even send that raw text labelled as
    application/json — so the Content-Type header can't be trusted here."""
    try:
        return resp.json()
    except ValueError:
        return resp.text


def _get_json(process_id: str, url: str, what: str, allow_text: bool = False):
    try:
        resp = httpx.get(url, timeout=REQUEST_TIMEOUT, headers={"Accept": "application/json"})
    except httpx.HTTPError as exc:
        raise ExecutionError(f"Tool '{process_id}' {what} at {url} unreachable: {exc}", "tool", process_id, url) from exc
    if resp.status_code >= 400:
        raise ExecutionError(f"Tool '{process_id}' {what} at {url} returned {resp.status_code}: {resp.text}", "tool", process_id, url)
    if allow_text:
        return _json_or_text(resp)
    try:
        return resp.json()
    except ValueError as exc:
        raise ExecutionError(
            f"Tool '{process_id}' {what} at {url} did not return JSON: {resp.text[:200]!r}", "tool", process_id, url
        ) from exc


def _dismiss_remote_job(job_url: str) -> None:
    """Best-effort OGC API Processes "dismiss" (DELETE /jobs/{id}) of a remote
    job we're walking away from — so a cancelled or timed-out step doesn't
    keep running on someone else's server. Failure is ignored: the server
    may not support dismiss at all, and we're giving up on the job anyway."""
    try:
        httpx.delete(job_url, timeout=REQUEST_TIMEOUT, headers={"Accept": "application/json"})
    except httpx.HTTPError:
        pass


def _wait_for_job(process_id: str, execution_url: str, resp: httpx.Response, run: _Run | None = None):
    """Follows an async OGC API Processes job (Part 1 "async-execute") to its
    results: polls the job's status document until it's terminal, then
    fetches its results. The job's address comes from the Location header,
    else its status body's `self`/`monitor` link, else `{api}/jobs/{jobID}`.
    A relative address (a server may send just `/jobs/{jobID}`) is resolved
    against the URL that returned it.

    Gives up — and dismisses the remote job — after JOB_TIMEOUT, when the
    whole run hits COOK_TIMEOUT, or as soon as the run is cancelled."""
    run = run or _Run()
    body = resp.json() if resp.content else {}
    run.update(
        status=body.get("status") or "accepted",
        remoteStatus=body.get("status"),
        remoteProgress=body.get("progress"),
        message=body.get("message"),
    )
    job_id = body.get("jobID") or body.get("id")
    job_url = resp.headers.get("Location") or _link(body, "self") or _link(body, "monitor")
    if not job_url and job_id:
        api_root = execution_url.split("/processes/", 1)[0]
        job_url = f"{api_root}/jobs/{job_id}"
    if not job_url:
        raise ExecutionError(
            f"Tool '{process_id}' started an async job but gave no way to follow it: {body!r}", "tool", process_id, execution_url
        )
    job_url = urljoin(str(resp.url), job_url)

    deadline = time.monotonic() + JOB_TIMEOUT
    while body.get("status") not in ("successful", "failed", "dismissed"):
        try:
            run.check(f"while '{process_id}' was running")
        except ExecutionError:
            _dismiss_remote_job(job_url)
            raise
        if time.monotonic() > deadline:
            _dismiss_remote_job(job_url)
            raise ExecutionError(
                f"Tool '{process_id}' did not finish within {JOB_TIMEOUT:.0f}s (job {job_url})", "tool", process_id, job_url
            )
        run.sleep(min(JOB_POLL_INTERVAL, deadline - time.monotonic()))
        if run.stopped():
            continue  # handled by run.check at the top of the loop
        body = _get_json(process_id, job_url, "job")
        run.update(
            status=body.get("status") or "running",
            remoteStatus=body.get("status"),
            remoteProgress=body.get("progress"),
            message=body.get("message"),
        )

    results_url = urljoin(job_url, _link(body, "results") or f"{job_url.rstrip('/')}/results")
    if body["status"] != "successful":
        reason = _failure_reason(results_url) or body.get("message") or repr(body)
        raise ExecutionError(f"Tool '{process_id}' job {body['status']}: {reason}", "tool", process_id, job_url)
    return _get_json(process_id, results_url, "results", allow_text=True)


def _failure_reason(results_url: str) -> str | None:
    """A failed OGC API Processes job's actual error: per Part 1, fetching a
    failed job's results returns an exception document ({type, title,
    detail}). A job's own status `message` can't be relied on for this —
    e.g. ZOO-Project leaves it at "ZOO-Kernel accepted to run your
    service!" even once the job has failed. Best effort: None if the
    results can't be fetched or don't look like an exception."""
    try:
        resp = httpx.get(results_url, timeout=REQUEST_TIMEOUT, headers={"Accept": "application/json"})
        doc = resp.json()
    except Exception:  # noqa: BLE001 — only ever improves an error message
        return None
    if not isinstance(doc, dict):
        return None
    parts = [str(doc[k]) for k in ("title", "detail") if doc.get(k)]
    if not parts and isinstance(doc.get("description"), str):
        parts = [doc["description"]]
    return ": ".join(parts) or None


def call_tool(
    process_id: str,
    inputs: dict,
    internal_href: str | None = None,
    declared_outputs: list[str] | None = None,
    run: _Run | None = None,
    input_formats: dict[str, str] | None = None,
    output_formats: dict[str, str] | None = None,
) -> dict:
    """Executes one OGC API Process. Asks for async execution (`Prefer:
    respond-async`) — a long-running process like roofer's building
    reconstruction would otherwise outlive any sane HTTP timeout — but a
    server that only does sync, like this stack's own tool services, just
    ignores the header and answers 200 with its results; both are handled.
    A sync answer is still bounded by REQUEST_TIMEOUT (and by what's left of
    the run's COOK_TIMEOUT).

    `input_formats`/`output_formats` ({name: media type}, from the step's
    CWL `format`s — see cookbook-registry's cwl_parser._step_formats): an
    input with a format is sent as an OGC qualified value, `{"value": ...,
    "mediaType": ...}` (unless it already is one, or a `{"href": ...}`
    link); an output with a format is requested in it, via the execute
    request's `outputs`. Without any formats the request is plain
    `{"inputs": {...}}`, exactly as before."""
    run = run or _Run()
    url = _execution_url(process_id, internal_href)
    request = {"inputs": {name: _qualified(value, (input_formats or {}).get(name)) for name, value in inputs.items()}}
    if output_formats:
        request["outputs"] = {name: {"format": {"mediaType": mt}} for name, mt in output_formats.items()}
    try:
        resp = httpx.post(
            url,
            json=request,
            timeout=max(1.0, min(REQUEST_TIMEOUT, run.remaining())),
            headers={"Prefer": "respond-async", "Accept": "application/json"},
        )
    except httpx.HTTPError as exc:
        raise ExecutionError(f"Tool '{process_id}' at {url} unreachable: {exc}", "tool", process_id, url) from exc
    if resp.status_code >= 400:
        raise ExecutionError(f"Tool '{process_id}' returned {resp.status_code}: {resp.text}", "tool", process_id, url)
    body = _wait_for_job(process_id, url, resp, run) if resp.status_code in (201, 202) else _json_or_text(resp)
    return _normalize_outputs(process_id, body, declared_outputs or [])


def _qualified(value, media_type: str | None):
    """`value` as an OGC qualified input value in `media_type` — left alone
    without a media type, or if it's already qualified/a link."""
    if not media_type:
        return value
    if _is_qualified(value):
        return value
    if isinstance(value, list) and value and all(_is_qualified(v) for v in value):
        return value  # e.g. several data inputs, each already a reference
    return {"value": value, "mediaType": media_type}


def _is_qualified(value) -> bool:
    return isinstance(value, dict) and ("value" in value or "href" in value)


def _step_dependencies(step: dict) -> set[str]:
    return {ref["step"] for ref in step["inputs"].values() if ref["source_type"] == "step_output"}


def _run_step(step: dict, run: _Run, parameters: dict, step_outputs: dict[str, dict], dag: dict) -> dict:
    """Runs one step (every step it depends on has already finished) and
    returns its trace entry. `run` is this step's own view (_Run.for_step)."""
    run.check(f"before step '{step['id']}'")
    run.update(status="running")
    resolved_inputs = {
        input_name: _resolve(ref, parameters, step_outputs, dag) for input_name, ref in step["inputs"].items()
    }
    # Data inputs (CWL Files) go to the process by reference. The trace below
    # records the inputs in exactly this form — what was actually sent, minus
    # only call_tool's qualified-value wrapping of formatted plain values.
    internal = _is_internal_tool(step)
    resolved_inputs = {
        name: _to_ogc_reference(value, (step.get("input_formats") or {}).get(name), internal)
        for name, value in resolved_inputs.items()
        if value is not _OMIT
    }
    internal_href = (step.get("process_link") or {}).get("internalHref")
    try:
        outputs = call_tool(
            step["process_id"],
            resolved_inputs,
            internal_href,
            step.get("outputs"),
            run,
            step.get("input_formats"),
            step.get("output_formats"),
        )
    except ExecutionCancelled as exc:
        run.update(status="dismissed", message=str(exc))
        raise
    except ExecutionError as exc:
        exc.step, exc.step_label = step["id"], step.get("label", step["id"])
        run.update(status="failed", message=str(exc), errorSource=exc.origin())
        raise
    run.update(status="successful", remoteProgress=100 if run.progress["remoteStatus"] else None)
    return {
        "step": step["id"],
        "label": step.get("label", step["id"]),
        "process_id": step["process_id"],
        "resolved_via": "step-link" if internal_href else "registry",
        "inputs": resolved_inputs,
        "outputs": outputs,
    }


def execute_recipe(
    recipe_id: str,
    parameters: dict,
    tool_overrides: dict[str, str] | None = None,
    *,
    cancel=None,
    on_progress=None,
) -> dict:
    """Runs the full recipe. Returns {"outputs": {...}, "trace": [...]}.

    Steps run as soon as every step they take input from has finished, so
    steps that don't depend on each other run at the same time (at most
    COOK_MAX_PARALLEL at once); a plain chain still runs one after another.
    If one step fails, the others still running are stopped too (their
    remote jobs dismissed) and that first failure is raised.

    The whole run is bounded by COOK_TIMEOUT, and each async step by
    JOB_TIMEOUT. `cancel` (a threading.Event) stops it early, between steps
    or while waiting on a step's remote job, raising ExecutionCancelled;
    `on_progress(steps)` gets every step's progress (see _Run) on each change.

    `trace` records exactly what each step was called with and what it
    returned (in DAG order) — useful both for debugging and for a UI wanting
    to show the piping actually happening, not just the final number.

    `tool_overrides` (stepId -> tool id), if given, runs this execution
    against a per-run tool-substituted variant of the recipe instead of its
    stored default (see fetch_dag) — the recipe itself is never modified.
    """
    dag = fetch_dag(recipe_id, tool_overrides)
    run = _Run(cancel, on_progress, dag["steps"])
    run.update()
    steps = {step["id"]: step for step in dag["steps"]}
    progress = {p["id"]: p for p in run.steps}
    dependencies = {step_id: _step_dependencies(step) for step_id, step in steps.items()}
    step_outputs: dict[str, dict] = {}
    traces: dict[str, dict] = {}
    pending = list(steps)  # DAG (topological) order
    running: dict = {}  # future -> step id
    first_error: ExecutionError | None = None

    with ThreadPoolExecutor(max_workers=COOK_MAX_PARALLEL, thread_name_prefix="cook-step") as pool:
        while pending or running:
            if first_error is None and not run.stopped():
                ready = [sid for sid in pending if dependencies[sid] <= step_outputs.keys()]
                for step_id in ready[: COOK_MAX_PARALLEL - len(running)]:
                    pending.remove(step_id)
                    # A snapshot of the outputs so far: everything this step
                    # depends on is in it, and it never changes underneath it.
                    future = pool.submit(
                        _run_step, steps[step_id], run.for_step(progress[step_id]), parameters, dict(step_outputs), dag
                    )
                    running[future] = step_id
            if not running:
                break  # nothing left that can start: stopped, or a failure
            done, _ = wait(running, return_when=FIRST_COMPLETED)
            for future in done:
                step_id = running.pop(future)
                try:
                    traces[step_id] = future.result()
                    step_outputs[step_id] = traces[step_id]["outputs"]
                except ExecutionError as exc:
                    if first_error is None and not isinstance(exc, ExecutionCancelled):
                        first_error = exc
                        run.abort_reason = f"step '{step_id}' failed"
                        run.abort.set()
                    elif first_error is None:
                        first_error = exc
                except Exception as exc:  # noqa: BLE001 — surfaced as a normal step failure
                    if first_error is None:
                        first_error = ExecutionError(f"Step '{step_id}' crashed: {type(exc).__name__}: {exc}")
                        first_error.step, first_error.step_label = step_id, steps[step_id].get("label", step_id)
                        run.abort_reason = f"step '{step_id}' failed"
                        run.abort.set()

    if first_error is not None:
        raise first_error
    run.check("after the last step")
    trace = [traces[step_id] for step_id in steps if step_id in traces]
    result = {out["id"]: _resolve(out, parameters, step_outputs, dag) for out in dag["workflow_outputs"]}
    result = {name: value for name, value in result.items() if value is not _OMIT}
    return {"outputs": result, "trace": trace}
