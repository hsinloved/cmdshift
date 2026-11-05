#!/usr/bin/env python3
"""Link personal skills into Claude Code and Codex, and keep them in sync.

Wire it up as Claude Code hooks in ~/.claude/settings.json:

  "SessionStart": [{"hooks": [{"type": "command",
      "command": "python3 ~/agent-skills/bin/skills-hook.py start"}]}],
  "SessionEnd":   [{"hooks": [{"type": "command",
      "command": "python3 ~/agent-skills/bin/skills-hook.py end"}]}]

start:
  * links every skill in global/ into ~/.claude/skills and ~/.agents/skills
  * reads the current repo's git remote, matches it against projects.json
    and links that project's skills into <repo>/.claude/skills and
    <repo>/.agents/skills, hidden through .git/info/exclude (never .gitignore)
  * pulls this skills repo in the background
  * tells the session about skills linked for the first time, since Claude
    Code reads its skill list before this hook runs
end:
  * commits and pushes any skill edits, in the background

The hook never fails a session: every error is reported on stderr and it exits 0.
"""

from __future__ import annotations

import fnmatch
import json
import os
import re
import socket
import subprocess
import sys
from pathlib import Path

SKILLS_REPO = Path(os.environ.get("AGENT_SKILLS_DIR", Path(__file__).resolve().parent.parent))
HOME = Path.home()
USER_SKILL_DIRS = [HOME / ".claude" / "skills", HOME / ".agents" / "skills"]
PROJECT_SKILL_DIRS = [Path(".claude") / "skills", Path(".agents") / "skills"]
RESERVED = {"global", "bin", ".git"}
LOG = SKILLS_REPO / ".sync.log"


def git(*args: str, cwd: Path) -> str | None:
    try:
        out = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.stdout.strip() if out.returncode == 0 else None


def skills_in(folder: Path) -> list[Path]:
    if not folder.is_dir():
        return []
    return sorted(p for p in folder.iterdir() if p.is_dir() and (p / "SKILL.md").is_file())


def link(src: Path, dest: Path) -> bool:
    """Point dest at src. Returns True when a new link was made."""
    if dest.is_symlink():
        if Path(os.readlink(dest)) == src:
            return False
        if not owned_by_us(dest):
            warn(f"skip {dest}: a link to something else is already there")
            return False
        dest.unlink()
    elif dest.exists():
        warn(f"skip {dest}: a real skill with that name is already there")
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.symlink_to(src, target_is_directory=True)
    return True


def owned_by_us(path: Path) -> bool:
    target = Path(os.readlink(path))
    try:
        target.relative_to(SKILLS_REPO)
        return True
    except ValueError:
        return False


def prune(folder: Path, keep: set[str]) -> None:
    """Remove links into this repo whose skill was deleted or moved."""
    if not folder.is_dir():
        return
    for entry in folder.iterdir():
        if entry.is_symlink() and owned_by_us(entry) and entry.name not in keep:
            entry.unlink()


def repo_slug(remote: str) -> str | None:
    """git@github.com:owner/repo.git or https://host/owner/repo -> owner/repo"""
    m = re.search(r"[:/]([^/:]+/[^/]+?)(?:\.git)?/?$", remote)
    return m.group(1).lower() if m else None


def match_projects(slug: str) -> list[str]:
    try:
        mapping = json.loads((SKILLS_REPO / "projects.json").read_text())
    except (OSError, ValueError) as e:
        warn(f"projects.json unreadable: {e}")
        return []
    return [
        project
        for project, patterns in mapping.items()
        if not project.startswith("_")
        and any(fnmatch.fnmatchcase(slug, p.lower()) for p in patterns)
    ]


def hide(repo_root: Path, rel_paths: list[str]) -> None:
    """Add paths to .git/info/exclude (shared by every worktree of the repo)."""
    exclude = git("rev-parse", "--path-format=absolute", "--git-common-dir", cwd=repo_root)
    if not exclude:
        return
    exclude_file = Path(exclude) / "info" / "exclude"
    existing = exclude_file.read_text().splitlines() if exclude_file.exists() else []
    missing = [p for p in rel_paths if p not in existing]
    if missing:
        exclude_file.parent.mkdir(parents=True, exist_ok=True)
        with exclude_file.open("a") as f:
            if existing and existing[-1] != "":
                f.write("\n")
            f.write("# personal skills (agent-skills)\n" if "# personal skills (agent-skills)" not in existing else "")
            f.write("".join(p + "\n" for p in missing))


def background(script: str) -> None:
    """Run a shell snippet in the skills repo, detached, serialised by a lock."""
    lock = SKILLS_REPO / ".git" / "skills-sync.lock"
    cmd = (
        f'exec 9>"{lock}"; '
        "if command -v flock >/dev/null; then flock -w 60 9 || exit 0; fi; "
        f"{{ date; {script}; }} >>\"{LOG}\" 2>&1"
    )
    subprocess.Popen(
        ["sh", "-c", cmd],
        cwd=SKILLS_REPO,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def warn(msg: str) -> None:
    print(f"skills-hook: {msg}", file=sys.stderr)


def start(cwd: Path) -> None:
    new: list[Path] = []

    global_skills = skills_in(SKILLS_REPO / "global")
    for folder in USER_SKILL_DIRS:
        for skill in global_skills:
            if link(skill, folder / skill.name):
                new.append(folder / skill.name)
        prune(folder, {s.name for s in global_skills})

    root = git("rev-parse", "--show-toplevel", cwd=cwd)
    remote = git("remote", "get-url", "origin", cwd=cwd) if root else None
    slug = repo_slug(remote) if remote else None
    if root and slug and Path(root).resolve() != SKILLS_REPO:
        root_path = Path(root)
        project_skills = [s for p in match_projects(slug) for s in skills_in(SKILLS_REPO / p)]
        names = {s.name for s in project_skills}
        hidden = []
        for rel in PROJECT_SKILL_DIRS:
            for skill in project_skills:
                if link(skill, root_path / rel / skill.name):
                    new.append(root_path / rel / skill.name)
                hidden.append(f"/{rel.as_posix()}/{skill.name}")
            prune(root_path / rel, names)
        hide(root_path, hidden)

    background("git pull --rebase --autostash --quiet")

    claude_new = [p for p in new if ".claude" in p.parts]
    if claude_new:
        lines = [
            "These personal skills were linked just now, after this session read its skill list. "
            "They are not in your skill list yet. Read the SKILL.md when a task fits one:"
        ]
        lines += [f"- {p.name}: {p / 'SKILL.md'}" for p in claude_new]
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": "\n".join(lines),
            }
        }))


def end() -> None:
    host = socket.gethostname().split(".")[0]
    background(
        'if [ -n "$(git status --porcelain)" ]; then '
        "git add -A && "
        f'git commit --quiet -m "skills: update from {host}" && '
        "git pull --rebase --autostash --quiet && git push --quiet; "
        "fi"
    )


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        payload = json.loads(sys.stdin.read() or "{}") if not sys.stdin.isatty() else {}
    except ValueError:
        payload = {}
    cwd = Path(payload.get("cwd") or os.getcwd())
    if mode == "start":
        start(cwd)
    elif mode == "end":
        end()
    else:
        warn("usage: skills-hook.py start|end")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # never break a session over skills
        warn(f"error: {e}")
    sys.exit(0)
