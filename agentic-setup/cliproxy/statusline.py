#!/usr/bin/env python3
"""Claude Code status line: model, folder, and the pooled Claude accounts.

Reads GET /v0/management/auth-files from CLIProxyAPI (cached for 30 s) and
shows each Claude account: ● active, ○ disabled, ✕ unavailable / cooling down,
with its request count. Settings come from ~/.config/cliproxy/secrets.env.

Stock CLIProxyAPI does not report the 5-hour / weekly percentages; it only
knows which accounts are active, disabled or cooling down. To show the
percentages, add a quota plugin and read /v8/management/plugins/<id>/quota.
"""

import json
import os
import sys
import time
import urllib.request
from pathlib import Path

SECRETS = Path(os.environ.get("CLIPROXY_SECRETS", Path.home() / ".config/cliproxy/secrets.env"))
CACHE = Path.home() / ".cache" / "cliproxy-statusline.json"
TTL = 30


def env() -> dict:
    out = {}
    try:
        for line in SECRETS.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip("'\"")
    except OSError:
        pass
    return out


def accounts(cfg: dict) -> list:
    if CACHE.exists() and time.time() - CACHE.stat().st_mtime < TTL:
        try:
            return json.loads(CACHE.read_text())
        except ValueError:
            pass
    url, key = cfg.get("CLIPROXY_URL"), cfg.get("CLIPROXY_MANAGEMENT_KEY")
    if not url or not key:
        return []
    req = urllib.request.Request(
        url.rstrip("/") + "/v0/management/auth-files",
        headers={"Authorization": f"Bearer {key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=3) as r:
            files = json.load(r).get("files", [])
    except Exception:
        return [{"error": True}]
    claude = [f for f in files if str(f.get("provider", "")).lower() == "claude"]
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps(claude))
    return claude


def cell(f: dict) -> str:
    name = (f.get("email") or f.get("label") or f.get("name") or "?").split("@")[0]
    if f.get("disabled"):
        mark = "○"
    elif f.get("unavailable"):
        mark = "✕"
    else:
        mark = "●"
    return f"{mark}{name}·{f.get('success', 0)}"


def main() -> None:
    try:
        session = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        session = {}
    model = (session.get("model") or {}).get("display_name", "")
    folder = Path((session.get("workspace") or {}).get("current_dir") or os.getcwd()).name
    parts = [p for p in (model, folder) if p]
    accts = accounts(env())
    if accts and accts[0].get("error"):
        parts.append("proxy unreachable")
    elif accts:
        parts.append(" ".join(cell(f) for f in accts))
    print(" │ ".join(parts))


if __name__ == "__main__":
    main()
