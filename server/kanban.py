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
  Project { id: uuid, name, path, description, agentIds[], createdAt }

Storage: SQLite file shared between host, Vite dev server, and Docker
via the /work bind mount:
  host:      <repo>/.kanban-data/kanban.db
  container: /work/kanban-clone/.kanban-data/kanban.db
Env override: KANBAN_DB (explicit file) or KANBAN_DATA_DIR (directory).

Usage:
  python server/kanban.py init
  python server/kanban.py project create --name "X" --path "C:/..." [--id <uuid>]
  python server/kanban.py project list
  python server/kanban.py task create --project <projectId> --title "T" [--description D] [--priority high] [--agent-id A] [--id <uuid>]
  python server/kanban.py task list --project <projectId> [--status running]
  python server/kanban.py task show <taskId>
  python server/kanban.py task update <taskId> [--title T] [--description D] [--priority P] [--agent-id A] [--agent-name N] [--session-id S] [--model-id M] [--model-provider P]
  python server/kanban.py task move <taskId> <backlog|running|done|blocked>
  python server/kanban.py task delete <taskId>
  python server/kanban.py events list [--task <taskId>] [--limit 50]

All write commands print JSON to stdout (machine-readable for MCP/Vite).
Human-readable errors go to stderr with non-zero exit.
"""

import argparse
import json
import os
import sqlite3
import sys
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
for _k in ("KANBAN_PROJECTS_ROOT",):
    # Load .env manually so kanban.py works even when not launched via vite.
    _envp = REPO / ".env"
    if _envp.exists() and not os.getenv(_k):
        try:
            for _line in _envp.read_text(encoding="utf-8").splitlines():
                _line = _line.strip()
                if _line and not _line.startswith("#") and "=" in _line:
                    _kk, _vv = _line.split("=", 1)
                    if _kk.strip() == _k and _vv.strip():
                        os.environ[_k] = _vv.strip()
        except Exception:
            pass

VALID_STATUSES = ("backlog", "running", "done", "blocked")
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
    agent_ids TEXT NOT NULL DEFAULT '[]',
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
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);

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
    pcols = {r[1] for r in conn.execute("PRAGMA table_info(projects)").fetchall()}
    for col, ddl in (
        ("agent_ids", "TEXT NOT NULL DEFAULT '[]'"),
        ("folder", "TEXT NOT NULL DEFAULT ''"),
        ("git_url", "TEXT"),
        ("git_branch", "TEXT NOT NULL DEFAULT 'main'"),
    ):
        if col not in pcols:
            conn.execute(f"ALTER TABLE projects ADD COLUMN {col} {ddl}")
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


def row_to_task(r: sqlite3.Row) -> dict:
    return {
        "id": r["id"],
        "projectId": r["project_id"],
        "title": r["title"],
        "description": r["description"] or "",
        "status": r["status"],
        "priority": r["priority"],
        "agentId": r["agent_id"],
        "agentName": r["agent_name"],
        "sessionId": r["session_id"],
        "modelId": r["model_id"],
        "modelProviderID": r["model_provider_id"],
        "startupPhase": r["startup_phase"] if "startup_phase" in r.keys() else None,
        "startupError": r["startup_error"] if "startup_error" in r.keys() else None,
        "createdAt": r["created_at"],
        "updatedAt": r["updated_at"],
    }


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
    conn.execute(
        "INSERT INTO projects (id, name, path, folder, git_url, git_branch, description, agent_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (pid, args.name, path, folder, getattr(args, "git_url", None),
         getattr(args, "git_branch", None) or "main",
         args.description or "", json.dumps(args.agent_ids or []), now_iso()),
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
    ts = now_iso()
    conn.execute(
        """INSERT INTO tasks (id, project_id, title, description, status, priority,
                              agent_id, agent_name, session_id, model_id, model_provider_id,
                              startup_phase, startup_error,
                              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (tid, args.project, args.title, args.description or "", status, priority,
         args.agent_id, args.agent_name, args.session_id,
         args.model_id, args.model_provider,
         args.startup_phase, args.startup_error, ts, ts),
    )
    log_event(conn, tid, args.actor, "task.created",
              {"projectId": args.project, "title": args.title, "status": status})
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
    ]
    for col, val in mapping:
        if val is not None:
            sets.append(f"{col} = ?")
            params.append(val)
            changes[col] = val
    if args.priority is not None:
        sets.append("priority = ?")
        params.append(require_priority(args.priority))
        changes["priority"] = args.priority
    if args.status is not None:
        sets.append("status = ?")
        params.append(require_status(args.status))
        changes["status"] = args.status
    if not sets:
        fail("Nothing to update. Pass --title/--description/--status/--priority/...")
    sets.append("updated_at = ?")
    params.append(now_iso())
    params.append(args.task_id)
    conn.execute(f"UPDATE tasks SET {', '.join(sets)} WHERE id = ?", params)
    log_event(conn, args.task_id, args.actor, "task.edited", changes)
    conn.commit()
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (args.task_id,)).fetchone()
    print(json.dumps(row_to_task(row), indent=2))
    conn.close()


def cmd_task_move(args):
    conn = get_conn(args.db)
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (args.task_id,)).fetchone()
    if not row:
        fail(f"Task not found: {args.task_id}")
    status = require_status(args.status)
    old = row["status"]
    conn.execute("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?",
                 (status, now_iso(), args.task_id))
    log_event(conn, args.task_id, args.actor, "task.moved",
              {"from": old, "to": status, "comment": args.comment})
    conn.commit()
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (args.task_id,)).fetchone()
    print(json.dumps(row_to_task(row), indent=2))
    conn.close()


def cmd_task_delete(args):
    conn = get_conn(args.db)
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (args.task_id,)).fetchone()
    if not row:
        fail(f"Task not found: {args.task_id}")
    conn.execute("DELETE FROM tasks WHERE id = ?", (args.task_id,))
    log_event(conn, None, args.actor, "task.deleted",
              {"id": args.task_id, "title": row["title"]})
    conn.commit()
    print(json.dumps({"ok": True, "deleted": args.task_id}))
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
    tu.add_argument("--startup-error", default=None)
    tu.add_argument("--actor", default="cli")
    tu.set_defaults(func=cmd_task_update)

    tm = tsub.add_parser("move", help="Move task to a new status.")
    tm.add_argument("task_id")
    tm.add_argument("status")
    tm.add_argument("--comment", default=None)
    tm.add_argument("--actor", default="cli")
    tm.set_defaults(func=cmd_task_move)

    td = tsub.add_parser("delete", help="Delete task.")
    td.add_argument("task_id")
    td.add_argument("--actor", default="cli")
    td.set_defaults(func=cmd_task_delete)

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
