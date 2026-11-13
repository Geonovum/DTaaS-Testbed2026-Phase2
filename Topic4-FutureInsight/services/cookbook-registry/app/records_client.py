"""Thin client for publishing/retracting this registry's recipes in the OGC API
Records Wrapper's catalog.

This is the real integration point named in the architecture: the Cookbook
Registry owns the recipe payload (the CWL document); the Records Wrapper only
ever stores discovery metadata plus a link back here ("metadata contains URL
link to Cookbook file").
"""

from __future__ import annotations

import os

import httpx

RECORDS_WRAPPER_URL = os.getenv("RECORDS_WRAPPER_URL", "http://records-wrapper:8000")
REQUEST_TIMEOUT = float(os.getenv("RECORDS_WRAPPER_TIMEOUT", "5.0"))


class RecordsWrapperError(RuntimeError):
    """Raised when the Records Wrapper can't be reached or rejects the request.

    Callers decide how tolerant to be of this — see app/main.py, which persists
    a recipe locally regardless and reports catalog-publish failures back to
    the caller rather than losing the recipe over a transient network issue.
    """


def publish_record(
    *,
    record_id: str,
    title: str,
    description: str | None,
    keywords: list[str],
    cookbook_url: str,
) -> None:
    payload = {
        "id": record_id,
        "title": title,
        "description": description,
        "keywords": keywords,
        "type": "recipe",
        "cookbook_url": cookbook_url,
        "cwl_media_type": "application/cwl+yaml",
    }
    url = f"{RECORDS_WRAPPER_URL}/collections/recipes/items"
    try:
        resp = httpx.post(url, json=payload, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        raise RecordsWrapperError(f"Could not publish '{record_id}' to Records Wrapper: {exc}") from exc


def retract_record(record_id: str) -> None:
    url = f"{RECORDS_WRAPPER_URL}/collections/recipes/items/{record_id}"
    try:
        resp = httpx.delete(url, timeout=REQUEST_TIMEOUT)
        if resp.status_code not in (204, 404):
            resp.raise_for_status()
    except httpx.HTTPError as exc:
        raise RecordsWrapperError(f"Could not retract '{record_id}' from Records Wrapper: {exc}") from exc
