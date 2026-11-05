#!/usr/bin/env python3
"""Install the agentic setup on this machine. Safe to run again.

  python3 install.py --proxy-url https://your-proxy.example.ts.net \
                     [--skills-remote git@github.com:you/agent-skills.git]

* copies the CLIProxyAPI scripts to ~/.config/cliproxy, cliproxy-account to ~/.local/bin
* creates ~/.config/cliproxy/secrets.env (chmod 600) if missing
* clones the skills repo to ~/agent-skills if a remote is given and it's missing
* merges claude/settings.json into ~/.claude/settings.json (backup kept; existing
  keys outside the ones below are untouched, hooks are added, not replaced)
* adds the Executor block to ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md once
"""

import argparse
import json
import shutil
import stat
import subprocess
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOME = Path.home()
MARK = "<!-- agentic-setup:executor -->"


def install_file(src: Path, dest: Path, executable: bool = False) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dest)
    if executable:
        dest.chmod(dest.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    print(f"installed {dest}")


def merge_settings(proxy_url: str) -> None:
    path = HOME / ".claude" / "settings.json"
    template = json.loads((HERE / "claude" / "settings.json").read_text())
    template["env"]["ANTHROPIC_BASE_URL"] = proxy_url
    current = json.loads(path.read_text()) if path.exists() else {}
    if path.exists():
        backup = path.with_name(f"settings.json.bak-{time.strftime('%Y%m%d-%H%M%S')}")
        shutil.copyfile(path, backup)
        print(f"backed up {backup}")

    current.setdefault("env", {}).update(template["env"])
    current["apiKeyHelper"] = template["apiKeyHelper"]
    current["statusLine"] = template["statusLine"]
    hooks = current.setdefault("hooks", {})
    for event, groups in template["hooks"].items():
        existing = hooks.setdefault(event, [])
        have = {h.get("command") for g in existing for h in g.get("hooks", [])}
        for group in groups:
            if not any(h["command"] in have for h in group["hooks"]):
                existing.append(group)

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(current, indent=2) + "\n")
    print(f"updated {path}")


def add_block(path: Path) -> None:
    block = (HERE / "claude" / "CLAUDE.md").read_text()
    text = path.read_text() if path.exists() else ""
    if MARK in text:
        print(f"{path} already has the Executor block")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text + ("\n\n" if text.strip() else "") + block)
    print(f"added Executor block to {path}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--proxy-url", required=True, help="CLIProxyAPI base URL")
    ap.add_argument("--skills-remote", help="git URL of your private agent-skills repo")
    args = ap.parse_args()

    cfg = HOME / ".config" / "cliproxy"
    install_file(HERE / "cliproxy" / "claude-key.sh", cfg / "claude-key.sh", executable=True)
    install_file(HERE / "cliproxy" / "statusline.py", cfg / "statusline.py", executable=True)
    install_file(HERE / "cliproxy" / "cliproxy-account", HOME / ".local" / "bin" / "cliproxy-account", executable=True)
    secrets = cfg / "secrets.env"
    if not secrets.exists():
        text = (HERE / "cliproxy" / "secrets.env.example").read_text()
        secrets.write_text(text.replace("https://your-proxy.example.ts.net", args.proxy_url))
        secrets.chmod(0o600)
        print(f"created {secrets}: fill in the keys")

    skills = HOME / "agent-skills"
    if args.skills_remote and not skills.exists():
        subprocess.run(["git", "clone", args.skills_remote, str(skills)], check=True)
    if not (skills / "bin" / "skills-hook.py").exists():
        print(f"warning: {skills}/bin/skills-hook.py is missing; the skills hooks will do nothing until it's there")

    merge_settings(args.proxy_url)
    add_block(HOME / ".claude" / "CLAUDE.md")
    add_block(HOME / ".codex" / "AGENTS.md")


if __name__ == "__main__":
    main()
