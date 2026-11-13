"""Publishes every bundled recipe under recipes/*.cwl through the Cookbook
Registry's real HTTP API (which in turn registers each one with the Records
Wrapper). This is not a fixture load — it's exercising the actual publish
flow a recipe author would use, once per bundled recipe.

Each file's own top-level `id`/`label`/`doc` fields become the recipe's
id/title/description, so adding a new bundled recipe later (e.g. another
playground slot) is just "drop a new .cwl file in recipes/, rerun this
script" — no script changes needed.

Usage:
    python scripts/seed_demo_recipe.py [cookbook_base_url]
"""

from __future__ import annotations

import json
import pathlib
import sys
import urllib.error
import urllib.request

import yaml

DEFAULT_BASE_URL = "http://localhost:8002"
RECIPES_DIR = pathlib.Path(__file__).resolve().parent.parent / "recipes"


def _load_recipe(path: pathlib.Path) -> dict:
    cwl_text = path.read_text(encoding="utf-8")
    doc = yaml.safe_load(cwl_text) or {}
    recipe_id = doc.get("id") or path.stem
    description = (doc.get("doc") or "").strip() or None
    return {
        "id": recipe_id,
        "title": doc.get("label") or recipe_id,
        "description": description,
        "keywords": [],
        "cwl": cwl_text,
    }


def _publish(base_url: str, payload: dict) -> bool:
    req = urllib.request.Request(
        f"{base_url}/recipes",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read().decode("utf-8")
            print(f"{payload['id']}: HTTP {resp.status}")
            print(body)
        # A 201 only means the Cookbook Registry stored the recipe. It
        # deliberately does NOT fail the request when publishing on to the
        # Records Wrapper (and thus CKAN) fails — losing a recipe over a
        # transient catalog outage would be worse. It reports that in the
        # body instead (see main.py's register_recipe), so a seed run that
        # ignored it would print five cheerful 201s while leaving recipes
        # stored-but-undiscoverable: absent from the catalog the UI lists
        # from, and therefore invisible in the app. Treat it as a failure.
        try:
            catalog = json.loads(body)
        except ValueError:
            return True  # not JSON — nothing more we can check
        if catalog.get("catalog_published") is False:
            print(
                f"{payload['id']}: STORED BUT NOT PUBLISHED TO THE CATALOG — "
                f"{catalog.get('catalog_error') or 'no detail given'}\n"
                f"  It will not appear in the UI. Re-run this script once the "
                f"Records Wrapper and CKAN are healthy (it is idempotent)."
            )
            return False
        return True
    except urllib.error.HTTPError as exc:
        print(f"{payload['id']}: HTTP {exc.code}")
        print(exc.read().decode("utf-8"))
        return False


def main() -> int:
    base_url = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_BASE_URL
    paths = sorted(RECIPES_DIR.glob("*.cwl"))
    if not paths:
        print(f"No .cwl files found under {RECIPES_DIR}")
        return 1

    ok = True
    for path in paths:
        ok = _publish(base_url, _load_recipe(path)) and ok
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
