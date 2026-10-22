#!/usr/bin/env python3
"""
kanban_clone store — Option B backend adapted to kanban-clone's model.

Clone model (NOT kanban.py's T-int model):
  Task { id: uuid, projectId: uuid, title, description,
         status: backlog|running|done|blocked,
         priority: low|medium|high|critical,
         agentId?, agentName?, sessionId?,
         modelId?, modelProviderID?,
         createdAt, updatedAt }
  Project { id: uuid, name, path, description, agentIds[],
            allowedModels[] ("providerID/modelID", [] = unrestricted), createdAt }

Storage: SQLite file shared between host, Vite dev server, and Docker
via the /work bind mount:
  host:      <repo>/.kanban-data/kanban.db
  container: /work/kanban-clone/.kanban-data/kanban.db
Env override: KANBAN_DB (explicit file) or KANBAN_DATA_DIR (directory).

Usage:
  python server/kanban.py init
  python server/kanban.py project create --name "X" --path "C:/..." [--id <uuid>]
                                   [--allowed-model ollama/llama3 --allowed-model openai/gpt-5]
                                   [--clear-allowed-models]
  python server/kanban.py project list
  python server/kanban.py task create --project <projectId> --title "T" [--description D] [--priority high] [--agent-id A] [--id <uuid>]
  python server/kanban.py task list --project <projectId> [--status running]
  python server/kanban.py task show <taskId>
  python server/kanban.py task update <taskId> [--title T] [--description D] [--priority P] [--agent-id A] [--agent-name N] [--session-id S] [--model-id M] [--model-provider P] [--blocked-by "id1,id2"]
  python server/kanban.py task move <taskId> <backlog|running|done|blocked>
  python server/kanban.py task deps <taskId>
  python server/kanban.py task delete <taskId>
  python server/kanban.py worktree create <taskId> [--base <branch>]
  python server/kanban.py worktree merge  <taskId> [--target <branch>] [--cleanup]
  python server/kanban.py worktree remove <taskId> [--force] [--delete-branch]
  python server/kanban.py worktree list   [--project <projectId>]
  python server/kanban.py events list [--task <taskId>] [--limit 50]

All write commands print JSON to stdout (machine-readable for plugin/HTTP).
Human-readable errors go to stderr with non-zero exit.
"""

import argparse
import json
import os
import shutil
import sqlite3
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent

DEFAULT_DATA_DIR = Path(
    os.getenv("KANBAN_DATA_DIR", str(REPO / ".kanban-data"))
)
DEFAULT_DB = Path(os.getenv("KANBAN_DB", str(DEFAULT_DATA_DIR / "kanban.db")))

# Base path: all projects must live under this folder (folder NAME only from browser).
for _k in ("KANBAN_PROJECTS_ROOT", "KANBAN_WORKTREES_ROOT"):
    # Load .env manually so kanban.py works even when not launched via vite.
    _envp = REPO / ".env"
    if _envp.exists() and not os.getenv(_k):
        try:
            # utf-8-sig: .env files written by PowerShell start with a BOM,
            # which would otherwise prefix the first key and break matching.
            for _line in _envp.read_text(encoding="utf-8-sig").splitlines():
                _line = _line.strip()
                if _line and not _line.startswith("#") and "=" in _line:
                    _kk, _vv = _line.split("=", 1)
                    if _kk.strip() == _k and _vv.strip():
                        os.environ[_k] = _vv.strip()
        except Exception:
            pass

VALID_STATUSES = ("backlog", "running", "done", "blocked", "archived")
VALID_PRIORITIES = ("low", "medium", "high", "critical")

SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL DEFAULT '',
    folder TEXT NOT NULL DEFAULT '',
    git_url TEXT,
    git_branch TEXT NOT NULL DEFAULT 'main',
    description TEXT NOT NULL DEFAULT '',
    acceptance_criteria TEXT,
    agent_ids TEXT NOT NULL DEFAULT '[]',
    allowed_models TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'backlog',
    priority TEXT NOT NULL DEFAULT 'medium',
    agent_id TEXT,
    agent_name TEXT,
    session_id TEXT,
    model_id TEXT,
    model_provider_id TEXT,
    startup_phase TEXT,
    startup_error TEXT,
    kind TEXT NOT NULL DEFAULT 'oneshot',
    heartbeat_at TEXT,
    expected_sec INTEGER,
    cycle_interval_sec INTEGER,
    progress TEXT NOT NULL DEFAULT '',
    parent_session_id TEXT,
    -- Task-to-task link: the task that created this task. Set automatically
    -- from the parent session (see resolve_parent_task_id).
    parent_task_id TEXT,
    -- Who set the current status: the actor of the last status write.
    status_by TEXT,
    blocked_by_task_ids TEXT NOT NULL DEFAULT '[]',
    result TEXT,
    result_context TEXT,
    notified_at TEXT,
    due_date TEXT,
    worktree_path TEXT,
    worktree_branch TEXT,
    worktree_state TEXT,
    worktree_note TEXT,
    feature_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
-- NOTE: idx_tasks_parent_task is created in get_conn() AFTER the column
-- backfill, so old DBs (no parent_task_id column yet) do not fail here.
-- A feature groups the tasks of one unit of work. All its tasks share one
-- git worktree and one branch, so the steps of a feature never fight over
-- files. The feature branch is merged into the project branch at the end.
CREATE TABLE IF NOT EXISTS features (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    -- The session that created the feature (the feature orchestrator). A task
    -- that is delegated by that session joins the same feature.
    owner_session_id TEXT,
    worktree_path TEXT,
    worktree_branch TEXT,
    base_branch TEXT,
    merge_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_features_project ON features(project_id);
-- NOTE: idx_tasks_parent_notified is created in get_conn() AFTER the
-- notified_at backfill, so old DBs (table exists, column missing) don't
-- fail here with "no such column" at executescript time.

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    task_id TEXT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT
);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_uuid() -> str:
    return str(uuid.uuid4())


def get_conn(db_path: Path) -> sqlite3.Connection:
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    # Backfill columns for DBs created by older versions of this file.
    cols = {r[1] for r in conn.execute("PRAGMA table_info(tasks)").fetchall()}
    for col in ("agent_id", "agent_name", "session_id", "model_id", "model_provider_id",
                "startup_phase", "startup_error"):
        if col not in cols:
            conn.execute(f"ALTER TABLE tasks ADD COLUMN {col} TEXT")
    for col, ddl in (
        ("kind", "TEXT NOT NULL DEFAULT 'oneshot'"),
        ("heartbeat_at", "TEXT"),
        ("expected_sec", "INTEGER"),
        ("cycle_interval_sec", "INTEGER"),
        ("progress", "TEXT NOT NULL DEFAULT ''"),
        ("parent_session_id", "TEXT"),
        ("parent_task_id", "TEXT"),
        ("status_by", "TEXT"),
        ("blocked_by_task_ids", "TEXT NOT NULL DEFAULT '[]'"),
        ("result", "TEXT"),
        ("result_context", "TEXT"),
        ("acceptance_criteria", "TEXT"),
        # Delivery ledger: set when a finished task's result has been queued back
        # into its parent session (see vite.config.js reconcileResultsLoop).
        # NULL means "not yet delivered", so restarts retry automatically.
        ("notified_at", "TEXT"),
        ("due_date", "TEXT"),
        # Worktree isolation: every task can run in its own git worktree.
        # path = worktree folder, branch = branch inside it, state = lifecycle.
        ("worktree_path", "TEXT"),
        ("worktree_branch", "TEXT"),
        ("worktree_state", "TEXT"),
        ("worktree_note", "TEXT"),
        # Feature group: the task works in the feature worktree, not its own.
        ("feature_id", "TEXT"),
    ):
        if col not in cols:
            conn.execute(f"ALTER TABLE tasks ADD COLUMN {col} {ddl}")
    fcols = {r[1] for r in conn.execute("PRAGMA table_info(features)").fetchall()}
    if "owner_session_id" not in fcols:
        conn.execute("ALTER TABLE features ADD COLUMN owner_session_id TEXT")
    pcols = {r[1] for r in conn.execute("PRAGMA table_info(projects)").fetchall()}
    for col, ddl in (
        ("agent_ids", "TEXT NOT NULL DEFAULT '[]'"),
        ("folder", "TEXT NOT NULL DEFAULT ''"),
        ("git_url", "TEXT"),
        ("git_branch", "TEXT NOT NULL DEFAULT 'main'"),
        ("allowed_models", "TEXT"),
    ):
        if col not in pcols:
            conn.execute(f"ALTER TABLE projects ADD COLUMN {col} {ddl}")
    # Index the delivery-ledger scan. Created here (not in SCHEMA) because the
    # old-DB path above may still have been adding notified_at.
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_tasks_parent_notified "
        "ON tasks(status, parent_session_id, notified_at)"
    )
    # Task-to-task link index (column added above for old DBs).
    conn.execute("CREATE INDEX IF NOT EXISTS idx_tasks_parent_task ON tasks(parent_task_id)")
    conn.commit()
    return conn


# ---------- base path + git helpers ----------
import re as _re
import subprocess as _sp

FOLDER_RE = _re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def projects_root() -> Path:
    root = os.getenv("KANBAN_PROJECTS_ROOT", "").strip()
    if not root:
        fail("KANBAN_PROJECTS_ROOT not set — add it to .env (e.g. KANBAN_PROJECTS_ROOT=C:\\Users\\Robert\\work)")
    p = Path(root)
    if not p.is_absolute() or not p.exists():
        fail(f"KANBAN_PROJECTS_ROOT does not exist: {root}")
    return p


def validate_folder(name: str) -> str:
    name = (name or "").strip()
    if not FOLDER_RE.match(name or ""):
        fail(f"Invalid folder '{name}'. Use letters/digits/._- only, max 64 chars, no .. or slashes.")
    if name.lower() in ("con", "prn", "aux", "nul"):
        fail(f"Invalid folder '{name}' (reserved name).")
    return name


def folder_to_path(folder: str) -> str:
    return str(projects_root() / validate_folder(folder))


def git_info_for(folder: str) -> dict:
    d = Path(folder_to_path(folder))
    def run(*a):
        try:
            r = _sp.run(list(a), cwd=str(d), capture_output=True, text=True, timeout=10)
            return r.stdout.strip() if r.returncode == 0 else ""
        except Exception:
            return ""
    is_repo = (d / ".git").exists() or bool(run("git", "rev-parse", "--git-dir"))
    if not is_repo:
        return {"folder": folder, "isRepo": False}
    branch = run("git", "branch", "--show-current")
    dirty = bool(run("git", "status", "--porcelain"))
    remote = run("git", "remote", "get-url", "origin")
    raw = run("git", "branch", "--format=%(refname:short)")
    branches = [b.strip() for b in raw.splitlines() if b.strip()]
    return {"folder": folder, "isRepo": True, "branch": branch or None,
            "dirty": dirty, "remote": remote or None, "branches": branches}


def check_branch_pinned(project_row, folder: str) -> dict:
    """Warn if checkout branch != pinned git_branch. Returns {ok, current, pinned}."""
    pinned = (project_row["git_branch"] or "main") if "git_branch" in project_row.keys() else "main"
    info = git_info_for(folder)
    if not info.get("isRepo"):
        return {"ok": True, "current": None, "pinned": pinned, "skipped": "not a repo"}
    cur = info.get("branch")
    return {"ok": (cur == pinned), "current": cur, "pinned": pinned}


# ---------- worktree isolation ----------
#
# Every task can run in its own git worktree. The agent session then works in
# that folder, so two parallel tasks never share files, git index or build
# output. The work is merged back into the pinned branch when the task is done.

def worktrees_root() -> Path:
    """Root folder that holds all worktrees. Default: <PROJECTS_ROOT>/.kanban-worktrees."""
    root = os.getenv("KANBAN_WORKTREES_ROOT", "").strip()
    path = Path(root) if root else projects_root() / ".kanban-worktrees"
    try:
        path.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass
    return path


def git_run(repo, *args, timeout=120):
    """Run git in `repo`. Returns (code, stdout, stderr). Never raises."""
    try:
        r = _sp.run(["git", "-C", str(repo), *[str(a) for a in args]],
                    capture_output=True, text=True, timeout=timeout)
        return r.returncode, (r.stdout or "").strip(), (r.stderr or "").strip()
    except Exception as exc:  # git missing, timeout, ...
        return 1, "", str(exc)


def git_toplevel(repo) -> str:
    code, out, _ = git_run(repo, "rev-parse", "--show-toplevel")
    return out if code == 0 else ""


def not_a_git_repo_error(repo) -> str:
    """Clear error with the fix steps for a project folder without git."""
    return (f"Project is not a git repository: {repo}. "
            f"Fix: run 'git init' and 'git commit' in the folder, or let the board "
            f"create a local repository for it.")


def ensure_git_repo(repo, branch="main"):
    """Make sure the project folder is a git repository with one commit.

    A worktree needs a commit. So a fresh local repository gets the project
    files in its first commit. Heavy folders (node_modules, dist, ...) stay
    out. The exclude list lives inside .git, so the project files are not
    changed.

    Returns {"ok", "created", "note"}. Never raises.
    """
    if git_toplevel(repo):
        return {"ok": True, "created": False, "note": "existing repository"}
    if not Path(repo).exists():
        return {"ok": False, "created": False, "note": "project path does not exist"}
    code, out, err = git_run(repo, "init")
    if code != 0:
        return {"ok": False, "created": False,
                "note": f"git init failed: {(err or out).strip()[:200]}"}
    # The project branch is the first branch of the new repository.
    git_run(repo, "symbolic-ref", "HEAD", f"refs/heads/{branch or 'main'}")
    # Identity for the first commit. Local only, the global config is not touched.
    git_run(repo, "config", "user.name", "Kanban Board")
    git_run(repo, "config", "user.email", "kanban@local")
    # Heavy folders never belong in the first commit. The exclude file lives
    # inside .git, so no file of the project is changed.
    exclude = Path(repo) / ".git" / "info" / "exclude"
    try:
        exclude.parent.mkdir(parents=True, exist_ok=True)
        with open(exclude, "a", encoding="utf-8") as fh:
            fh.write("\n# added by the kanban board\n"
                     "node_modules/\n.venv/\nvenv/\ndist/\nbuild/\n.next/\n"
                     "target/\n__pycache__/\n")
    except OSError:
        pass
    git_run(repo, "add", "-A")
    code, out, err = git_run(repo, "commit", "-m", "chore: initial commit")
    if code != 0:
        # An empty folder has nothing to commit. An empty commit is enough.
        code2, out2, err2 = git_run(repo, "commit", "--allow-empty", "-m", "chore: initial commit")
        if code2 != 0:
            # The repository is not usable. Remove it, so the folder stays as it was.
            try:
                shutil.rmtree(Path(repo) / ".git", ignore_errors=True)
            except OSError:
                pass
            return {"ok": False, "created": False,
                    "note": f"initial commit failed: {(err2 or err or out2 or out).strip()[:200]}"}
    return {"ok": True, "created": True,
            "note": "created a local git repository (no remote)"}


def git_remote_name(repo, preferred="origin") -> str:
    """The remote of the repository. Empty when there is none."""
    code, out, _ = git_run(repo, "remote")
    if code != 0:
        return ""
    names = [line.strip() for line in out.splitlines() if line.strip()]
    if preferred in names:
        return preferred
    return names[0] if names else ""


def pull_base_branch(repo, branch) -> str:
    """Bring the base branch up to date before a worktree is cut.

    Best effort: the worktree is cut from the local branch. A failed pull
    (no remote, dirty tree, no network) must not stop the work, so the note
    tells the user what happened.
    """
    remote = git_remote_name(repo)
    if not remote:
        return "no remote"
    code, out, err = git_run(repo, "pull", "--ff-only", remote, branch, timeout=180)
    if code != 0:
        return f"pull failed: {(err or out).strip()[:200]}"
    return "up to date"


def push_branch(repo, branch) -> tuple:
    """Push a branch to the remote. Returns (pushed, note)."""
    remote = git_remote_name(repo)
    if not remote:
        return False, "no remote"
    code, out, err = git_run(repo, "push", remote, branch, timeout=300)
    if code != 0:
        return False, f"push failed: {(err or out).strip()[:300]}"
    return True, f"pushed {branch} to {remote}"


def worktree_branch_for(task_id: str) -> str:
    """Branch name of a task worktree: kanban/task-<short id>."""
    safe = "".join(ch for ch in str(task_id) if ch.isalnum() or ch in "-_")[:8] or "task"
    return f"kanban/task-{safe}"


def worktree_path_for(project_row, task_id: str) -> Path:
    """Folder of the task worktree: <WORKTREES_ROOT>/<project folder>/<task id>."""
    folder = (project_row["folder"] or "").strip() or "project"
    safe_folder = "".join(ch for ch in folder if ch.isalnum() or ch in "-_.") or "project"
    safe_task = "".join(ch for ch in str(task_id) if ch.isalnum() or ch in "-_")[:64] or "task"
    return worktrees_root() / safe_folder / safe_task


def same_path(a, b) -> bool:
    """Compare two paths. Git prints worktree paths with forward slashes."""
    try:
        return os.path.normcase(os.path.realpath(str(a))) == os.path.normcase(os.path.realpath(str(b)))
    except Exception:
        return str(a) == str(b)


def registered_worktrees(repo) -> list:
    """Paths of the worktrees that git knows for this repo."""
    code, out, _ = git_run(repo, "worktree", "list", "--porcelain")
    if code != 0:
        return []
    paths = []
    for line in out.splitlines():
        if line.startswith("worktree "):
            paths.append(line[len("worktree "):].strip())
    return paths


def project_row_for_task(conn, task_id: str):
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if not row:
        fail(f"Task not found: {task_id}")
    project = conn.execute("SELECT * FROM projects WHERE id = ?", (row["project_id"],)).fetchone()
    if not project:
        fail(f"Project not found: {row['project_id']}")
    return row, project


_CLEAR = object()


def set_worktree_fields(conn, task_id, path=None, branch=None, state=None, note=None):
    sets, params = [], []
    for col, val in (("worktree_path", path), ("worktree_branch", branch),
                     ("worktree_state", state), ("worktree_note", note)):
        if val is _CLEAR:
            val = None
        elif val is None:
            continue
        sets.append(f"{col} = ?")
        params.append(val)
    if not sets:
        return
    sets.append("updated_at = ?")
    params.append(now_iso())
    params.append(task_id)
    conn.execute(f"UPDATE tasks SET {', '.join(sets)} WHERE id = ?", params)


def copy_setup_files(repo, path):
    """Copy the local setup files into a fresh worktree.

    A new worktree has no .env and no build output. The .env is small and
    needed by the steps, so it is copied. node_modules and other build output
    are not copied: the verification step installs or links them.

    The agent definitions are copied too. They are the team of the project, and
    a worktree without them has no agents at all ("Agent not found"). They are
    kept out of the commits of the agent: tracked files get the skip-worktree
    flag, new files go into the exclude file of the worktree.
    """
    copied = []
    for name in (".env", ".env.local"):
        src = Path(repo) / name
        dst = Path(path) / name
        try:
            if src.exists() and not dst.exists():
                shutil.copyfile(src, dst)
                copied.append(name)
        except Exception:
            pass
    copied += copy_agent_definitions(repo, path)
    return copied


def agent_team_dir():
    """The one place where the agent team lives.

    The board owns the team. Every worktree gets these files, and the team is
    also installed as a global OpenCode agent set, so every session in every
    folder uses the same, current definitions. A project repo does not need its
    own copy.
    """
    custom = os.getenv("KANBAN_AGENT_TEAM_DIR", "").strip()
    if custom:
        return Path(custom)
    return REPO / ".opencode" / "agents"


def global_agents_dir():
    """The global OpenCode agent folder: every location sees these agents."""
    return Path.home() / ".config" / "opencode" / "agents"


def cmd_team_install(args):
    """Install the agent team as global OpenCode agents.

    The board owns the team. Installed globally, every session in every folder
    (project folders and worktrees) uses the current definitions.
    """
    src = agent_team_dir()
    if not src.is_dir():
        fail(f"No agent team found: {src}")
    dst = global_agents_dir()
    dst.mkdir(parents=True, exist_ok=True)
    installed, skipped = [], []
    for md in sorted(src.glob("*.md")):
        target = dst / md.name
        data = md.read_bytes()
        if target.exists() and target.read_bytes() == data:
            skipped.append(md.name)
            continue
        target.write_bytes(data)
        installed.append(md.name)
    print(json.dumps({"ok": True, "source": str(src), "target": str(dst),
                      "installed": installed, "unchanged": skipped}, indent=2))


def copy_agent_definitions(repo, path):
    """Copy .opencode/agents into the worktree and keep them out of commits.

    The agent team is environment, not task work. The worktree gets the
    current files, so a new agent works there at once. The files stay out of
    the commit of the agent:
    - tracked files get the skip-worktree flag,
    - new files are covered by a per-worktree exclude file.

    The source is the board's team folder (the board owns the team), not the
    project repo. A project may still hold its own agents; those are used only
    when the board has no file with that name.
    """
    sources = [agent_team_dir(), Path(repo) / ".opencode" / "agents"]
    src_dir = next((s for s in sources if s.is_dir()), None)
    if src_dir is None:
        return []
    dst_dir = Path(path) / ".opencode" / "agents"
    copied = []
    try:
        dst_dir.mkdir(parents=True, exist_ok=True)
        for md in sorted(src_dir.glob("*.md")):
            shutil.copyfile(md, dst_dir / md.name)
            copied.append(f".opencode/agents/{md.name}")
    except Exception:
        return copied
    if not copied:
        return copied
    # Tracked files: git must not stage the copy.
    for rel in copied:
        code, _, _ = git_run(path, "ls-files", "--error-unmatch", rel)
        if code == 0:
            git_run(path, "update-index", "--skip-worktree", rel)
    # New files: a per-worktree exclude file. The shared exclude file would
    # also hide the files in the main checkout, where they must stay
    # committable.
    try:
        code, _, _ = git_run(path, "rev-parse", "--git-common-dir")
        git_run(path, "config", "extensions.worktreeConfig", "true")
        exclude_file = Path(path).parent.parent / f".exclude-{Path(path).name}"
        exclude_file.write_text(
            "# Added by the kanban board: the agent team is not task work.\n"
            ".opencode/agents/\n",
            encoding="utf-8",
        )
        git_run(path, "config", "--worktree", "core.excludesFile", str(exclude_file))
    except Exception:
        pass
    return copied


def cmd_worktree_create(args):
    """Create a git worktree for one task. Prints {ok, path, branch, base, reused}."""
    conn = get_conn(args.db)
    task, project = project_row_for_task(conn, args.task_id)
    # A task of a feature uses the feature worktree. It never gets one of its own.
    feature_id = (task["feature_id"] if "feature_id" in task.keys() else "") or ""
    if feature_id:
        feature = conn.execute("SELECT * FROM features WHERE id = ?", (feature_id,)).fetchone()
        if not feature:
            fail(f"Feature not found: {feature_id}")
        path = (feature["worktree_path"] if "worktree_path" in feature.keys() else "") or ""
        branch = (feature["worktree_branch"] if "worktree_branch" in feature.keys() else "") or ""
        print(json.dumps({"ok": True, "path": path, "branch": branch, "base": None,
                          "reused": True, "featureId": feature_id}, indent=2))
        conn.close()
        return
    repo = (project["path"] or "").strip()
    if not repo or not Path(repo).exists():
        fail(f"Project path does not exist: {repo or '(empty)'}")
    top = git_toplevel(repo)
    repo_note = ""
    if not top:
        # No repository yet: the board creates a local one, so the task gets a
        # worktree like in every other project.
        made = ensure_git_repo(repo, project["git_branch"] or "main")
        if not made["ok"]:
            fail(not_a_git_repo_error(repo) + f" ({made['note']})")
        repo_note = made["note"]
        top = git_toplevel(repo)
        if not top:
            fail(not_a_git_repo_error(repo))

    path = worktree_path_for(project, task["id"])
    branch = worktree_branch_for(task["id"])

    # Reuse: the worktree folder already exists and is registered.
    known = registered_worktrees(top)
    if any(same_path(p, path) for p in known):
        set_worktree_fields(conn, task["id"], path=str(path), branch=branch,
                            state=task["worktree_state"] if "worktree_state" in task.keys() else "active")
        conn.commit()
        print(json.dumps({"ok": True, "path": str(path), "branch": branch,
                          "base": None, "reused": True}, indent=2))
        conn.close()
        return

    # Base branch: the pinned branch, else HEAD when the pinned one is unknown.
    base = (args.base or "").strip() or (project["git_branch"] or "main")
    pull_note = "not needed"
    code, _, _ = git_run(top, "rev-parse", "--verify", base)
    if code != 0:
        base = "HEAD"
    else:
        # The base must be current. A worktree that is cut from an old base
        # makes every later merge a conflict. The pull is best effort: a
        # failed pull must not stop the work.
        pull_note = pull_base_branch(top, base)

    path.parent.mkdir(parents=True, exist_ok=True)
    # Per-worktree config (used for the exclude file of the agent team).
    git_run(top, "config", "extensions.worktreeConfig", "true")
    # A leftover folder from a failed run must not block the new worktree.
    # Only a folder that git made (it has a .git marker) is removed. Any other
    # folder stops the run, so no data is ever deleted.
    if path.exists():
        if (path / ".git").exists():
            safe_rmtree(path)
        else:
            fail(f"Worktree folder exists and is not a git worktree: {path}")
    # A leftover branch from a failed run must not block the new worktree.
    code, _, _ = git_run(top, "rev-parse", "--verify", branch)
    if code == 0:
        git_run(top, "branch", "-D", branch)

    code, out, err = git_run(top, "worktree", "add", "-b", branch, str(path), base)
    if code != 0:
        fail(f"git worktree add failed: {(err or out).strip()[:400]}")
    copied = copy_setup_files(repo, path)

    set_worktree_fields(conn, task["id"], path=str(path), branch=branch, state="active", note=_CLEAR)
    log_event(conn, task["id"], "worktree", "worktree.created",
              {"path": str(path), "branch": branch, "base": base, "copied": copied,
               "pull": pull_note})
    conn.commit()
    print(json.dumps({"ok": True, "path": str(path), "branch": branch,
                      "base": base, "reused": False, "copied": copied,
                      "pull": pull_note, "repoNote": repo_note}, indent=2))
    conn.close()


def _merge_lock_path(repo: str) -> Path:
    key = "".join(ch for ch in str(repo).lower() if ch.isalnum())[-24:] or "repo"
    return worktrees_root() / f".merge-{key}.lock"


class _MergeLock:
    """Simple file lock so two merges never touch one repo at the same time."""

    def __init__(self, repo):
        self.path = _merge_lock_path(repo)
        self.acquired = False

    def __enter__(self):
        for _ in range(10):
            try:
                fd = os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(fd, str(os.getpid()).encode())
                os.close(fd)
                self.acquired = True
                return self
            except FileExistsError:
                # A stale lock (dead process) must not block the board forever.
                try:
                    if time.time() - self.path.stat().st_mtime > 300:
                        self.path.unlink(missing_ok=True)
                        continue
                except Exception:
                    pass
                time.sleep(0.5)
        return self

    def __exit__(self, *exc):
        if self.acquired:
            try:
                self.path.unlink(missing_ok=True)
            except Exception:
                pass
        return False


def is_ancestor(repo, ancestor, descendant) -> bool:
    """True when `ancestor` is contained in `descendant`.

    This is the "has main moved?" check: if main is an ancestor of the feature
    branch, the feature contains the current main and the merge is safe. If not,
    main moved after the last sync and the feature must be rebased first.
    """
    code, _, _ = git_run(repo, "merge-base", "--is-ancestor", ancestor, descendant)
    return code == 0


def rebase_feature(repo, worktree_path, branch, target):
    """Move the feature branch onto the current target branch.

    Returns (ok, note). A conflict aborts the rebase and leaves the branch as
    it was, so the agent can resolve it in the worktree and retry.
    """
    if not worktree_path or not Path(worktree_path).exists():
        return False, "the worktree folder is gone"
    code, out, err = git_run(worktree_path, "rebase", target)
    if code != 0:
        git_run(worktree_path, "rebase", "--abort")
        files = []
        code2, out2, _ = git_run(worktree_path, "diff", "--name-only", "--diff-filter=U")
        files = [f for f in out2.splitlines() if f.strip()]
        note = (err or out).strip()[:400]
        if files:
            note = f"{note} Conflicting files: {', '.join(files[:10])}"
        return False, note
    return True, f"rebased {branch} onto {target}"


def merge_worktree(task, project, target=None, cleanup=False):
    """Merge the task branch into the target branch of the main repo.

    Returns a dict: {ok, merged, conflict, files, error, branch, target}.
    Never raises: the caller decides what to do with the result.
    """
    repo = (project["path"] or "").strip()
    top = git_toplevel(repo)
    if not top:
        return {"ok": False, "merged": False, "error": not_a_git_repo_error(repo)}
    branch = (task["worktree_branch"] if "worktree_branch" in task.keys() else "") or ""
    if not branch:
        return {"ok": False, "merged": False, "error": "Task has no worktree branch"}
    target = (target or "").strip() or (project["git_branch"] or "main")

    code, out, _ = git_run(top, "rev-parse", "--verify", target)
    if code != 0:
        return {"ok": False, "merged": False, "error": f"Target branch does not exist: {target}"}

    code, current, _ = git_run(top, "rev-parse", "--abbrev-ref", "HEAD")
    if code == 0 and current and current != target:
        return {"ok": False, "merged": False,
                "error": f"Main repo is on branch '{current}', not '{target}'. "
                         f"Check out '{target}' first, then merge again."}

    with _MergeLock(top) as merge_lock:
        # The lock is the guard against two merges in one repository. If it
        # is not held, the merge must not run: two merges would touch the
        # same index and the same project branch. The caller retries later.
        if not merge_lock.acquired:
            return {"ok": False, "merged": False, "conflict": False,
                    "error": "Another merge is running in this repository. Try again later.",
                    "branch": branch, "target": target}
        # 1. The commit gate: only committed work is merged. Uncommitted work
        #    would stay in the worktree and the card would say "done" while
        #    the result is incomplete.
        path = (task["worktree_path"] if "worktree_path" in task.keys() else "") or ""
        if path and Path(path).exists():
            code, dirty, _ = git_run(path, "status", "--porcelain")
            dirty_files = [f for f in dirty.splitlines() if f.strip()]
            if dirty_files:
                return {"ok": False, "merged": False, "conflict": False,
                        "files": dirty_files,
                        "error": ("the work is not committed yet: "
                                  f"{len(dirty_files)} file(s) changed in the worktree. "
                                  "The agent must commit before the merge."),
                        "branch": branch, "target": target}

        # 2. The base guard: has the target branch moved since the last sync?
        #    If yes, the feature is rebased onto it first. The merge then lands
        #    a branch that contains the current main.
        rebased = None
        if not is_ancestor(top, target, branch):
            ok, note = rebase_feature(top, path, branch, target)
            if not ok:
                return {"ok": False, "merged": False, "conflict": True,
                        "files": [],
                        "error": (f"the branch is behind {target} and the rebase failed: {note}"),
                        "branch": branch, "target": target, "needsRebase": True}
            rebased = note

        # The main checkout may hold uncommitted work. Git refuses the merge
        # when the merge would touch those files. Report the dirty state, so
        # the reason is clear on the board.
        _, dirty, _ = git_run(top, "status", "--porcelain")
        dirty_files = [f for f in dirty.splitlines() if f.strip()]
        code, out, err = git_run(top, "merge", "--no-edit", branch)
        if code != 0:
            # A failed merge leaves the repo mid-merge. Undo it and report.
            git_run(top, "merge", "--abort")
            _, files, _ = git_run(top, "diff", "--name-only", "--diff-filter=U")
            reason = (err or out).strip()[:500]
            if dirty_files:
                reason = (f"{reason} The main checkout has uncommitted changes: "
                          f"{', '.join(dirty_files[:8])}")
            return {"ok": False, "merged": False, "conflict": True,
                    "files": [f for f in files.splitlines() if f.strip()],
                    "error": reason,
                    "branch": branch, "target": target}
        if cleanup:
            remove_worktree(top, path, force=True)
    # The board does the git work (option A): after the local merge the branch
    # goes to the remote. A failed push does not undo the merge. The work is
    # merged locally; the note says that the push must be repeated.
    pushed, push_note = push_branch(top, target)
    return {"ok": True, "merged": True, "conflict": False, "files": [],
            "error": None, "branch": branch, "target": target, "rebased": rebased,
            "pushed": pushed, "pushNote": push_note}


def cmd_worktree_merge(args):
    """Merge the task worktree branch into the pinned branch of the project."""
    conn = get_conn(args.db)
    task, project = project_row_for_task(conn, args.task_id)
    result = merge_worktree(task, project, target=args.target, cleanup=args.cleanup)
    if result.get("merged"):
        note = f"Merged {result.get('branch')} into {result.get('target')}"
        if result.get("pushed"):
            note += f" and {result.get('pushNote')}"
        elif result.get("pushNote"):
            note += f" (not pushed: {result.get('pushNote')})"
        set_worktree_fields(conn, args.task_id, state="merged", note=note)
        log_event(conn, args.task_id, "worktree", "worktree.merged",
                  {"branch": result.get("branch"), "target": result.get("target"),
                   "pushed": result.get("pushed"), "pushNote": result.get("pushNote")})
    elif result.get("conflict"):
        set_worktree_fields(conn, args.task_id, state="conflict",
                            note=(result.get("error") or "merge conflict")[:500])
        log_event(conn, args.task_id, "worktree", "worktree.conflict",
                  {"files": result.get("files"), "error": result.get("error")})
    else:
        set_worktree_fields(conn, args.task_id, state="pending",
                            note=(result.get("error") or "merge failed")[:500])
        log_event(conn, args.task_id, "worktree", "worktree.merge_failed",
                  {"error": result.get("error")})
    conn.commit()
    print(json.dumps(result, indent=2))
    conn.close()


def cmd_worktree_sync(args):
    """Move the worktree branch onto the current project branch (rebase).

    The base of a worktree goes stale as soon as another task or feature is
    merged. The orchestrator calls this before the verification step, so the
    checks run against the current code.
    """
    conn = get_conn(args.db)
    task, project = project_row_for_task(conn, args.task_id)
    repo = (project["path"] or "").strip()
    top = git_toplevel(repo)
    branch = (task["worktree_branch"] if "worktree_branch" in task.keys() else "") or ""
    path = (task["worktree_path"] if "worktree_path" in task.keys() else "") or ""
    target = (args.target or "").strip() or (project["git_branch"] or "main")
    if not top:
        fail(not_a_git_repo_error(repo))
    if not branch:
        fail("The task has no worktree branch")
    if is_ancestor(top, target, branch):
        print(json.dumps({"ok": True, "synced": False, "branch": branch, "target": target,
                          "note": "The branch already contains the target branch."}, indent=2))
        conn.close()
        return
    ok, note = rebase_feature(top, path, branch, target)
    if ok:
        set_worktree_fields(conn, args.task_id, state="active", note=note)
        log_event(conn, args.task_id, "worktree", "worktree.synced",
                  {"branch": branch, "target": target})
    conn.commit()
    print(json.dumps({"ok": ok, "synced": ok, "branch": branch, "target": target,
                      "note": note}, indent=2))
    conn.close()


def cmd_worktree_remove(args):
    """Remove the worktree folder of a task. Keeps the branch unless asked."""
    conn = get_conn(args.db)
    task, project = project_row_for_task(conn, args.task_id)
    repo = (project["path"] or "").strip()
    top = git_toplevel(repo)
    path = (task["worktree_path"] if "worktree_path" in task.keys() else "") or ""
    branch = (task["worktree_branch"] if "worktree_branch" in task.keys() else "") or ""
    removed = False
    error = None
    # Safety: only a folder that git knows as a worktree of this repo may be
    # removed. An empty or unknown path must never reach git: `worktree remove`
    # with the wrong argument can delete the checkout of the main repository.
    known = [p for p in registered_worktrees(top) if same_path(p, path)] if (top and path) else []
    if top and path and known and not same_path(known[0], top):
        removed, error = remove_worktree(top, path, force=args.force)
    elif path and not known:
        error = "The worktree folder is not registered in this repository. Nothing was removed."
    elif not path:
        error = "The task has no worktree folder. Nothing was removed."
    if args.delete_branch and top and branch:
        git_run(top, "branch", "-D", branch)
    set_worktree_fields(conn, args.task_id, state="removed", note=error)
    log_event(conn, args.task_id, "worktree", "worktree.removed",
              {"path": path, "branch": branch, "removed": removed, "error": error})
    conn.commit()
    print(json.dumps({"ok": error is None, "removed": removed, "path": path,
                      "branch": branch, "error": error}, indent=2))
    conn.close()


def cmd_worktree_list(args):
    """List the worktrees of one project (or of every project)."""
    conn = get_conn(args.db)
    sql = "SELECT * FROM tasks WHERE worktree_path IS NOT NULL AND worktree_path != ''"
    params = []
    if args.project:
        sql += " AND project_id = ?"
        params.append(args.project)
    sql += " ORDER BY updated_at DESC"
    rows = conn.execute(sql, params).fetchall()
    out = []
    for r in rows:
        out.append({
            "taskId": r["id"],
            "title": r["title"],
            "projectId": r["project_id"],
            "status": r["status"],
            "path": r["worktree_path"],
            "branch": r["worktree_branch"],
            "state": r["worktree_state"],
            "note": r["worktree_note"],
            "exists": Path(r["worktree_path"]).exists() if r["worktree_path"] else False,
        })
    print(json.dumps(out, indent=2))
    conn.close()


def safe_rmtree(path):
    """Remove a folder without following links out of it.

    On Windows a folder junction looks like a normal folder. `shutil.rmtree`
    walks into it and deletes the files of the TARGET — in one test the
    node_modules of the main project was deleted with the worktree folder.
    A junction or a symlink is therefore removed as a link, and the walk
    never enters it.
    """
    import shutil
    import stat

    def onerror(func, p, exc):
        try:
            os.chmod(p, stat.S_IWRITE)
            func(p)
        except Exception:
            pass

    def is_link(entry):
        try:
            if entry.is_symlink():
                return True
        except OSError:
            pass
        # Python 3.12 knows a junction.
        isjunction = getattr(os.path, "isjunction", None)
        if isjunction:
            try:
                if isjunction(entry.path):
                    return True
            except OSError:
                pass
        return False

    for root, dirs, _files in os.walk(str(path), topdown=True, followlinks=False):
        for name in list(dirs):
            full = os.path.join(root, name)
            try:
                entry = next((e for e in os.scandir(root) if e.name == name), None)
            except OSError:
                entry = None
            if entry is not None and is_link(entry):
                # Remove the link itself. Never the target.
                dirs.remove(name)
                try:
                    if entry.is_dir(follow_symlinks=False):
                        os.rmdir(full)
                    else:
                        os.unlink(full)
                except OSError:
                    pass
    shutil.rmtree(str(path), onerror=onerror)


def remove_worktree(top, path, force=False):
    """Remove a worktree folder. Safety first.

    Only a folder that git knows as a worktree of this repo may be removed, and
    never the main checkout. `git worktree remove` with a wrong argument can
    delete the files of the main repository.

    Returns (removed, error).
    """
    if not top or not path:
        return False, "no worktree folder"
    known = [p for p in registered_worktrees(top) if same_path(p, path)]
    if not known:
        return False, "The worktree folder is not registered in this repository. Nothing was removed."
    if same_path(known[0], top):
        return False, "The main checkout cannot be removed as a worktree."
    argv = ["worktree", "remove"]
    if force:
        argv.append("--force")
    argv.append(path)
    code, out, err = git_run(top, *argv)
    git_run(top, "worktree", "prune")
    if code != 0:
        return False, (err or out).strip()[:400]
    return True, None


def cleanup_worktree(repo, path, branch):
    """Remove the worktree folder after a successful merge.

    Only a clean worktree is removed. Uncommitted work is kept, so no result
    is ever lost. Returns (removed, note).
    """
    top = git_toplevel(repo)
    if not top or not path:
        return False, "no worktree folder"
    code, out, _ = git_run(path, "status", "--porcelain")
    if code != 0:
        return False, "cannot read the worktree state"
    if out.strip():
        return False, "worktree kept: it still has uncommitted changes"
    removed, error = remove_worktree(top, path, force=True)
    if not removed:
        return False, f"worktree kept: {error or 'the folder could not be removed'}"
    if branch:
        git_run(top, "branch", "-D", branch)
    return True, "worktree removed"


# ---------- features: one worktree for a group of tasks ----------

def feature_branch_for(feature_id: str) -> str:
    """Branch of a feature worktree: kanban/feature-<short id>."""
    safe = "".join(ch for ch in str(feature_id) if ch.isalnum() or ch in "-_")[:8] or "feature"
    return f"kanban/feature-{safe}"


def feature_path_for(project_row, feature_id: str) -> Path:
    """Folder of the feature worktree: <WORKTREES_ROOT>/<project>/feature-<id>."""
    folder = (project_row["folder"] or "").strip() or "project"
    safe_folder = "".join(ch for ch in folder if ch.isalnum() or ch in "-_.") or "project"
    safe_id = "".join(ch for ch in str(feature_id) if ch.isalnum() or ch in "-_")[:64] or "feature"
    return worktrees_root() / safe_folder / f"feature-{safe_id}"


def row_to_feature(r, tasks=None) -> dict:
    keys = r.keys()
    return {
        "id": r["id"],
        "projectId": r["project_id"],
        "title": r["title"],
        "description": r["description"] or "",
        "status": r["status"],
        "worktreePath": r["worktree_path"] if "worktree_path" in keys else None,
        "worktreeBranch": r["worktree_branch"] if "worktree_branch" in keys else None,
        "baseBranch": r["base_branch"] if "base_branch" in keys else None,
        "ownerSessionId": r["owner_session_id"] if "owner_session_id" in keys else None,
        "mergeNote": r["merge_note"] if "merge_note" in keys else None,
        "taskIds": tasks or [],
        "createdAt": r["created_at"],
        "updatedAt": r["updated_at"],
    }


def feature_task_ids(conn, feature_id) -> list:
    rows = conn.execute("SELECT id FROM tasks WHERE feature_id = ? ORDER BY created_at", (feature_id,)).fetchall()
    return [r["id"] for r in rows]


def cmd_feature_create(args):
    """Create a feature: one git worktree and one branch for all its tasks."""
    conn = get_conn(args.db)
    project = conn.execute("SELECT * FROM projects WHERE id = ?", (args.project,)).fetchone()
    if not project:
        fail(f"Project not found: {args.project}")
    repo = (project["path"] or "").strip()
    if not repo or not Path(repo).exists():
        fail(f"Project path does not exist: {repo or '(empty)'}")
    top = git_toplevel(repo)
    repo_note = ""
    if not top:
        # No repository yet: the board creates a local one, so the feature
        # gets a worktree and a branch.
        made = ensure_git_repo(repo, project["git_branch"] or "main")
        if not made["ok"]:
            fail(not_a_git_repo_error(repo) + f" ({made['note']})")
        repo_note = made["note"]
        top = git_toplevel(repo)
        if not top:
            fail(not_a_git_repo_error(repo))

    fid = args.id or new_uuid()
    if conn.execute("SELECT id FROM features WHERE id = ?", (fid,)).fetchone():
        fail(f"Feature already exists: {fid}")

    branch = feature_branch_for(fid)
    path = feature_path_for(project, fid)
    base = (args.base or "").strip() or (project["git_branch"] or "main")
    pull_note = "not needed"
    code, _, _ = git_run(top, "rev-parse", "--verify", base)
    if code != 0:
        base = "HEAD"
    else:
        # The base must be current. A feature that starts from an old base
        # makes every later merge a conflict. Best effort: a failed pull does
        # not stop the work.
        pull_note = pull_base_branch(top, base)

    path.parent.mkdir(parents=True, exist_ok=True)
    # Per-worktree config (used for the exclude file of the agent team).
    git_run(top, "config", "extensions.worktreeConfig", "true")
    if path.exists():
        if (path / ".git").exists():
            safe_rmtree(path)
        else:
            fail(f"Worktree folder exists and is not a git worktree: {path}")
    code, _, _ = git_run(top, "rev-parse", "--verify", branch)
    if code == 0:
        git_run(top, "branch", "-D", branch)
    code, out, err = git_run(top, "worktree", "add", "-b", branch, str(path), base)
    if code != 0:
        fail(f"git worktree add failed: {(err or out).strip()[:400]}")
    copied = copy_setup_files(repo, path)

    ts = now_iso()
    conn.execute(
        """INSERT INTO features (id, project_id, title, description, status,
                                worktree_path, worktree_branch, base_branch,
                                owner_session_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)""",
        (fid, args.project, args.title, args.description or "", str(path), branch, base,
         getattr(args, "owner_session_id", None), ts, ts),
    )
    log_event(conn, None, args.actor, "feature.created",
              {"id": fid, "projectId": args.project, "title": args.title, "branch": branch,
               "copied": copied, "pull": pull_note})
    conn.commit()
    row = conn.execute("SELECT * FROM features WHERE id = ?", (fid,)).fetchone()
    print(json.dumps({**row_to_feature(row), "copied": copied, "pull": pull_note,
                      "repoNote": repo_note}, indent=2))
    conn.close()


def cmd_feature_list(args):
    """List the features of one project (or of every project)."""
    conn = get_conn(args.db)
    sql = "SELECT * FROM features"
    params = []
    if args.project:
        sql += " WHERE project_id = ?"
        params.append(args.project)
    sql += " ORDER BY updated_at DESC"
    rows = conn.execute(sql, params).fetchall()
    out = [row_to_feature(r, feature_task_ids(conn, r["id"])) for r in rows]
    print(json.dumps(out, indent=2))
    conn.close()


def cmd_feature_show(args):
    """Show one feature with its tasks."""
    conn = get_conn(args.db)
    row = conn.execute("SELECT * FROM features WHERE id = ?", (args.feature_id,)).fetchone()
    if not row:
        fail(f"Feature not found: {args.feature_id}")
    tasks = conn.execute(
        "SELECT * FROM tasks WHERE feature_id = ? ORDER BY created_at", (args.feature_id,)
    ).fetchall()
    print(json.dumps({**row_to_feature(row, [t["id"] for t in tasks]),
                      "tasks": [row_to_task(t) for t in tasks]}, indent=2))
    conn.close()


def merge_feature(conn, feature_row, target=None):
    """Merge the feature branch into the project branch.

    Returns {ok, merged, conflict, files, error, branch, target}.
    """
    project = conn.execute("SELECT * FROM projects WHERE id = ?", (feature_row["project_id"],)).fetchone()
    if not project:
        return {"ok": False, "merged": False, "error": "Project not found"}
    branch = (feature_row["worktree_branch"] if "worktree_branch" in feature_row.keys() else "") or ""
    if not branch:
        return {"ok": False, "merged": False, "error": "Feature has no worktree branch"}
    task_like = {
        "worktree_branch": branch,
        "worktree_path": (feature_row["worktree_path"] if "worktree_path" in feature_row.keys() else "") or "",
    }
    result = merge_worktree(task_like, project, target=target)
    if result.get("merged"):
        note = f"Merged {branch} into {result.get('target')}"
        if result.get("pushed"):
            note += f" and {result.get('pushNote')}"
        elif result.get("pushNote"):
            note += f" (not pushed: {result.get('pushNote')})"
        conn.execute(
            "UPDATE features SET status = 'done', merge_note = ?, updated_at = ? WHERE id = ?",
            (note, now_iso(), feature_row["id"]),
        )
        log_event(conn, None, "feature", "feature.merged",
                  {"id": feature_row["id"], "branch": branch, "target": result.get("target"),
                   "pushed": result.get("pushed"), "pushNote": result.get("pushNote")})
        # The work is in the project branch. The completed steps of the
        # feature move to the archive, so the board shows only the open work.
        archived = archive_done_feature_tasks(conn, feature_row["id"])
        if archived:
            log_event(conn, None, "feature", "feature.archived",
                      {"id": feature_row["id"], "tasks": archived})
    elif result.get("conflict"):
        conn.execute(
            "UPDATE features SET merge_note = ?, updated_at = ? WHERE id = ?",
            ((result.get("error") or "merge conflict")[:500], now_iso(), feature_row["id"]),
        )
        log_event(conn, None, "feature", "feature.conflict",
                  {"id": feature_row["id"], "files": result.get("files")})
    else:
        conn.execute(
            "UPDATE features SET merge_note = ?, updated_at = ? WHERE id = ?",
            ((result.get("error") or "merge failed")[:500], now_iso(), feature_row["id"]),
        )
        log_event(conn, None, "feature", "feature.merge_failed",
                  {"id": feature_row["id"], "error": result.get("error")})
    conn.commit()
    return result


def archive_done_feature_tasks(conn, feature_id) -> list:
    """Move the completed tasks of a feature to the archive.

    A feature that is merged is finished work. Its steps leave the daily
    view, but keep their result and their history. Only the tasks that are
    `done` move. A step that still runs or that is blocked stays visible.
    """
    rows = conn.execute(
        "SELECT id, title FROM tasks WHERE feature_id = ? AND status = 'done'",
        (feature_id,),
    ).fetchall()
    ids = []
    for r in rows:
        conn.execute("UPDATE tasks SET status = 'archived', updated_at = ? WHERE id = ?",
                     (now_iso(), r["id"]))
        log_event(conn, r["id"], "feature", "task.archived",
                  {"featureId": feature_id, "title": r["title"]})
        ids.append(r["id"])
    return ids


def cmd_feature_merge(args):
    """Merge the feature branch into the project branch."""
    conn = get_conn(args.db)
    row = conn.execute("SELECT * FROM features WHERE id = ?", (args.feature_id,)).fetchone()
    if not row:
        fail(f"Feature not found: {args.feature_id}")
    result = merge_feature(conn, row, target=args.target)
    print(json.dumps(result, indent=2))
    conn.close()


def cmd_feature_update(args):
    """Update a feature: its status and its merge note."""
    conn = get_conn(args.db)
    row = conn.execute("SELECT * FROM features WHERE id = ?", (args.feature_id,)).fetchone()
    if not row:
        fail(f"Feature not found: {args.feature_id}")
    sets, params = [], []
    if args.status is not None:
        status = (args.status or "").strip()
        if status not in ("active", "done", "archived"):
            fail(f"Invalid feature status: {status}")
        sets.append("status = ?")
        params.append(status)
    if args.merge_note is not None:
        sets.append("merge_note = ?")
        params.append(args.merge_note[:500])
    if sets:
        sets.append("updated_at = ?")
        params.append(now_iso())
        conn.execute(f"UPDATE features SET {', '.join(sets)} WHERE id = ?",
                     (*params, args.feature_id))
        log_event(conn, None, args.actor, "feature.updated",
                  {"id": args.feature_id, "status": args.status, "mergeNote": args.merge_note})
    conn.commit()
    out = conn.execute("SELECT * FROM features WHERE id = ?", (args.feature_id,)).fetchone()
    print(json.dumps(row_to_feature(out, feature_task_ids(conn, args.feature_id)), indent=2))
    conn.close()


def cmd_feature_delete(args):
    """Delete a feature: remove its worktree and detach its tasks."""
    conn = get_conn(args.db)
    row = conn.execute("SELECT * FROM features WHERE id = ?", (args.feature_id,)).fetchone()
    if not row:
        fail(f"Feature not found: {args.feature_id}")
    # The tasks stay on the board. They lose the feature link and the worktree
    # location, so they fall back to the per-task worktree mode.
    conn.execute(
        """UPDATE tasks SET feature_id = NULL, worktree_path = NULL,
                            worktree_branch = NULL, worktree_state = NULL
            WHERE feature_id = ?""",
        (args.feature_id,),
    )
    # Remove the feature worktree folder and its branch.
    path = (row["worktree_path"] if "worktree_path" in row.keys() else "") or ""
    branch = (row["worktree_branch"] if "worktree_branch" in row.keys() else "") or ""
    project = conn.execute("SELECT * FROM projects WHERE id = ?", (row["project_id"],)).fetchone()
    removed = False
    error = None
    if project and path:
        top = git_toplevel((project["path"] or "").strip())
        if top:
            removed, error = remove_worktree(top, path, force=True)
            if removed and branch:
                git_run(top, "branch", "-D", branch)
    conn.execute("DELETE FROM features WHERE id = ?", (args.feature_id,))
    log_event(conn, None, args.actor, "feature.deleted",
              {"id": args.feature_id, "title": row["title"], "removed": removed, "error": error})
    conn.commit()
    print(json.dumps({"ok": error is None, "deleted": args.feature_id, "removed": removed,
                      "path": path, "branch": branch, "error": error}, indent=2))
    conn.close()


def feature_workspace(conn, feature_id):
    """Worktree folder + branch of a feature. Returns None when unknown."""
    row = conn.execute("SELECT * FROM features WHERE id = ?", (feature_id,)).fetchone()
    if not row:
        return None
    return {
        "path": (row["worktree_path"] if "worktree_path" in row.keys() else "") or "",
        "branch": (row["worktree_branch"] if "worktree_branch" in row.keys() else "") or "",
        "title": row["title"],
    }


def auto_merge_feature(conn, feature_id):
    """The board never merges a feature on its own.

    The merge is a task for the `integrator` agent. It calls
    `kanban_feature merge` (or `feature merge` on the CLI), which runs the git
    merge in the main checkout. This function only exists to report that no
    automatic merge happened.
    """
    return None


def auto_merge_worktree(conn, task_id, status=None, actor=None):
    """Merge a finished task back into the project branch.

    Runs when a task moves to `done`, and when the reconciler finishes a
    cyclical task (it goes back to `backlog`). Failures never break the status
    change: they are stored in worktree_state/worktree_note and reported on the
    board.

    A task that belongs to a feature does not merge on its own: the feature
    branch is merged by the `integrator` agent (a task of the feature), always
    into the main branch.
    """
    if os.getenv("KANBAN_WORKTREE_AUTOMERGE", "1").strip() == "0":
        return None
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if not row:
        return None
    feature_id = (row["feature_id"] if "feature_id" in row.keys() else "") or ""
    if feature_id:
        # No automatic merge. The integrator task does it.
        return None
    kind = (row["kind"] if "kind" in row.keys() else "") or "oneshot"
    if status == "done":
        pass
    elif kind == "cyclic" and status == "backlog" and (actor or "") == "reconciler":
        pass
    else:
        return None
    path = (row["worktree_path"] if "worktree_path" in row.keys() else "") or ""
    state = (row["worktree_state"] if "worktree_state" in row.keys() else "") or ""
    # No folder means nothing to merge (the board already merged and cleaned up).
    if not path or state == "removed" or not Path(path).exists():
        return None
    project = conn.execute("SELECT * FROM projects WHERE id = ?", (row["project_id"],)).fetchone()
    if not project:
        return None
    try:
        result = merge_worktree(row, project)
    except Exception as exc:  # never break the status change
        result = {"ok": False, "merged": False, "error": str(exc)[:400]}
    if result.get("merged"):
        note = f"Merged {result.get('branch')} into {result.get('target')}"
        repo = (project["path"] or "").strip()
        if kind == "cyclic":
            # A cyclical task keeps its session, so its folder must stay.
            note = f"{note}. Worktree kept for the next cycle."
        else:
            removed, cleanup_note = cleanup_worktree(repo, path, result.get("branch") or "")
            if not removed and cleanup_note:
                note = f"{note}. {cleanup_note}"
        set_worktree_fields(conn, task_id, state="merged", note=note)
        log_event(conn, task_id, "worktree", "worktree.merged",
                  {"branch": result.get("branch"), "target": result.get("target"), "auto": True})
    else:
        note = (result.get("error") or "merge failed")[:500]
        set_worktree_fields(conn, task_id,
                            state="conflict" if result.get("conflict") else "pending", note=note)
        log_event(conn, task_id, "worktree",
                  "worktree.conflict" if result.get("conflict") else "worktree.merge_failed",
                  {"error": note, "files": result.get("files"), "auto": True})
    conn.commit()
    return result



def row_to_task(r: sqlite3.Row) -> dict:
    keys = r.keys()
    return {
        "id": r["id"],
        "projectId": r["project_id"],
        "title": r["title"],
        "description": r["description"] or "",
        "acceptanceCriteria": r["acceptance_criteria"] if "acceptance_criteria" in keys else None,
        "status": r["status"],
        "priority": r["priority"],
        "agentId": r["agent_id"],
        "agentName": r["agent_name"],
        "sessionId": r["session_id"],
        "modelId": r["model_id"],
        "modelProviderID": r["model_provider_id"],
        "startupPhase": r["startup_phase"] if "startup_phase" in keys else None,
        "startupError": r["startup_error"] if "startup_error" in keys else None,
        "kind": r["kind"] if "kind" in keys and r["kind"] else "oneshot",
        "heartbeatAt": r["heartbeat_at"] if "heartbeat_at" in keys else None,
        "expectedSec": r["expected_sec"] if "expected_sec" in keys else None,
        "cycleIntervalSec": r["cycle_interval_sec"] if "cycle_interval_sec" in keys else None,
        "dueDate": r["due_date"] if "due_date" in keys else None,
        "progress": r["progress"] if "progress" in keys and r["progress"] else "",
        "parentSessionId": r["parent_session_id"] if "parent_session_id" in keys else None,
        "parentTaskId": r["parent_task_id"] if "parent_task_id" in keys else None,
        "statusBy": r["status_by"] if "status_by" in keys else None,
        "blockedByTaskIds": parse_id_list(
            r["blocked_by_task_ids"] if "blocked_by_task_ids" in keys else None
        ),
        "result": r["result"] if "result" in keys else None,
        "resultContext": r["result_context"] if "result_context" in keys else None,
        "notifiedAt": r["notified_at"] if "notified_at" in keys else None,
        "worktreePath": r["worktree_path"] if "worktree_path" in keys else None,
        "worktreeBranch": r["worktree_branch"] if "worktree_branch" in keys else None,
        "worktreeState": r["worktree_state"] if "worktree_state" in keys else None,
        "worktreeNote": r["worktree_note"] if "worktree_note" in keys else None,
        "featureId": r["feature_id"] if "feature_id" in keys else None,
        "createdAt": r["created_at"],
        "updatedAt": r["updated_at"],
    }


def resolve_parent_task_id(conn, parent_session_id, project_id, explicit=None):
    """Find the parent task of a new task.

    Automatic: the parent session points to the session of the task that
    created this task. The task row that owns that session is the parent.
    An explicit parent task id always wins.
    """
    explicit = (explicit or "").strip()
    if explicit:
        return explicit
    session_id = (parent_session_id or "").strip()
    if not session_id:
        return None
    row = conn.execute(
        "SELECT id FROM tasks WHERE session_id = ? AND project_id = ? "
        "ORDER BY updated_at DESC LIMIT 1",
        (session_id, project_id),
    ).fetchone()
    if not row:
        row = conn.execute(
            "SELECT id FROM tasks WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1",
            (session_id,),
        ).fetchone()
    return row["id"] if row else None


def inherit_feature_for_session(conn, session_id):
    """The feature a task delegated by this session belongs to.

    Two cases:
    1. The session belongs to a task that is already in a feature (a step of a
       feature delegates a repair task -> the repair stays in the feature).
    2. The session owns a feature it created (the feature orchestrator
       created the feature and now delegates its steps).
    """
    session_id = (session_id or "").strip()
    if not session_id:
        return None
    row = conn.execute(
        "SELECT feature_id FROM tasks WHERE session_id = ? AND feature_id IS NOT NULL "
        "AND TRIM(feature_id) != '' ORDER BY updated_at DESC LIMIT 1",
        (session_id,),
    ).fetchone()
    if row:
        return row["feature_id"]
    row = conn.execute(
        "SELECT id FROM features WHERE owner_session_id = ? ORDER BY created_at DESC LIMIT 1",
        (session_id,),
    ).fetchone()
    return row["id"] if row else None


def check_parent_task(conn, task_id, parent_task_id, project_id):
    """Validate a parent task link. Returns the id or None (no parent)."""
    parent_task_id = (parent_task_id or "").strip()
    if not parent_task_id:
        return None
    if task_id and parent_task_id == task_id:
        fail("Self-parent rejected: a task cannot be its own parent.")
    row = conn.execute("SELECT id, project_id FROM tasks WHERE id = ?", (parent_task_id,)).fetchone()
    if not row:
        fail(f"Parent task not found: {parent_task_id}")
    if project_id and row["project_id"] != project_id:
        fail(f"Parent task {parent_task_id} belongs to another project")
    return parent_task_id


def link_children_by_session(conn, session_id, task_id):
    """Backfill the task-to-task link for children of a session.

    A child task can be created before its parent knows its session id.
    When the parent task gets its session, the children that were created
    from that session get the parent task id.
    """
    session_id = (session_id or "").strip()
    if not session_id or not task_id:
        return 0
    cur = conn.execute(
        "UPDATE tasks SET parent_task_id = ?, updated_at = ? "
        "WHERE parent_task_id IS NULL AND parent_session_id = ? AND id != ?",
        (task_id, now_iso(), session_id, task_id),
    )
    return cur.rowcount or 0


def project_allowed_models(r) -> list:
    """Models usable in this project — a JSON list of "providerID/modelID" in
    allowed_models. An empty list means "no restriction".

    Migration: rows written before allowed_models existed carry the old single
    default (model_id + model_provider_id) instead. Seed the pool with that one
    model so the choice survives the switch; as soon as allowed_models holds a
    value — including '[]' — the legacy columns are ignored for good.
    """
    keys = r.keys()
    raw = r["allowed_models"] if "allowed_models" in keys else None
    if raw not in (None, ""):
        return parse_id_list(raw)
    mid = r["model_id"] if "model_id" in keys else None
    mpid = r["model_provider_id"] if "model_provider_id" in keys else None
    if mid and mpid:
        return [f"{mpid}/{mid}"]
    return []


def row_to_project(r: sqlite3.Row) -> dict:
    try:
        agent_ids = json.loads(r["agent_ids"] or "[]")
    except Exception:
        agent_ids = []
    keys = r.keys()
    folder = r["folder"] if "folder" in keys and r["folder"] else ""
    # Derive folder from path for rows created before the folder column.
    if not folder and r["path"]:
        try:
            folder = Path(r["path"]).name
        except Exception:
            folder = ""
    return {
        "id": r["id"],
        "name": r["name"],
        "path": r["path"] or "",
        "folder": folder,
        "gitUrl": r["git_url"] if "git_url" in keys else None,
        "gitBranch": (r["git_branch"] if "git_branch" in keys and r["git_branch"] else "main"),
        "description": r["description"] or "",
        "agentIds": agent_ids,
        # Models usable in this project ("providerID/modelID"). [] = unrestricted.
        "allowedModels": project_allowed_models(r),
        "createdAt": r["created_at"],
    }


def log_event(conn: sqlite3.Connection, task_id, actor: str, action: str, details=None):
    if isinstance(details, (dict, list)):
        details = json.dumps(details, ensure_ascii=False)
    conn.execute(
        "INSERT INTO events (ts, task_id, actor, action, details) VALUES (?, ?, ?, ?, ?)",
        (now_iso(), task_id, actor, action, details),
    )


def fail(msg: str, code: int = 1):
    print(msg, file=sys.stderr)
    sys.exit(code)


def require_status(v: str) -> str:
    v = (v or "").strip()
    if v not in VALID_STATUSES:
        fail(f"Invalid status '{v}'. Valid: {', '.join(VALID_STATUSES)}")
    return v


def require_priority(v: str) -> str:
    v = (v or "medium").strip()
    if v not in VALID_PRIORITIES:
        fail(f"Invalid priority '{v}'. Valid: {', '.join(VALID_PRIORITIES)}")
    return v


def require_kind(v) -> str:
    v = (v or "oneshot").strip().lower()
    if v not in ("oneshot", "cyclic", "service", "goal"):
        fail(f"Invalid kind '{v}'. Valid: oneshot, cyclic, service, goal")
    return v


def norm_allowed_models(args, *, create=False):
    """Resolve --allowed-model (repeatable) / --clear-allowed-models into the
    column value.

    Scalar-per-flag rather than one JSON blob so no shell can mangle it while
    quoting the argument (PowerShell strips embedded double quotes).

    Returns None when nothing was passed: on create that means "no restriction",
    on update it means "leave the stored value alone".
    """
    items = getattr(args, "allowed_models", None)
    clear = bool(getattr(args, "clear_allowed_models", False))
    if items and clear:
        fail("Pass either --allowed-model <provider/model> … or --clear-allowed-models, not both.")
    if clear:
        return "[]"
    if items is None:
        return "[]" if create else None
    out = []
    for it in items:
        v = str(it).strip() if it is not None else ""
        if not v:
            continue  # --allowed-model "" also clears
        idx = v.find("/")
        if idx <= 0 or idx == len(v) - 1:
            fail(f"Invalid model '{v}' — expected \"providerID/modelID\".")
        if v not in out:
            out.append(v)
    return json.dumps(out)


# ---------------- task dependencies (blockedByTaskIds) ----------------
# A task lists the predecessor task ids that must be done before it can start.
# Stored as a JSON array of uuid strings in tasks.blocked_by_task_ids.
# Invariants enforced on every write:
#   * ids are trimmed, deduplicated, capped (MAX_BLOCKED_BY)
#   * every id exists, belongs to the SAME project, and is not the task itself
#   * adding edges must not close a dependency cycle (A -> B -> A)

MAX_BLOCKED_BY = 50


def parse_id_list(raw) -> list:
    """Accept a JSON array ('["a","b"]') or a comma list ('a,b') or a list.

    Returns trimmed, de-duplicated id strings. Tolerates legacy/garbage rows
    (NULL, "", broken JSON) by returning [].
    """
    if raw is None:
        return []
    if isinstance(raw, (list, tuple)):
        items = list(raw)
    elif isinstance(raw, str):
        s = raw.strip()
        if not s:
            return []
        if s.startswith("["):
            try:
                items = json.loads(s)
            except Exception:
                return []
            if not isinstance(items, list):
                return []
        else:
            items = s.split(",")
    else:
        return []
    out = []
    for it in items:
        s2 = str(it).strip() if it is not None else ""
        if s2 and s2 not in out:
            out.append(s2)
    return out


def load_blocked_map(conn) -> dict:
    """{task_id: [predecessor ids]} over the whole store."""
    out = {}
    for r in conn.execute("SELECT id, blocked_by_task_ids FROM tasks").fetchall():
        keys = r.keys()
        if "blocked_by_task_ids" not in keys:
            continue
        out[r["id"]] = parse_id_list(r["blocked_by_task_ids"])
    return out


def require_blocked_by(conn, task_id, raw, project_id=None) -> list:
    """Validate a blocked-by list. Fails hard on invalid/self/foreign ids."""
    ids = parse_id_list(raw)
    if len(ids) > MAX_BLOCKED_BY:
        fail(f"Too many blocked-by ids ({len(ids)}). Max {MAX_BLOCKED_BY}.")
    for dep in ids:
        if dep == task_id:
            fail(f"Self-dependency rejected: task {task_id} cannot be blocked by itself.")
        row = conn.execute("SELECT id, project_id FROM tasks WHERE id = ?", (dep,)).fetchone()
        if not row:
            fail(f"Invalid blocked-by task id: {dep} (no such task)")
        if project_id is not None and row["project_id"] != project_id:
            fail(f"Invalid blocked-by task id: {dep} (must belong to the same project)")
    return ids


def find_dependency_cycle(conn, task_id, new_ids) -> list:
    """Return the cycle path when the new edges close a loop, else None.

    Edge direction: T -> each predecessor in blockedBy(T). Only edges OUT of
    task_id change here, so any new cycle must pass back through task_id —
    a DFS from task_id over the post-update graph is sufficient.
    """
    graph = load_blocked_map(conn)
    graph[task_id] = list(new_ids)
    seen = set()
    stack = [(task_id, [task_id])]
    while stack:
        node, path = stack.pop()
        for dep in graph.get(node, []):
            if dep == task_id:
                return path + [dep]
            if dep in seen:
                continue
            seen.add(dep)
            stack.append((dep, path + [dep]))
    return None


def scrub_dependency_refs(conn, gone_id: str):
    """Drop gone_id from every other task's blocked-by list (referential cleanup)."""
    graph = load_blocked_map(conn)
    ts = now_iso()
    for tid, deps in graph.items():
        if tid != gone_id and gone_id in deps:
            conn.execute(
                "UPDATE tasks SET blocked_by_task_ids = ?, updated_at = ? WHERE id = ?",
                (json.dumps([d for d in deps if d != gone_id]), ts, tid),
            )


# ---------------- CLI handlers ----------------

def cmd_init(args):
    conn = get_conn(args.db)
    conn.close()
    print(json.dumps({"ok": True, "db": str(args.db)}))


def cmd_project_create(args):
    conn = get_conn(args.db)
    pid = args.id or new_uuid()
    if conn.execute("SELECT id FROM projects WHERE id = ?", (pid,)).fetchone():
        fail(f"Project already exists: {pid}")
    # folder wins; legacy --path is accepted only if inside the base root.
    folder = (getattr(args, "folder", None) or "").strip()
    raw_path = (args.path or "").strip()
    if folder:
        folder = validate_folder(folder)
        path = folder_to_path(folder)
        d = Path(path)
        if not d.exists():
            # Always create the folder on new projects — except when the
            # caller explicitly passes --no-mkdir (e.g. link-only flows).
            if not getattr(args, "no_mkdir", False):
                d.mkdir(parents=True, exist_ok=False)
    elif raw_path:
        try:
            resolved = Path(raw_path).resolve()
            root = projects_root().resolve()
            resolved.relative_to(root)
            folder = resolved.name
            path = str(resolved)
        except Exception:
            fail(f"Invalid path '{raw_path}'. Must be inside {os.getenv('KANBAN_PROJECTS_ROOT')}, or pass --folder <name>.")
    else:
        fail("Missing folder. Pass --folder <name> (inside KANBAN_PROJECTS_ROOT).")
    allowed_models = norm_allowed_models(args, create=True) or "[]"
    conn.execute(
        "INSERT INTO projects (id, name, path, folder, git_url, git_branch, description, agent_ids, allowed_models, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (pid, args.name, path, folder, getattr(args, "git_url", None),
         getattr(args, "git_branch", None) or "main",
         args.description or "", json.dumps(args.agent_ids or []), allowed_models, now_iso()),
    )
    log_event(conn, None, args.actor, "project.created", {"id": pid, "name": args.name, "folder": folder})
    conn.commit()
    row = conn.execute("SELECT * FROM projects WHERE id = ?", (pid,)).fetchone()
    print(json.dumps(row_to_project(row), indent=2))
    conn.close()


def cmd_project_update(args):
    conn = get_conn(args.db)
    row = conn.execute("SELECT * FROM projects WHERE id = ?", (args.project_id,)).fetchone()
    if not row:
        fail(f"Project not found: {args.project_id}")
    sets, params = [], []
    if args.name is not None:
        sets.append("name = ?"); params.append(args.name)
    # folder change re-derives path (always inside base root).
    new_folder = (getattr(args, "folder", None) or "").strip() or None
    if new_folder:
        new_folder = validate_folder(new_folder)
        sets.append("folder = ?"); params.append(new_folder)
        sets.append("path = ?"); params.append(folder_to_path(new_folder))
    elif args.path is not None:
        try:
            resolved = Path(args.path).resolve()
            resolved.relative_to(projects_root().resolve())
            sets.append("path = ?"); params.append(str(resolved))
            sets.append("folder = ?"); params.append(resolved.name)
        except Exception:
            fail(f"Invalid path '{args.path}'. Must be inside {os.getenv('KANBAN_PROJECTS_ROOT')}.")
    if args.description is not None:
        sets.append("description = ?"); params.append(args.description)
    if getattr(args, "git_url", None) is not None:
        sets.append("git_url = ?"); params.append(args.git_url)
    if getattr(args, "git_branch", None) is not None:
        sets.append("git_branch = ?"); params.append(args.git_branch or "main")
    if args.agent_ids is not None:
        sets.append("agent_ids = ?"); params.append(json.dumps(args.agent_ids))
    # Allowed models: JSON array of "providerID/modelID"; clearing it makes
    # every model usable again.
    allowed = norm_allowed_models(args)
    if allowed is not None:
        sets.append("allowed_models = ?"); params.append(allowed)
    if not sets:
        fail("Nothing to update.")
    params.append(args.project_id)
    conn.execute(f"UPDATE projects SET {', '.join(sets)} WHERE id = ?", params)
    conn.commit()
    row = conn.execute("SELECT * FROM projects WHERE id = ?", (args.project_id,)).fetchone()
    print(json.dumps(row_to_project(row), indent=2))
    conn.close()


def cmd_folders_list(args):
    root = projects_root()
    items = sorted([p.name for p in root.iterdir() if p.is_dir() and not p.name.startswith(".")])
    if getattr(args, "json", False):
        print(json.dumps({"root": str(root), "folders": items}, indent=2))
    else:
        print(f"root={root}")
        for f in items:
            print(f)


def cmd_git_info(args):
    print(json.dumps(git_info_for(args.folder), indent=2))


def cmd_git_check(args):
    conn = get_conn(args.db)
    row = conn.execute("SELECT * FROM projects WHERE id = ?", (args.project_id,)).fetchone()
    if not row:
        fail(f"Project not found: {args.project_id}")
    folder = row["folder"] if "folder" in row.keys() and row["folder"] else Path(row["path"]).name
    res = check_branch_pinned(row, folder)
    print(json.dumps(res, indent=2))
    if not res.get("ok") and not getattr(args, "quiet", False):
        print(f"WARNING: checkout is '{res.get('current')}', pinned is '{res.get('pinned')}'", file=sys.stderr)


def cmd_git_clone(args):
    folder = validate_folder(args.folder)
    dest = Path(folder_to_path(folder))
    if dest.exists() and any(dest.iterdir()):
        fail(f"Folder {dest} already exists and is not empty.")
    dest.parent.mkdir(parents=True, exist_ok=True)
    # Don't force --branch when the remote doesn't have that branch;
    # cloning without it checks out the remote's default HEAD.
    argv = ["git", "clone"]
    branch = (args.branch or "").strip() or "main"
    # Only pass --branch if not the default "main" — lets HEAD win when
    # remote uses master/main-less defaults, and still honors explicit picks.
    if branch != "main":
        argv += ["--branch", branch]
    argv += [args.url, str(dest)]
    r = _sp.run(argv, capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        fail(f"git clone failed: {(r.stderr or r.stdout).strip()[:500]}")
    print(json.dumps({"ok": True, "folder": folder, "path": str(dest)}, indent=2))


def cmd_project_list(args):
    conn = get_conn(args.db)
    rows = conn.execute("SELECT * FROM projects ORDER BY created_at").fetchall()
    if args.json:
        print(json.dumps([row_to_project(r) for r in rows], indent=2))
    else:
        if not rows:
            print("No projects found.")
        for r in rows:
            p = row_to_project(r)
            n = conn.execute("SELECT COUNT(*) c FROM tasks WHERE project_id = ?", (p["id"],)).fetchone()["c"]
            print(f"{p['id']}  name={p['name']}  path={p['path']}  tasks={n}")
    conn.close()


def cmd_project_delete(args):
    conn = get_conn(args.db)
    row = conn.execute("SELECT * FROM projects WHERE id = ?", (args.project_id,)).fetchone()
    if not row:
        fail(f"Project not found: {args.project_id}")
    n = conn.execute("SELECT COUNT(*) c FROM tasks WHERE project_id = ?", (args.project_id,)).fetchone()["c"]
    conn.execute("DELETE FROM tasks WHERE project_id = ?", (args.project_id,))
    conn.execute("DELETE FROM projects WHERE id = ?", (args.project_id,))
    log_event(conn, None, args.actor, "project.deleted",
              {"id": args.project_id, "name": row["name"], "tasksDeleted": n})
    conn.commit()
    print(json.dumps({"ok": True, "deleted": args.project_id, "tasksDeleted": n}))
    conn.close()


def cmd_task_create(args):
    conn = get_conn(args.db)
    board = conn.execute("SELECT id FROM projects WHERE id = ?", (args.project,)).fetchone()
    if not board:
        fail(f"Project not found: {args.project}")
    tid = args.id or new_uuid()
    if conn.execute("SELECT id FROM tasks WHERE id = ?", (tid,)).fetchone():
        fail(f"Task already exists: {tid}")
    status = require_status(args.status or "backlog")
    priority = require_priority(args.priority or "medium")
    kind = require_kind(getattr(args, "kind", None) or "oneshot")
    # Dependencies: validated against the store (existence + project + no self).
    # A brand-new row cannot close a cycle yet, so only id checks run here.
    blocked_raw = getattr(args, "blocked_by", None)
    blocked_ids = require_blocked_by(conn, tid, blocked_raw, project_id=args.project) if blocked_raw is not None else []
    # Task-to-task link. Automatic: the task that owns the parent session is
    # the parent task. An explicit --parent-task-id wins.
    parent_session_id = getattr(args, "parent_session_id", None)
    parent_task_id = resolve_parent_task_id(
        conn, parent_session_id, args.project, getattr(args, "parent_task_id", None)
    )
    if parent_task_id:
        parent_task_id = check_parent_task(conn, tid, parent_task_id, args.project)
    # Feature group: the task works in the feature worktree, on the feature
    # branch. The worktree location is on the task row from the start.
    feature_id = (getattr(args, "feature", None) or "").strip()
    if not feature_id and parent_session_id:
        # A step of a feature joins the feature of its parent session. The
        # feature orchestrator creates the feature and then delegates the
        # steps; the steps must work in the feature worktree, not in their own.
        feature_id = inherit_feature_for_session(conn, parent_session_id) or ""
    feature_row = None
    if feature_id:
        feature_row = conn.execute("SELECT * FROM features WHERE id = ?", (feature_id,)).fetchone()
        if not feature_row:
            fail(f"Feature not found: {feature_id}")
        if feature_row["project_id"] != args.project:
            fail(f"Feature {feature_id} belongs to another project")
    expected = getattr(args, "expected_sec", None)
    cycle_interval = getattr(args, "cycle_interval_sec", None)
    ts = now_iso()
    conn.execute(
        """INSERT INTO tasks (id, project_id, title, description, status, priority,
                              agent_id, agent_name, session_id, model_id, model_provider_id,
                              startup_phase, startup_error, kind, heartbeat_at,
                               expected_sec, cycle_interval_sec, progress, parent_session_id,
                                parent_task_id,
                                result, result_context, acceptance_criteria, due_date,
                              blocked_by_task_ids, feature_id,
                              worktree_path, worktree_branch, worktree_state,
                              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (tid, args.project, args.title, args.description or "", status, priority,
         args.agent_id, args.agent_name, args.session_id,
         args.model_id, args.model_provider,
         args.startup_phase, args.startup_error, kind, ts if status == "running" else None,
          expected, cycle_interval, getattr(args, "progress", None) or "",
         getattr(args, "parent_session_id", None),
          parent_task_id or None,
          getattr(args, "result", None), getattr(args, "result_context", None),
           getattr(args, "acceptance_criteria", None), getattr(args, "due_date", None),
         json.dumps(blocked_ids),
         feature_id or None,
         # A feature task points at the feature worktree and branch.
         (feature_row["worktree_path"] if feature_row is not None else None),
         (feature_row["worktree_branch"] if feature_row is not None else None),
         ("active" if feature_row is not None else None),
         ts, ts),
    )
    log_event(conn, tid, args.actor, "task.created",
              {"projectId": args.project, "title": args.title, "status": status,
               "featureId": feature_id or None})
    conn.commit()
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (tid,)).fetchone()
    print(json.dumps(row_to_task(row), indent=2))
    conn.close()


def cmd_task_list(args):
    conn = get_conn(args.db)
    sql = "SELECT * FROM tasks WHERE 1=1"
    params: list = []
    if args.project:
        sql += " AND project_id = ?"
        params.append(args.project)
    if args.status:
        require_status(args.status)
        sql += " AND status = ?"
        params.append(args.status)
    if args.agent:
        sql += " AND agent_id = ?"
        params.append(args.agent)
    sql += " ORDER BY updated_at DESC"
    rows = conn.execute(sql, params).fetchall()
    if args.json or True:
        print(json.dumps([row_to_task(r) for r in rows], indent=2))
    conn.close()


def cmd_task_show(args):
    conn = get_conn(args.db)
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (args.task_id,)).fetchone()
    if not row:
        fail(f"Task not found: {args.task_id}")
    print(json.dumps(row_to_task(row), indent=2))
    conn.close()


def reset_stale_worktree(conn, task_id):
    """A removed worktree invalidates the session that works in it.

    After the board merged and cleaned up a worktree, a re-run must start in a
    new folder with a new session. The stale session id is cleared here, so the
    board creates a fresh session in the fresh worktree.
    """
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if not row:
        return False
    path = (row["worktree_path"] if "worktree_path" in row.keys() else "") or ""
    if not path or Path(path).exists():
        return False
    conn.execute(
        "UPDATE tasks SET session_id = NULL, worktree_path = NULL, worktree_state = NULL, "
        "worktree_branch = NULL, worktree_note = ? WHERE id = ?",
        ("worktree removed — a new worktree is created on the next run", task_id),
    )
    log_event(conn, task_id, "worktree", "worktree.reset", {"path": path})
    return True


def cmd_task_update(args):
    conn = get_conn(args.db)
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (args.task_id,)).fetchone()
    if not row:
        fail(f"Task not found: {args.task_id}")
    sets, params, changes = [], [], {}
    mapping = [
        ("title", args.title), ("description", args.description),
        ("agent_id", args.agent_id), ("agent_name", args.agent_name),
        ("session_id", args.session_id), ("model_id", args.model_id),
        ("model_provider_id", args.model_provider),
        ("startup_phase", args.startup_phase), ("startup_error", args.startup_error),
        ("kind", getattr(args, "kind", None)),
        ("cycle_interval_sec", getattr(args, "cycle_interval_sec", None)),
        ("progress", getattr(args, "progress", None)),
        ("parent_session_id", getattr(args, "parent_session_id", None)),
        ("result", getattr(args, "result", None)),
        ("result_context", getattr(args, "result_context", None)),
        ("acceptance_criteria", getattr(args, "acceptance_criteria", None)),
        ("notified_at", getattr(args, "notified_at", None)),
        ("due_date", getattr(args, "due_date", None)),
        ("worktree_note", getattr(args, "worktree_note", None)),
        ("worktree_state", getattr(args, "worktree_state", None)),
    ]
    for col, val in mapping:
        if val is not None:
            if col == "kind":
                val = require_kind(val)
            if col == "cycle_interval_sec":
                try:
                    val = int(val)
                except (TypeError, ValueError):
                    fail("Invalid cycle interval. Must be an integer (seconds).")
            sets.append(f"{col} = ?")
            params.append(val)
            changes[col] = val
    if args.priority is not None:
        sets.append("priority = ?")
        params.append(require_priority(args.priority))
        changes["priority"] = args.priority
    # Who set the status. The reconciler uses it: a task that the agent (or
    # the watchdog) blocked keeps that status.
    if args.status is not None:
        sets.append("status_by = ?")
        params.append((args.actor or "cli").strip() or "cli")
        changes["statusBy"] = params[-1]
    old_status = row["status"]
    keep_phase = bool(getattr(args, "keep_startup_phase", False))
    if args.status is not None:
        new_status = require_status(args.status)
        # The rules are checked BEFORE the write. A refused change must not
        # change anything: the row was already 'running' while the command
        # reported the error, and two steps wrote into one feature worktree.
        if new_status == "running":
            # One writer per feature worktree (same rule as cmd_task_move).
            sibling = feature_running_sibling(
                conn, args.task_id, (row["feature_id"] if "feature_id" in row.keys() else "") or ""
            )
            if sibling:
                fail(f"Feature worktree is busy: task {sibling['id']} ({sibling['title']}) is running. "
                     f"Run one step of a feature at a time.")
        sets.append("status = ?")
        params.append(new_status)
        changes["status"] = new_status
        # Same arming as cmd_task_move: status flips via update (drag =
        # PATCH, plugin = task update) must reset the runner handshake too.
        # Only when the status really changes: a task that is already running
        # keeps its handshake, so the board does not start it a second time.
        if new_status == "running" and old_status != "running":
            phase = args.startup_phase
            # A caller that starts the task itself (the delegate) leaves a
            # mark. The board tab starts every running task without a phase,
            # so without the mark it would open a second session.
            if phase is None and (args.actor or "") == "delegate":
                phase = "sending-prompt"
            if phase is None and not keep_phase:
                sets.append("startup_phase = ?")
                params.append(None)
                changes["startup_phase"] = None
                sets.append("startup_error = ?")
                params.append(None)
                changes["startup_error"] = None
            elif phase is not None:
                sets.append("startup_phase = ?")
                params.append(phase)
                changes["startup_phase"] = phase
        if new_status == "running":
            # The activity clock of the task starts now.
            sets.append("heartbeat_at = ?")
            params.append(now_iso())
    if getattr(args, "expected_sec", None) is not None:
        try:
            sets.append("expected_sec = ?")
            params.append(int(args.expected_sec))
            changes["expected_sec"] = int(args.expected_sec)
        except (TypeError, ValueError):
            fail(f"Invalid --expected-sec '{args.expected_sec}'. Must be an integer (seconds).")
    # Dependencies: --blocked-by "a,b" replaces the list; "" clears it.
    if getattr(args, "blocked_by", None) is not None:
        raw = args.blocked_by
        if isinstance(raw, str) and not raw.strip():
            blocked_ids = []
        else:
            blocked_ids = require_blocked_by(
                conn, args.task_id, raw, project_id=row["project_id"]
            )
        cycle = find_dependency_cycle(conn, args.task_id, blocked_ids)
        if cycle:
            fail("Dependency cycle rejected: " + " -> ".join(cycle))
        sets.append("blocked_by_task_ids = ?")
        params.append(json.dumps(blocked_ids))
        changes["blockedByTaskIds"] = blocked_ids
    # Task-to-task link: --parent-task-id "id" sets the parent, "" sets none.
    if getattr(args, "parent_task_id", None) is not None:
        raw = str(args.parent_task_id).strip()
        parent = check_parent_task(conn, args.task_id, raw, row["project_id"]) if raw else None
        sets.append("parent_task_id = ?")
        params.append(parent)
        changes["parentTaskId"] = parent
    if not sets:
        fail("Nothing to update. Pass --title/--description/--status/--priority/...")
    sets.append("updated_at = ?")
    params.append(now_iso())
    params.append(args.task_id)
    conn.execute(f"UPDATE tasks SET {', '.join(sets)} WHERE id = ?", params)
    # A task that gets its session id is the parent of the tasks that were
    # created from that session. Link them now.
    if args.session_id:
        linked = link_children_by_session(conn, args.session_id, args.task_id)
        if linked:
            changes["linkedChildren"] = linked
    log_event(conn, args.task_id, args.actor, "task.edited", changes)
    conn.commit()
    if args.status == "running":
        # A removed worktree invalidates the old session — start fresh.
        reset_stale_worktree(conn, args.task_id)
    # A finished task merges its worktree back into the project branch.
    auto_merge_worktree(conn, args.task_id, status=args.status, actor=args.actor)
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (args.task_id,)).fetchone()
    print(json.dumps(row_to_task(row), indent=2))
    conn.close()


def feature_running_sibling(conn, task_id, feature_id):
    """The other running task of the same feature, or None.

    A feature worktree has one writer. A second running task of the same
    feature would fight over the same files, so the board refuses it.
    """
    row = conn.execute("SELECT id, title FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if not row or not feature_id:
        return None
    other = conn.execute(
        """SELECT id, title FROM tasks
             WHERE feature_id = ? AND id != ? AND status = 'running' LIMIT 1""",
        (feature_id, task_id),
    ).fetchone()
    if not other:
        return None
    return {"id": other["id"], "title": other["title"]}


def cmd_task_move(args):
    conn = get_conn(args.db)
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (args.task_id,)).fetchone()
    if not row:
        fail(f"Task not found: {args.task_id}")
    status = require_status(args.status)
    old = row["status"]
    # One writer per feature worktree: a second running task of the same
    # feature is refused, so the steps cannot overwrite each other.
    if status == "running":
        sibling = feature_running_sibling(
            conn, args.task_id, (row["feature_id"] if "feature_id" in row.keys() else "") or ""
        )
        if sibling:
            fail(f"Feature worktree is busy: task {sibling['id']} ({sibling['title']}) is running. "
                 f"Run one step of a feature at a time.")
    # Arming: any transition TO running resets the runner handshake so the
    # frontend watcher and the server reconciler see a fresh start. Without
    # this, a re-run of a finished task (done → backlog → running) keeps the
    # stale `ready` phase and execution never fires again.
    if status == "running":
        # A task that is already running keeps its handshake. The arming reset
        # only happens on a real change, so the board does not start it twice.
        if old != "running":
            # A caller that starts the task itself (the delegate) passes its
            # own phase. The board then sees "running + phase" and does not
            # start the task a second time.
            phase = args.startup_phase if getattr(args, "startup_phase", None) is not None else None
            # A delegate that does not pass a phase still starts the task
            # itself. The board tab starts every running task without a
            # phase, so the delegate leaves a mark: without it the tab opens
            # a second session for the same task (two features, two merges).
            if phase is None and (args.actor or "") == "delegate":
                phase = "sending-prompt"
            conn.execute("UPDATE tasks SET status = ?, status_by = ?, heartbeat_at = ?, startup_phase = ?, startup_error = ?, updated_at = ? WHERE id = ?",
                         (status, (args.actor or "cli"), now_iso(), phase, None, now_iso(), args.task_id))
        else:
            conn.execute("UPDATE tasks SET status = ?, status_by = ?, heartbeat_at = ?, updated_at = ? WHERE id = ?",
                         (status, (args.actor or "cli"), now_iso(), now_iso(), args.task_id))
    else:
        conn.execute("UPDATE tasks SET status = ?, status_by = ?, heartbeat_at = ?, updated_at = ? WHERE id = ?",
                     (status, (args.actor or "cli"), row["heartbeat_at"] if "heartbeat_at" in row.keys() else None, now_iso(), args.task_id))
    log_event(conn, args.task_id, args.actor, "task.moved",
              {"from": old, "to": status, "comment": args.comment})
    conn.commit()
    if status == "running":
        # A removed worktree invalidates the old session — start fresh.
        reset_stale_worktree(conn, args.task_id)
    # A finished task merges its worktree back into the project branch.
    auto_merge_worktree(conn, args.task_id, status=status, actor=args.actor)
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (args.task_id,)).fetchone()
    print(json.dumps(row_to_task(row), indent=2))
    conn.close()


def cmd_task_deps(args):
    """Read a task's dependency relations: predecessors, dependents, readiness."""
    conn = get_conn(args.db)
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (args.task_id,)).fetchone()
    if not row:
        fail(f"Task not found: {args.task_id}")
    graph = load_blocked_map(conn)
    blocked_by = graph.get(args.task_id, [])
    preds = []
    for dep in blocked_by:
        d = conn.execute("SELECT status, title FROM tasks WHERE id = ?", (dep,)).fetchone()
        preds.append({
            "id": dep,
            "exists": bool(d),
            "status": d["status"] if d else None,
            "title": d["title"] if d else None,
            "done": bool(d) and d["status"] == "done",
        })
    dependents = sorted(tid for tid, deps in graph.items() if args.task_id in deps)
    print(json.dumps({
        "id": args.task_id,
        "status": row["status"],
        "blockedByTaskIds": blocked_by,
        "predecessors": preds,
        "dependents": dependents,
        "ready": all(p["done"] for p in preds),
    }, indent=2))
    conn.close()


def cmd_task_children(args):
    """List the child tasks of a task (tasks created inside that task)."""
    conn = get_conn(args.db)
    row = conn.execute("SELECT id FROM tasks WHERE id = ?", (args.task_id,)).fetchone()
    if not row:
        fail(f"Task not found: {args.task_id}")
    rows = conn.execute(
        "SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at ASC",
        (args.task_id,),
    ).fetchall()
    children = [row_to_task(r) for r in rows]
    # Old rows: children that only have the parent session. Link them now.
    parent = conn.execute(
        "SELECT session_id FROM tasks WHERE id = ?", (args.task_id,)
    ).fetchone()
    session_id = (parent["session_id"] or "") if parent else ""
    if session_id:
        link_children_by_session(conn, session_id, args.task_id)
        rows = conn.execute(
            "SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at ASC",
            (args.task_id,),
        ).fetchall()
        children = [row_to_task(r) for r in rows]
    conn.commit()
    print(json.dumps(children, indent=2))
    conn.close()


def cmd_task_delete(args):
    conn = get_conn(args.db)
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (args.task_id,)).fetchone()
    if not row:
        fail(f"Task not found: {args.task_id}")
    # A deleted task must not leave a worktree folder behind.
    wt_path = (row["worktree_path"] if "worktree_path" in row.keys() else "") or ""
    if wt_path:
        try:
            project = conn.execute("SELECT * FROM projects WHERE id = ?", (row["project_id"],)).fetchone()
            if project:
                top = git_toplevel((project["path"] or "").strip())
                if top:
                    remove_worktree(top, wt_path, force=True)
        except Exception:
            pass
    # Referential cleanup: other tasks must not keep pointing at a dead id.
    scrub_dependency_refs(conn, args.task_id)
    conn.execute(
        "UPDATE tasks SET parent_task_id = NULL WHERE parent_task_id = ?",
        (args.task_id,),
    )
    conn.execute("DELETE FROM tasks WHERE id = ?", (args.task_id,))
    log_event(conn, None, args.actor, "task.deleted",
              {"id": args.task_id, "title": row["title"]})
    conn.commit()
    print(json.dumps({"ok": True, "deleted": args.task_id}))
    conn.close()


def cmd_task_heartbeat(args):
    """Liveness ping: refreshes heartbeat_at (+progress) without touching status."""
    conn = get_conn(args.db)
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (args.task_id,)).fetchone()
    if not row:
        fail(f"Task not found: {args.task_id}")
    ts = now_iso()
    sets = ["heartbeat_at = ?", "updated_at = ?"]
    params = [ts, ts]
    changes = {"heartbeat_at": ts}
    if getattr(args, "progress", None) is not None:
        sets.append("progress = ?")
        params.append(args.progress)
        changes["progress"] = args.progress
    params.append(args.task_id)
    conn.execute(f"UPDATE tasks SET {', '.join(sets)} WHERE id = ?", params)
    log_event(conn, args.task_id, args.actor, "task.heartbeat", changes)
    conn.commit()
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (args.task_id,)).fetchone()
    print(json.dumps(row_to_task(row), indent=2))
    conn.close()


def cmd_task_watch(args):
    """Stall watchdog: oneshot+running with stale heartbeat -> blocked(stalled).

    Services (kind=service, e.g. npm run dev) are exempt — running IS success.
    Prints JSON {checked, stalled[]} and logs task.stalled events.
    """
    import datetime as _dt
    conn = get_conn(args.db)
    rows = conn.execute(
        "SELECT * FROM tasks WHERE status = 'running' "
        "AND (kind IS NULL OR kind = 'oneshot')"
    ).fetchall()
    now = _dt.datetime.now(_dt.timezone.utc)
    stalled = []
    for r in rows:
        keys = r.keys()
        hb = r["heartbeat_at"] if "heartbeat_at" in keys and r["heartbeat_at"] else (r["updated_at"] or r["created_at"])
        try:
            last = _dt.datetime.fromisoformat(str(hb).replace("Z", "+00:00"))
            if last.tzinfo is None:
                last = last.replace(tzinfo=_dt.timezone.utc)
            age = (now - last).total_seconds()
        except Exception:
            age = float("inf")
        limit = r["expected_sec"] if "expected_sec" in keys and r["expected_sec"] else None
        try:
            limit = int(limit) if limit is not None else args.default_timeout
        except (TypeError, ValueError):
            limit = args.default_timeout
        if age > limit:
            msg = f"stalled: no heartbeat for {int(age)}s (limit {limit}s)"
            ts = now_iso()
            conn.execute(
                "UPDATE tasks SET status = 'blocked', status_by = 'watchdog', startup_phase = 'error', startup_error = ?, updated_at = ? WHERE id = ?",
                (msg, ts, r["id"]),
            )
            log_event(conn, r["id"], args.actor, "task.stalled",
                      {"ageSec": int(age), "limitSec": limit, "lastHeartbeat": hb})
            keys2 = r.keys()
            stalled.append({"id": r["id"], "title": r["title"], "ageSec": int(age), "limitSec": limit,
                            "sessionId": r["session_id"] if "session_id" in keys2 else None})
    conn.commit()
    print(json.dumps({"checked": len(rows), "stalled": stalled}, indent=2))
    conn.close()


def cmd_task_notify_pending(args):
    """Delivery ledger scan: finished tasks with a parent that are NOT yet delivered.

    This is the read half of the result link-back. It watches the DATA (status +
    parent_session_id + notified_at), so every path that flips a task to
    done/blocked is covered — reconciler, watchdog, plugin, drag-drop — not just
    the callers that remembered to notify.
    """
    conn = get_conn(args.db)
    rows = conn.execute(
        """SELECT * FROM tasks
             WHERE status IN ('done', 'blocked')
               AND parent_session_id IS NOT NULL
               AND TRIM(COALESCE(parent_session_id, '')) != ''
               AND notified_at IS NULL
             ORDER BY updated_at ASC"""
    ).fetchall()
    out = [row_to_task(r) for r in rows]
    lim = getattr(args, "limit", None)
    if lim is not None:
        out = out[: int(lim)]
    print(json.dumps(out, indent=2))
    conn.close()


def cmd_task_notify_unmark(args):
    """Clear notified_at so the result is delivered again.

    The delivery marks a task before it posts the message, so two passes can
    never deliver the same result twice. If the post fails, the mark is
    cleared and the next pass tries again.
    """
    conn = get_conn(args.db)
    cleared = []
    for tid in args.task_ids:
        row = conn.execute("SELECT id FROM tasks WHERE id = ?", (tid,)).fetchone()
        if not row:
            fail(f"Task not found: {tid}")
        conn.execute("UPDATE tasks SET notified_at = NULL, updated_at = ? WHERE id = ?", (now_iso(), tid))
        cleared.append(tid)
    conn.commit()
    print(json.dumps({"ok": True, "unmarked": cleared}, indent=2))
    conn.close()


def cmd_task_notify_mark(args):
    """Stamp notified_at so the ledger stops retrying these tasks (idempotent).

    Accepts one or more ids so a parent that received a single batched
    delivery is stamped in a single subprocess call.
    """
    conn = get_conn(args.db)
    stamped = []
    for tid in args.task_ids:
        row = conn.execute("SELECT id FROM tasks WHERE id = ?", (tid,)).fetchone()
        if not row:
            fail(f"Task not found: {tid}")
        ts = now_iso()
        conn.execute(
            "UPDATE tasks SET notified_at = ?, updated_at = ? WHERE id = ?",
            (ts, ts, tid),
        )
        log_event(conn, tid, args.actor, "task.notified", {"notifiedAt": ts})
        stamped.append({"id": tid, "notifiedAt": ts})
    conn.commit()
    print(json.dumps({"ok": True, "marked": stamped}))
    conn.close()


def cmd_events_list(args):
    conn = get_conn(args.db)
    sql = "SELECT * FROM events WHERE 1=1"
    params: list = []
    if args.task:
        sql += " AND task_id = ?"
        params.append(args.task)
    sql += " ORDER BY id DESC LIMIT ?"
    params.append(args.limit)
    rows = conn.execute(sql, params).fetchall()
    print(json.dumps([dict(r) for r in rows], indent=2, default=str))
    conn.close()


def main(argv=None):
    parser = argparse.ArgumentParser(prog="kanban", description="kanban-clone SQLite store (uuid model).")
    parser.add_argument("--db", default=str(DEFAULT_DB), help=f"SQLite file. Default: {DEFAULT_DB}")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("init", help="Create DB + schema.")
    p.set_defaults(func=cmd_init)

    pp = sub.add_parser("project", help="Project commands.")
    psub = pp.add_subparsers(dest="pcmd", required=True)
    pc = psub.add_parser("create", help="Create project.")
    pc.add_argument("--name", required=True)
    pc.add_argument("--path", default="")
    pc.add_argument("--folder", default=None)
    pc.add_argument("--git-url", default=None)
    pc.add_argument("--git-branch", default=None)
    pc.add_argument("--no-mkdir", action="store_true", help="Do NOT create the folder under PROJECTS_ROOT (link-only)")
    pc.add_argument("--description", default="")
    pc.add_argument("--id", default=None)
    pc.add_argument("--agent-id", dest="agent_ids", action="append", default=[])
    pc.add_argument("--allowed-model", dest="allowed_models", action="append", default=None, metavar="MODEL",
                    help='Model usable in this project, as providerID/modelID. Repeat the flag to allow several; omit for no restriction.')
    pc.add_argument("--clear-allowed-models", action="store_true",
                    help="Drop any model restriction (every server model is usable).")
    pc.add_argument("--actor", default="cli")
    pc.set_defaults(func=cmd_project_create)
    pl = psub.add_parser("list", help="List projects.")
    pl.add_argument("--json", action="store_true")
    pl.set_defaults(func=cmd_project_list)
    pu = psub.add_parser("update", help="Update project.")
    pu.add_argument("project_id")
    pu.add_argument("--name", default=None)
    pu.add_argument("--path", default=None)
    pu.add_argument("--folder", default=None)
    pu.add_argument("--git-url", default=None)
    pu.add_argument("--git-branch", default=None)
    pu.add_argument("--description", default=None)
    pu.add_argument("--agent-id", dest="agent_ids", action="append", default=None)
    pu.add_argument("--allowed-model", dest="allowed_models", action="append", default=None, metavar="MODEL",
                    help='Model usable in this project, as providerID/modelID. Repeat to allow several; replaces the stored list.')
    pu.add_argument("--clear-allowed-models", action="store_true",
                    help="Drop any model restriction (every server model is usable).")
    pu.add_argument("--actor", default="cli")
    pu.set_defaults(func=cmd_project_update)
    pd = psub.add_parser("delete", help="Delete project + its tasks.")
    pd.add_argument("project_id")
    pd.add_argument("--actor", default="cli")
    pd.set_defaults(func=cmd_project_delete)
    fl = sub.add_parser("folders", help="Folders under PROJECTS_ROOT / git info.")
    fsub = fl.add_subparsers(dest="fcmd", required=True)
    fa = fsub.add_parser("list", help="List folders under PROJECTS_ROOT.")
    fa.add_argument("--json", action="store_true")
    fa.set_defaults(func=cmd_folders_list)
    fg = fsub.add_parser("git", help="Git info for a folder.")
    fg.add_argument("folder")
    fg.set_defaults(func=cmd_git_info)
    fg2 = fsub.add_parser("check", help="Check branch == pinned for project.")
    fg2.add_argument("project_id")
    fg2.add_argument("--quiet", action="store_true")
    fg2.set_defaults(func=cmd_git_check)
    fg3 = fsub.add_parser("clone", help="git clone into PROJECTS_ROOT/folder.")
    fg3.add_argument("url")
    fg3.add_argument("--folder", required=True)
    fg3.add_argument("--branch", default="main")
    fg3.set_defaults(func=cmd_git_clone)

    wp = sub.add_parser("worktree", help="Per-task git worktree isolation.")
    wsub = wp.add_subparsers(dest="wcmd", required=True)
    wc = wsub.add_parser("create", help="Create the git worktree of one task.")
    wc.add_argument("task_id")
    wc.add_argument("--base", default=None, help="Base branch (default: the project branch)")
    wc.set_defaults(func=cmd_worktree_create)
    wm = wsub.add_parser("merge", help="Merge the task worktree into the project branch.")
    wm.add_argument("task_id")
    wm.add_argument("--target", default=None, help="Target branch (default: the project branch)")
    wm.add_argument("--cleanup", action="store_true", help="Remove the worktree after a successful merge")
    wm.set_defaults(func=cmd_worktree_merge)
    ws = wsub.add_parser("sync", help="Rebase the worktree branch onto the current project branch.")
    ws.add_argument("task_id")
    ws.add_argument("--target", default=None, help="Target branch (default: the project branch)")
    ws.set_defaults(func=cmd_worktree_sync)
    wt = sub.add_parser("team", help="The agent team that the board owns.")
    ttsub = wt.add_subparsers(dest="ttcmd", required=True)
    tti = ttsub.add_parser("install", help="Install the team as global OpenCode agents.")
    tti.add_argument("--actor", default="cli")
    tti.set_defaults(func=cmd_team_install)
    wr = wsub.add_parser("remove", help="Remove the worktree folder of a task.")
    wr.add_argument("task_id")
    wr.add_argument("--force", action="store_true", help="Remove even with uncommitted changes")
    wr.add_argument("--delete-branch", action="store_true", help="Also delete the branch")
    wr.set_defaults(func=cmd_worktree_remove)
    wl = wsub.add_parser("list", help="List worktrees of a project.")
    wl.add_argument("--project", default=None)
    wl.set_defaults(func=cmd_worktree_list)

    fp = sub.add_parser("feature", help="Feature groups: one worktree and branch for many tasks.")
    fsub = fp.add_subparsers(dest="fcmd", required=True)
    fc = fsub.add_parser("create", help="Create a feature (git worktree + branch).")
    fc.add_argument("--project", required=True)
    fc.add_argument("--title", required=True)
    fc.add_argument("--description", default="")
    fc.add_argument("--base", default=None, help="Base branch (default: the project branch)")
    fc.add_argument("--owner-session-id", default=None, help="Session that created the feature (the feature orchestrator)")
    fc.add_argument("--id", default=None)
    fc.add_argument("--actor", default="cli")
    fc.set_defaults(func=cmd_feature_create)
    fl = fsub.add_parser("list", help="List features.")
    fl.add_argument("--project", default=None)
    fl.set_defaults(func=cmd_feature_list)
    fs = fsub.add_parser("show", help="Show one feature with its tasks.")
    fs.add_argument("feature_id")
    fs.set_defaults(func=cmd_feature_show)
    fm = fsub.add_parser("merge", help="Merge the feature branch into the project branch (main).")
    fm.add_argument("feature_id")
    fm.add_argument("--target", default=None, help="Target branch (default: the project branch)")
    fm.set_defaults(func=cmd_feature_merge)
    fu = fsub.add_parser("update", help="Update a feature (status, merge note).")
    fu.add_argument("feature_id")
    fu.add_argument("--status", default=None, help="active | done | archived")
    fu.add_argument("--merge-note", default=None)
    fu.add_argument("--actor", default="cli")
    fu.set_defaults(func=cmd_feature_update)
    fd = fsub.add_parser("delete", help="Delete a feature. Its tasks stay on the board.")
    fd.add_argument("feature_id")
    fd.add_argument("--actor", default="cli")
    fd.set_defaults(func=cmd_feature_delete)

    tp = sub.add_parser("task", help="Task commands.")
    tsub = tp.add_subparsers(dest="tcmd", required=True)
    tc = tsub.add_parser("create", help="Create task (status defaults to backlog).")
    tc.add_argument("--project", required=True)
    tc.add_argument("--title", required=True)
    tc.add_argument("--description", default="")
    tc.add_argument("--status", default="backlog")
    tc.add_argument("--priority", default="medium")
    tc.add_argument("--id", default=None)
    tc.add_argument("--agent-id", default=None)
    tc.add_argument("--agent-name", default=None)
    tc.add_argument("--session-id", default=None)
    tc.add_argument("--model-id", default=None)
    tc.add_argument("--model-provider", default=None)
    tc.add_argument("--startup-phase", default=None)
    tc.add_argument("--startup-error", default=None)
    tc.add_argument("--kind", default=None, choices=("oneshot", "cyclic", "service", "goal"), help="Task kind: oneshot, cyclic, service, or goal")
    tc.add_argument("--expected-sec", type=int, default=None, help="Stall timeout in seconds for oneshot (default 600). Ignored for service.")
    tc.add_argument("--cycle-interval-sec", type=int, default=None)
    tc.add_argument("--progress", default=None, help="Free-text progress, e.g. 'step 3/10' or 'vite :5173 pid 1234'")
    tc.add_argument("--parent-session-id", default=None, help="Parent session that created this task (empty = user/board)")
    tc.add_argument("--parent-task-id", default=None, help="Parent task id. Automatic when omitted: the task that owns the parent session.")
    tc.add_argument("--result", default=None, help="Task result: last message + context on done/blocked")
    tc.add_argument("--result-context", default=None, help="Extra context for the task result")
    tc.add_argument("--acceptance-criteria", default=None, help="Optional acceptance criteria")
    tc.add_argument("--due-date", default=None, help="Optional due date (YYYY-MM-DD)")
    tc.add_argument("--blocked-by", default=None, help="Comma-separated predecessor task ids that must be done first (validated: exists, same project, no self/cycle)")
    tc.add_argument("--feature", default=None, help="Feature uuid: the task works in the feature worktree and branch")
    tc.add_argument("--actor", default="cli")
    tc.set_defaults(func=cmd_task_create)

    tl = tsub.add_parser("list", help="List tasks.")
    tl.add_argument("--project", default=None)
    tl.add_argument("--status", default=None)
    tl.add_argument("--agent", default=None)
    tl.add_argument("--json", action="store_true", default=True)
    tl.set_defaults(func=cmd_task_list)

    ts = tsub.add_parser("show", help="Show one task as JSON.")
    ts.add_argument("task_id")
    ts.set_defaults(func=cmd_task_show)

    tu = tsub.add_parser("update", help="Patch task fields.")
    tu.add_argument("task_id")
    tu.add_argument("--title", default=None)
    tu.add_argument("--description", default=None)
    tu.add_argument("--status", default=None)
    tu.add_argument("--priority", default=None)
    tu.add_argument("--agent-id", default=None)
    tu.add_argument("--agent-name", default=None)
    tu.add_argument("--session-id", default=None)
    tu.add_argument("--model-id", default=None)
    tu.add_argument("--model-provider", default=None)
    tu.add_argument("--startup-phase", default=None)
    tu.add_argument("--keep-startup-phase", action="store_true", default=False,
                    help="Keep the startup phase on a status change. Use it when the "
                         "session is already alive and must not be started again.")
    tu.add_argument("--startup-error", default=None)
    tu.add_argument("--kind", default=None, choices=("oneshot", "cyclic", "service", "goal"))
    tu.add_argument("--expected-sec", type=int, default=None)
    tu.add_argument("--cycle-interval-sec", type=int, default=None)
    tu.add_argument("--progress", default=None)
    tu.add_argument("--parent-session-id", default=None, help="Parent session that created this task (empty when created by user/board)")
    tu.add_argument("--result", default=None)
    tu.add_argument("--result-context", default=None)
    tu.add_argument("--acceptance-criteria", default=None)
    tu.add_argument("--due-date", default=None)
    tu.add_argument("--blocked-by", default=None, help="Comma-separated predecessor ids; '' clears the list (validated: exists, same project, no self/cycle)")
    tu.add_argument("--worktree-note", default=None, help="Note about the worktree (merge result, session loss, conflict)")
    tu.add_argument("--worktree-state", default=None, help="Worktree state: active | merged | conflict | pending | removed")
    tu.add_argument("--parent-task-id", default=None, help="Parent task id. Empty string clears the link.")
    tu.add_argument("--actor", default="cli")
    tu.set_defaults(func=cmd_task_update)

    tm = tsub.add_parser("move", help="Move task to a new status.")
    tm.add_argument("task_id")
    tm.add_argument("status")
    tm.add_argument("--comment", default=None)
    tm.add_argument("--actor", default="cli")
    tm.add_argument("--startup-phase", default=None,
                    help="Keep this startup phase. Use it when the caller starts the "
                         "task itself (a delegate), so the board does not start it a "
                         "second time while the session is still being set up.")
    tm.set_defaults(func=cmd_task_move)

    tb = tsub.add_parser("deps", help="Show dependency relations (blocked-by, dependents, readiness).")
    tb.add_argument("task_id")
    tb.set_defaults(func=cmd_task_deps)

    tch = tsub.add_parser("children", help="List the child tasks of a task.")
    tch.add_argument("task_id")
    tch.set_defaults(func=cmd_task_children)

    td = tsub.add_parser("delete", help="Delete task.")
    td.add_argument("task_id")
    td.add_argument("--actor", default="cli")
    td.set_defaults(func=cmd_task_delete)

    th = tsub.add_parser("heartbeat", help="Liveness ping: refresh heartbeat_at (+progress).")
    th.add_argument("task_id")
    th.add_argument("--progress", default=None)
    th.add_argument("--actor", default="agent")
    th.set_defaults(func=cmd_task_heartbeat)

    tw = tsub.add_parser("watch", help="Stall watchdog: oneshot+running with stale heartbeat -> blocked.")
    tw.add_argument("--default-timeout", type=int, default=600, help="Default stall limit in seconds when task has no --expected-sec.")
    tw.add_argument("--actor", default="watchdog")
    tw.set_defaults(func=cmd_task_watch)

    tn = tsub.add_parser("notify-pending", help="List finished tasks with a parent that are not yet delivered.")
    tn.add_argument("--limit", type=int, default=None, help="Cap rows returned.")
    tn.set_defaults(func=cmd_task_notify_pending)

    tm2 = tsub.add_parser("notify-mark", help="Stamp notified_at so these tasks stop being retried (idempotent).")
    tm2.add_argument("task_ids", nargs="+", help="One or more task ids to stamp.")
    tm2.add_argument("--actor", default="notifier")
    tm2.set_defaults(func=cmd_task_notify_mark)
    tm3 = tsub.add_parser("notify-unmark", help="Clear notified_at so the result is delivered again.")
    tm3.add_argument("task_ids", nargs="+", help="One or more task ids to clear.")
    tm3.add_argument("--actor", default="notifier")
    tm3.set_defaults(func=cmd_task_notify_unmark)

    ep = sub.add_parser("events", help="Event log.")
    esub = ep.add_subparsers(dest="ecmd", required=True)
    el = esub.add_parser("list", help="List events.")
    el.add_argument("--task", default=None)
    el.add_argument("--limit", type=int, default=50)
    el.set_defaults(func=cmd_events_list)

    args = parser.parse_args(argv)
    args.db = Path(args.db)
    args.func(args)


if __name__ == "__main__":
    main()
