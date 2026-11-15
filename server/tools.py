"""The only things the Layers agent can do. Each is a small function over the database.

Who is asking is fixed on the server (db.EMPLOYEE). No tool takes an identity from the
model, so a prompt cannot talk its way into another team's work. Every call is timed,
reported to the interface as it happens, and written to the audit log.
"""

import json
import threading
import time
import uuid
from typing import Callable

from . import db, policy

# What each tool call looks like to the employee, in plain English.
LABELS = {
    "get_project_context": "Reading the Project X brief",
    "check_company_policy": "Checking the workspace rules",
    "search_org_memory": "Searching your team's approved workflows",
    "check_access": "Confirming you are allowed to use it",
    "create_project_artifact": "Building the Project X comparison sheet",
    "update_task_status": "Updating your Project X tasks",
    "request_manager_approval": f"Asking {db.MANAGER} to take a look",
    "submit_verdict": "Deciding what to do with this prompt",
}

# One run at a time reports its tool calls to the interface. This is a single-user demo.
_sink_lock = threading.Lock()
_sink: Callable[[dict], None] | None = None
_scratch: dict = {}


def start_run(sink: Callable[[dict], None] | None) -> dict:
    global _sink, _scratch
    with _sink_lock:
        _sink = sink
        _scratch = {"calls": []}
    return _scratch


def end_run() -> None:
    global _sink
    with _sink_lock:
        _sink = None


def _traced(name: str, fn: Callable[[], tuple[object, str]]) -> object:
    """Run a tool body, report it live with its measured duration, and audit it."""
    step_id = f"{name}-{uuid.uuid4().hex[:6]}"
    label = LABELS.get(name, name)
    if _sink:
        _sink({"type": "step", "step": {"id": step_id, "tool": name, "label": label, "status": "running"}})
    started = time.perf_counter()
    try:
        result, detail = fn()
        status = "done"
    except Exception as exc:  # the agent sees the error text and can react to it
        result, detail, status = f"Error: {exc}", str(exc), "error"
    ms = round((time.perf_counter() - started) * 1000)
    _scratch.setdefault("calls", []).append(name)
    db.audit("layers-agent", f"tool:{name}", {"detail": detail, "ms": ms, "status": status})
    if _sink:
        _sink({"type": "step", "step": {"id": step_id, "tool": name, "label": label,
                                        "status": status, "detail": detail, "ms": ms}})
    return result


def _workflow_row(workflow_id: str) -> dict | None:
    rows = db.query("SELECT * FROM workflows WHERE id = ? OR name = ?", (workflow_id, workflow_id))
    return rows[0] if rows else None


def _can_use(row: dict) -> bool:
    return db.EMPLOYEE["team"] in json.loads(row["shared_with"])


def workflow_public(row: dict) -> dict:
    return {
        "id": row["id"], "name": row["name"], "kind": row["kind"], "summary": row["summary"],
        "author": row["author"], "team": row["team"], "reviewedOn": row["reviewed_on"],
        "approvedBy": row["approved_by"], "access": row["access"],
        "columns": json.loads(row["columns"]), "inputs": row["inputs"],
    }


def get_project_context() -> str:
    """Return the employee's assigned project: its brief, tasks and due date."""
    def body():
        tasks = db.query("SELECT id, title, status FROM tasks")
        ctx = {"employee": db.EMPLOYEE, "project": db.PROJECT, "tasks": tasks,
               "competitors": db.COMPETITORS,
               "brief": "Research five competitors, analyze findings, build a comparison spreadsheet, "
                        "draft a presentation."}
        return json.dumps(ctx), f"{db.PROJECT['name']}, {len(tasks)} tasks"
    return _traced("get_project_context", body)


def check_company_policy(prompt: str) -> str:
    """Check a prompt against the workspace rules. Returns the rule screen's finding and the rules."""
    def body():
        finding = policy.screen(prompt)
        rules = db.query("SELECT id, name, text FROM rules")
        return json.dumps({"finding": finding, "rules": rules}), f"screen says {finding['kind']}"
    return _traced("check_company_policy", body)


def search_org_memory(query: str) -> str:
    """Search approved team workflows the employee is allowed to see. Returns matches, best first."""
    def body():
        words = [w for w in query.lower().replace("_", " ").split() if len(w) > 3]
        matches = []
        for row in db.query("SELECT * FROM workflows"):
            if not _can_use(row):  # permission filter happens here, in code, before the model sees anything
                continue
            hay = f"{row['name']} {row['summary']} {row['columns']}".lower()
            score = sum(1 for w in words if w[:6] in hay)
            if score:
                matches.append((score, workflow_public(row)))
        matches.sort(key=lambda m: -m[0])
        found = [m[1] for m in matches]
        return json.dumps(found), (found[0]["name"] if found else "nothing found")
    return _traced("search_org_memory", body)


def check_access(workflow_id: str) -> str:
    """Confirm the employee may use a workflow. Always call this before creating anything from it."""
    def body():
        row = _workflow_row(workflow_id)
        if not row:
            return "No such workflow.", "not found"
        ok = _can_use(row)
        _scratch["access_ok"] = row["id"] if ok else None
        return ("Allowed. " if ok else "Not allowed. ") + row["access"], row["access"].lower()
    return _traced("check_access", body)


def create_project_artifact(workflow_id: str) -> str:
    """Create a Project X comparison sheet from an approved workflow, filled with the project's competitors."""
    def body():
        row = _workflow_row(workflow_id)
        if not row or not _can_use(row):
            raise PermissionError("That workflow is not shared with this employee.")
        columns = json.loads(row["columns"])
        rows = [[name] + [""] * (len(columns) - 1) for name in db.COMPETITORS]
        artifact_id = f"sheet-{uuid.uuid4().hex[:8]}"
        db.execute("INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?)",
                   (artifact_id, f"{db.PROJECT['name']} competitor matrix", row["name"], row["author"],
                    json.dumps(columns), json.dumps(rows), time.time()))
        _scratch["artifact_id"] = artifact_id
        return f"Created {artifact_id}.", f"{len(rows)} rows, {len(columns)} columns"
    return _traced("create_project_artifact", body)


def update_task_status(task_id: str, status: str) -> str:
    """Set a Project X task to todo, doing or done. The spreadsheet task is t3."""
    def body():
        if status not in ("todo", "doing", "done"):
            raise ValueError("status must be todo, doing or done")
        rows = db.query("SELECT title FROM tasks WHERE id = ?", (task_id,))
        if not rows:
            raise ValueError("no such task")
        db.execute("UPDATE tasks SET status = ? WHERE id = ?", (status, task_id))
        _scratch["task_id"] = task_id
        return f"{rows[0]['title']} is now {status}.", f"{rows[0]['title'].lower()}: {status}"
    return _traced("update_task_status", body)


def request_manager_approval(prompt: str, reason: str) -> str:
    """Ask the employee's manager to approve a prompt. Creates a pending request a person must answer."""
    def body():
        cur = db.execute("INSERT INTO approvals (prompt, note, status, approver, created_at) "
                         "VALUES (?, ?, 'pending', ?, ?)", (prompt, reason, db.MANAGER, time.time()))
        request_id = f"EX-{cur.lastrowid:04d}"
        _scratch["request_id"] = request_id
        return f"Request {request_id} is pending with {db.MANAGER}.", request_id
    return _traced("request_manager_approval", body)


def submit_verdict(kind: str, reason: str, workflow_id: str = "") -> str:
    """Give your finding on a prompt. kind is one of: pass, policy, unsure, reuse.
    reason is one or two plain sentences for the employee. For reuse, give the workflow_id."""
    def body():
        if kind not in ("pass", "policy", "unsure", "reuse"):
            raise ValueError("kind must be pass, policy, unsure or reuse")
        _scratch["verdict"] = {"kind": kind, "reason": reason.strip(), "workflow_id": workflow_id}
        return "Recorded.", kind
    return _traced("submit_verdict", body)


REVIEW_TOOLS = [get_project_context, check_company_policy, search_org_memory, submit_verdict]
ACTION_TOOLS = [search_org_memory, check_access, create_project_artifact, update_task_status,
                request_manager_approval]
