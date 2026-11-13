"""Live fetch of Rotterdam's municipal boundary from PDOK — the Kadaster
"Bestuurlijke Gebieden" WFS (https://service.pdok.nl/kadaster/brk-bestuurlijke-gebieden/wfs/v1_0),
a real WFS 2.0.0 service (verified against its own GetCapabilities: feature
types Gemeentegebied/Provinciegebied/Landgebied, output formats GML 3.2,
GeoJSON, and JSON). `outputFormat=json` is requested — WFS 2.0.0 natively
supports GeoJSON as one of its output encodings, so using the real WFS
protocol here doesn't mean giving up GeoJSON as the content shape the rest
of the pipeline (Leaflet, shapely, ../tool-geo-buffer) actually consumes.

Fetches every municipality and filters for "Rotterdam" client-side, rather
than a server-side attribute filter — confirmed directly (both
`CQL_FILTER=naam='Rotterdam'` and a `resultType=hits` count check) that this
service silently ignores CQL_FILTER and always returns every municipality
regardless, so a server-side filter can't be relied on. The tradeoff is
real: the full collection is ~30MB and takes on the order of 10-15 seconds
to fetch. Deliberately not cached anywhere despite that cost — every call
re-fetches from PDOK, so the "PDOK Rotterdam Boundary Data" resource
genuinely reflects PDOK's own current data on every use, not a stale copy
taken once at seed time.
"""

from __future__ import annotations

import httpx

WFS_URL = "https://service.pdok.nl/kadaster/brk-bestuurlijke-gebieden/wfs/v1_0"
WFS_PARAMS = {
    "service": "WFS",
    "version": "2.0.0",
    "request": "GetFeature",
    "typeName": "bestuurlijkegebieden:Gemeentegebied",
    "outputFormat": "json",
    "srsName": "EPSG:4326",
}
# The full collection alone measured ~13.5s server-side; a generous margin
# above that so a slightly slower PDOK response doesn't spuriously time out.
REQUEST_TIMEOUT = 45.0


class PdokFetchError(RuntimeError):
    """Raised when PDOK can't be reached or returns no matching feature."""


def fetch_rotterdam_boundary_geometry() -> dict:
    """Returns Rotterdam's boundary as a bare GeoJSON geometry (MultiPolygon),
    in WGS84 — the shape ../tool-geo-buffer's `geometry` input expects."""
    try:
        resp = httpx.get(WFS_URL, params=WFS_PARAMS, timeout=REQUEST_TIMEOUT)
    except httpx.HTTPError as exc:
        raise PdokFetchError(f"Could not reach PDOK: {exc}") from exc
    if resp.status_code >= 400:
        raise PdokFetchError(f"PDOK returned HTTP {resp.status_code}: {resp.text}")

    body = resp.json()
    features = body.get("features") or []
    rotterdam = next((f for f in features if (f.get("properties") or {}).get("naam") == "Rotterdam"), None)
    if not rotterdam:
        raise PdokFetchError(
            f"PDOK returned {len(features)} municipalities but none named 'Rotterdam'"
        )

    geometry = rotterdam.get("geometry")
    if not isinstance(geometry, dict):
        raise PdokFetchError("PDOK feature for Rotterdam has no geometry")
    return geometry
