"""One-time setup for the real-CKAN-backed Records Wrapper (see DECISIONS.md,
D14): waits for CKAN to be ready, mints an API token for the Records
Wrapper's own CKAN client, creates the "recipes" organization every catalog
record lives under, and writes the token to ./secrets/ckan_api_token.txt.

Why this can't just be a docker-compose env var: CKAN's sysadmin user and
database only exist once the `ckan` container has actually finished its
first-run bootstrap (baked into the `ckan/ckan-base` image's own prerun.py)
— an API token can only be minted after that, so there's a genuine
chicken-and-egg gap docker-compose alone can't close.

The Records Wrapper reads the token file lazily and retries (rather than
crashing) if it isn't there yet, so this script can run any time after
`docker compose up` — and safely again later, if a fresh token is ever
needed (it just mints a new one; old tokens keep working until revoked).

Usage:
    python services/records-wrapper/scripts/bootstrap_ckan.py [ckan_base_url]
"""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.request

DEFAULT_CKAN_URL = "http://localhost:8020"
SYSADMIN_NAME = "ckan_admin"
TOKEN_NAME = "records-wrapper"
ORGANIZATION = "recipes"
SECRETS_DIR = pathlib.Path(__file__).resolve().parent.parent.parent.parent / "secrets"
TOKEN_FILE = SECRETS_DIR / "ckan_api_token.txt"


def _wait_for_ckan(base_url: str, timeout: float = 180.0) -> None:
    deadline = time.monotonic() + timeout
    url = f"{base_url}/api/3/action/status_show"
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=5) as resp:
                if resp.status == 200:
                    print("CKAN is up.")
                    return
        except (urllib.error.URLError, urllib.error.HTTPError):
            pass
        print("Waiting for CKAN...")
        time.sleep(3)
    raise SystemExit(f"CKAN never became ready at {url} within {timeout:.0f}s")


def _create_token() -> str:
    result = subprocess.run(
        [
            "docker", "compose", "exec", "-T", "ckan",
            "ckan", "user", "token", "add", SYSADMIN_NAME, TOKEN_NAME, "--quiet",
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise SystemExit(
            f"'ckan user token add' failed (exit {result.returncode}).\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if not lines:
        raise SystemExit(f"'ckan user token add' produced no output. stderr:\n{result.stderr}")
    return lines[-1]


def _api_call(base_url: str, action: str, token: str, payload: dict) -> dict:
    req = urllib.request.Request(
        f"{base_url}/api/3/action/{action}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": token},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return json.loads(exc.read().decode("utf-8"))


def _ensure_organization(base_url: str, token: str) -> None:
    body = _api_call(
        base_url, "organization_create", token, {"name": ORGANIZATION, "title": ORGANIZATION.capitalize()}
    )
    if body.get("success"):
        print(f"Created CKAN organization '{ORGANIZATION}'.")
        return
    error_text = json.dumps(body.get("error") or {}).lower()
    if "already exists" in error_text or "already in use" in error_text:
        print(f"CKAN organization '{ORGANIZATION}' already exists.")
        return
    raise SystemExit(f"Could not create CKAN organization '{ORGANIZATION}': {body.get('error')}")


def main() -> int:
    base_url = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_CKAN_URL
    _wait_for_ckan(base_url)
    token = _create_token()
    _ensure_organization(base_url, token)
    SECRETS_DIR.mkdir(parents=True, exist_ok=True)
    TOKEN_FILE.write_text(token, encoding="utf-8")
    print(f"Wrote CKAN API token to {TOKEN_FILE}")
    print("records-wrapper will pick it up on its next request — no restart required.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
