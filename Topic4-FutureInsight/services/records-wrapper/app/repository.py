"""Repository layer — the sole place that talks to the datastore.

Every other module goes through this class rather than calling CKAN
directly. This is the swap seam described in DECISIONS.md, D14: the first,
purpose-built SQLite store lived behind this same interface
(`list`/`get`/`upsert`/`delete`), and swapping in a real CKAN instance meant
rewriting only this file.

Every "record" here is a CKAN dataset ("package"): our `collection_id` maps
to a CKAN organization of the same name (created once by
`scripts/bootstrap_ckan.py`), our `id` maps to CKAN's `name` (its unique,
url-safe slug — both existing recipe ids like "recipe-add-multiply-demo" and
"playground-1" already satisfy CKAN's `[a-z0-9_-]+` naming rule), and fields
CKAN has no first-class column for (`type`, `cookbook_url`, `cwl_media_type`)
are stored as CKAN `extras`.
"""

from __future__ import annotations

import datetime
import re
from typing import Any, Optional

import httpx

from . import models

_INVALID_TAG_CHARS = re.compile(r"[^A-Za-z0-9 ._-]")


class CKANError(RuntimeError):
    """CKAN couldn't be reached, or rejected a call for a reason other than
    'not found' (which callers handle as a normal None/False, not an error)."""


class _CKANNotFound(RuntimeError):
    """Internal signal only — a package genuinely doesn't exist in CKAN."""


def _sanitize_tag(keyword: str) -> str:
    # CKAN's tag-name validator only allows letters, numbers, spaces, '.',
    # '-', '_' (2-100 chars). Callers upstream (Cookbook Registry) can send
    # arbitrary keyword strings, so sanitize rather than fail an entire
    # publish over one bad keyword.
    cleaned = _INVALID_TAG_CHARS.sub("-", keyword).strip("-") or "tag"
    return cleaned[:100]


def _parse_ckan_datetime(value: Optional[str]) -> Optional[datetime.datetime]:
    # CKAN returns metadata_created/metadata_modified as naive UTC ISO
    # strings with no trailing "Z" (e.g. "2015-08-12T10:05:45.331909") — this
    # relies on the `ckan` container running with TZ=UTC (see
    # docker-compose.yml), matching what `main.py::record_to_feature` assumes
    # when it appends "Z" itself.
    if not value:
        return None
    return datetime.datetime.fromisoformat(value)


class RecordRepository:
    def __init__(self, base_url: str, api_token: str, organization: str):
        self.organization = organization
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": api_token},
            timeout=10.0,
        )

    def close(self) -> None:
        self._client.close()

    def _call(self, action: str, payload: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        try:
            resp = self._client.post(f"/api/3/action/{action}", json=payload or {})
        except httpx.HTTPError as exc:
            raise CKANError(f"CKAN request '{action}' failed: {exc}") from exc
        try:
            body = resp.json()
        except ValueError as exc:
            raise CKANError(f"CKAN returned a non-JSON response for '{action}': {resp.text[:200]}") from exc
        if not body.get("success"):
            error = body.get("error") or {}
            if error.get("__type") in ("Not Found", "NotFound", "Not Found Error"):
                raise _CKANNotFound(action)
            raise CKANError(f"CKAN action '{action}' failed: {error}")
        return body["result"]

    def _show_raw(self, record_id: str) -> Optional[dict[str, Any]]:
        try:
            return self._call("package_show", {"id": record_id})
        except _CKANNotFound:
            return None

    def _from_ckan_package(self, pkg: dict[str, Any]) -> models.RecordModel:
        extras = {e["key"]: e["value"] for e in pkg.get("extras", [])}
        return models.RecordModel(
            id=pkg["name"],
            collection_id=self.organization,
            type=extras.get("record_type", "recipe"),
            title=pkg.get("title") or pkg["name"],
            description=pkg.get("notes"),
            keywords=[t["name"] for t in pkg.get("tags", [])],
            cookbook_url=extras.get("cookbook_url") or None,
            cwl_media_type=extras.get("cwl_media_type") or "application/cwl+yaml",
            created=_parse_ckan_datetime(pkg.get("metadata_created")),
            updated=_parse_ckan_datetime(pkg.get("metadata_modified")),
        )

    def _to_ckan_payload(self, record: models.RecordModel) -> dict[str, Any]:
        return {
            "title": record.title,
            "notes": record.description,
            "owner_org": self.organization,
            "tags": [{"name": _sanitize_tag(k)} for k in (record.keywords or [])],
            "extras": [
                # "record_type", not "type" — CKAN packages already have a
                # native "type" field (dataset type), and rejects an extra
                # with the same name as a schema field.
                {"key": "record_type", "value": record.type},
                {"key": "cookbook_url", "value": record.cookbook_url or ""},
                {"key": "cwl_media_type", "value": record.cwl_media_type or "application/cwl+yaml"},
            ],
        }

    def list(
        self,
        collection_id: str,
        q: str | None = None,
        limit: int = 10,
        offset: int = 0,
    ) -> tuple[list[models.RecordModel], int]:
        result = self._call(
            "package_search",
            {
                "q": q or "",
                "fq": f"organization:{collection_id}",
                "rows": limit,
                "start": offset,
                "sort": "metadata_created desc",
            },
        )
        items = [self._from_ckan_package(pkg) for pkg in result.get("results", [])]
        return items, result.get("count", len(items))

    def get(self, collection_id: str, record_id: str) -> models.RecordModel | None:
        pkg = self._show_raw(record_id)
        if pkg is None or pkg.get("state") != "active":
            return None
        if (pkg.get("organization") or {}).get("name") != collection_id:
            return None
        return self._from_ckan_package(pkg)

    def upsert(self, record: models.RecordModel) -> models.RecordModel:
        payload = self._to_ckan_payload(record)
        existing = self._show_raw(record.id)
        if existing is None:
            pkg = self._call("package_create", {**payload, "name": record.id})
        else:
            # A previously-deleted package's name stays reserved in CKAN
            # until purged — re-publishing under that id must revive it
            # (state: active) rather than hit package_create's "URL already
            # in use" validation error. This genuinely happens here: the
            # Cookbook Registry's own delete/re-seed cycle does exactly this.
            if existing.get("state") != "active":
                payload["state"] = "active"
            pkg = self._call("package_update", {**payload, "id": record.id})
        return self._from_ckan_package(pkg)

    def delete(self, collection_id: str, record_id: str) -> bool:
        if self.get(collection_id, record_id) is None:
            return False
        self._call("package_delete", {"id": record_id})
        return True
