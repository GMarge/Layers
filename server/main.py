"""Layers API. Run with: .venv/bin/python -m uvicorn server.main:app --port 8000"""

import json
import queue
import threading
from typing import Callable, Literal

from dotenv import load_dotenv

load_dotenv()  # reads .env, which is never committed

from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.responses import StreamingResponse  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from . import agent, db, policy, tools  # noqa: E402

app = FastAPI(title="Layers", docs_url=None, redoc_url=None)

# Agent runs the harness has paused, waiting for the employee's click. Keyed by prompt.
PAUSED: dict[str, dict] = {}

SEED_CHAT = [
    {"role": "user", "content": "Which five competitors should the Project X analysis cover? One line on each."},
    {"role": "assistant", "content": "These five cover the range: " + ", ".join(db.COMPETITORS) + "."},
]
# What the workspace model has been told so far, so follow-up questions make sense.
CHAT: list[dict] = list(SEED_CHAT)


WORKSPACE_PROMPT = (
    f"You are Fernhill AI, the company's work assistant. The employee is working on {db.PROJECT['name']} "
    f"({db.PROJECT['title']}). Answer clearly and briefly. Use short paragraphs, and simple lists where they "
    "help. Do not use LaTeX or tables."
)


def act_task(workflow_id: str) -> str:
    return (f"ACT: apply workflow {workflow_id} to {db.PROJECT['name']} for the employee.")

Prompt = Field(min_length=1, max_length=4000)


class PromptIn(BaseModel):
    prompt: str = Prompt


class Turn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=6000)


class ChatIn(BaseModel):
    prompt: str = Prompt
    # What this branch of the conversation has seen so far, oldest first.
    context: list[Turn] | None = Field(default=None, max_length=24)


class ApplyIn(BaseModel):
    workflow_id: str = Field(min_length=1, max_length=80)
    prompt: str = Prompt


class ApprovalIn(BaseModel):
    prompt: str = Prompt
    note: str = Field(default="", max_length=600)


class DecideIn(BaseModel):
    approved: bool


class FeedbackIn(BaseModel):
    kind: Literal["related", "override", "skipped-reuse", "unsure-allowed", "note"]
    prompt: str = Prompt
    note: str = Field(default="", max_length=600)


class SettingsIn(BaseModel):
    policy_mode: Literal["warn", "approval"]
    unsure_mode: Literal["ask", "allow", "defer"]


class UndoIn(BaseModel):
    artifact_id: str = Field(max_length=80)
    task_id: str = Field(max_length=20)


def stream(work: Callable[[Callable[[dict], None]], dict]) -> StreamingResponse:
    """Run `work` on a thread and send everything it emits to the browser as it happens."""
    events: queue.Queue = queue.Queue()

    def runner():
        try:
            events.put(work(events.put))
        except Exception as exc:
            db.audit("server", "error", str(exc))
            events.put({"type": "error", "message": "Layers hit a problem and stopped. Nothing was sent."})
        events.put(None)

    threading.Thread(target=runner, daemon=True).start()

    def body():
        while (item := events.get()) is not None:
            yield f"data: {json.dumps(item)}\n\n"

    return StreamingResponse(body(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


def rule(rule_id: str) -> dict:
    return db.query("SELECT * FROM rules WHERE id = ?", (rule_id,))[0]


def best_workflow(prompt: str) -> dict | None:
    found = json.loads(tools.search_org_memory(prompt))
    return found[0] if found else None


@app.get("/api/health")
def health():
    return {"ok": True, **agent.status()}


@app.post("/api/reset")
def reset():
    db.reset()
    PAUSED.clear()
    CHAT[:] = SEED_CHAT
    return {"ok": True}


@app.post("/api/settings")
def settings(body: SettingsIn):
    for key, value in body.model_dump().items():
        db.execute("INSERT OR REPLACE INTO settings VALUES (?, ?)", (key, value))
    db.audit("company", "settings", body.model_dump())
    return {"ok": True}


@app.post("/api/preflight")
def preflight(body: PromptIn):
    """Runs when the employee presses Send. Decides whether the prompt may go to the workspace model."""
    prompt = body.prompt.strip()

    def work(emit):
        screen = policy.screen(prompt)
        if screen["kind"] == "pass":
            policy.record(prompt, "pass", True, "On project.", "gate")
            emit({"type": "progress", "engaged": False})
            return {"type": "verdict", "verdict": {"kind": "pass"}}

        def note(event):  # each tool call shows up as a line of plain English
            if event["type"] == "step" and event["step"]["status"] == "running":
                emit({"type": "progress", "engaged": True, "note": event["step"]["label"]})

        scratch = tools.start_run(note)
        try:
            kind, reason, workflow = screen["kind"], screen["reason"], None
            if kind == "review":  # if the agent cannot be reached, do not guess: ask
                kind = "unsure"
            decided_by = "gate"
            supervisor = agent.get()
            if supervisor:
                try:
                    recent = "\n".join(f"{m['role']}: {m['content'][:300]}" for m in CHAT[-4:])
                    agent.run(supervisor,
                              f"REVIEW this prompt the employee tried to send:\n<prompt>\n{prompt}\n</prompt>\n"
                              f"The conversation so far, for context only:\n<conversation>\n{recent}\n</conversation>")
                    scratch = tools._scratch
                    said = scratch.get("verdict")
                    # The model may explain and refine, but it cannot clear what the rules flagged.
                    if said and not (screen["kind"] == "policy" and said["kind"] in ("pass", "reuse")):
                        kind, reason, decided_by = said["kind"], said["reason"] or reason, "agent"
                        workflow = said.get("workflow_id") or None
                except Exception as exc:
                    db.audit("server", "agent_failed", str(exc))
            else:
                tools.get_project_context()
                tools.check_company_policy(prompt)

            if kind == "reuse":
                row = tools._workflow_row(workflow) if workflow else None
                item = tools.workflow_public(row) if row and tools._can_use(row) else best_workflow(prompt)
                if not item:
                    kind = "pass"
                else:
                    policy.record(prompt, "reuse", False, reason, decided_by)
                    if supervisor:
                        # Start the work now. The harness stops the agent just before it creates
                        # anything, and holds it there until the employee decides.
                        steps: list[dict] = []

                        def keep(event):
                            note(event)
                            if event["type"] == "step" and event["step"]["status"] != "running":
                                steps.append(event)

                        tools.start_run(keep)
                        thread = f"apply-{len(PAUSED)}-{abs(hash(prompt))}"
                        try:
                            _, paused = agent.run(supervisor, act_task(item["id"]), thread)
                            if paused:
                                PAUSED[prompt] = {"thread": thread, "workflow": item["id"], "steps": steps}
                                db.audit("harness", "paused_for_approval", {"workflow": item["id"]})
                        except Exception as exc:
                            db.audit("server", "agent_failed", str(exc))
                    return {"type": "verdict", "verdict": {
                        "kind": "reuse", "item": item,
                        "reason": f"{item['author']} already built a workflow for this."}}
            if kind == "pass":
                policy.record(prompt, "pass", True, reason or "On project.", decided_by)
                return {"type": "verdict", "verdict": {"kind": "pass"}}

            policy.record(prompt, kind, False, reason, decided_by)
            return {"type": "verdict", "verdict": {
                "kind": kind, "rule": rule("AI-01"), "reason": reason, "signals": screen["signals"]}}
        finally:
            tools.end_run()

    return stream(work)


@app.post("/api/apply")
def apply(body: ApplyIn):
    """The employee chose to reuse a team workflow. Do it, and report every step as it happens."""

    def work(emit):
        scratch = tools.start_run(emit)
        try:
            supervisor = agent.get()
            if supervisor:
                try:
                    held = PAUSED.pop(body.prompt.strip(), None)
                    if held and held["workflow"] == body.workflow_id:
                        for event in held["steps"]:  # what the agent did before it paused
                            emit(event)
                        thread, paused = held["thread"], True
                        scratch["access_ok"] = body.workflow_id
                    else:
                        thread = f"apply-now-{id(scratch)}"
                        _, paused = agent.run(supervisor, act_task(body.workflow_id), thread)
                    if paused:
                        # The employee's click is the approval the harness was waiting for.
                        db.audit(db.EMPLOYEE["name"], "approved_paused_action", {"workflow": body.workflow_id})
                        emit({"type": "step", "step": {
                            "id": f"approval-{thread}", "tool": "human_approval", "status": "done",
                            "label": "Paused until you approved", "detail": f"approved by {db.EMPLOYEE['name']}"}})
                        agent.resume(supervisor, thread, True)
                except Exception as exc:
                    db.audit("server", "agent_failed", str(exc))
            # Whatever the model did or skipped, finish the job in order and never skip the access check.
            if "artifact_id" not in scratch:
                if not scratch.get("access_ok"):
                    tools.check_access(body.workflow_id)
                if not scratch.get("access_ok"):
                    return {"type": "error", "message": "You do not have access to that workflow."}
                tools.create_project_artifact(body.workflow_id)
            if "task_id" not in scratch:
                tools.update_task_status("t3", "doing")
            if "artifact_id" not in scratch:
                return {"type": "error", "message": "The sheet could not be created."}

            art = db.query("SELECT * FROM artifacts WHERE id = ?", (scratch["artifact_id"],))[0]
            policy.record(body.prompt, "reuse", False, "Reused a team workflow instead of sending.", "employee")
            return {
                "type": "result",
                "summary": f"Comparison sheet added to {db.PROJECT['name']}.",
                "detail": f"The {len(db.COMPETITORS)} competitors from this project are filled in. "
                          '"Build comparison spreadsheet" is now in progress.',
                "taskId": "t3",
                "artifact": {"id": art["id"], "title": art["title"], "source": art["source"],
                             "author": art["author"], "columns": json.loads(art["columns"]),
                             "rows": json.loads(art["rows"])},
            }
        finally:
            tools.end_run()

    return stream(work)


@app.post("/api/undo")
def undo(body: UndoIn):
    db.execute("DELETE FROM artifacts WHERE id = ?", (body.artifact_id,))
    db.execute("UPDATE tasks SET status = 'todo' WHERE id = ?", (body.task_id,))
    db.audit(db.EMPLOYEE["name"], "undo", body.model_dump())
    return {"ok": True}


@app.post("/api/ask")
def ask(body: PromptIn):
    """A question to Layers itself. Nothing here goes to the workspace model."""
    question = body.prompt.strip()
    low = question.lower()
    screen = policy.screen(question)
    answer: dict
    tools.start_run(None)
    try:
        if any(w in low for w in ("limit", "allowed", "rule", "policy", "what can i")):
            answer = {"text": f"Two rules apply to you in this workspace. Anything tied to "
                              f"{db.PROJECT['name']} goes straight through.", "showLimits": True}
        elif any(w in low for w in ("built", "already", "existing", "template", "workflow", "matrix",
                                    "spreadsheet", "reuse", "anyone")):
            item = best_workflow(question)
            answer = ({"text": f"Yes. {item['author']} built one, it is approved, and you have access.", "item": item}
                      if item else {"text": "I looked through your team's approved workflows and nothing fits that yet."})
        elif screen["kind"] == "policy" or any(w in low for w in ("personal", "travel", "side project", "my own")):
            answer = {"text": f"Not in this workspace. It is kept for assigned project work, and that falls "
                              f"outside {db.PROJECT['name']}. I can ask {db.MANAGER.split()[0]} for an exception.",
                      "rule": rule("AI-01"), "canRequest": True}
        elif screen["signals"]["fits"]:
            answer = {"text": f"Yes. That is part of {db.PROJECT['name']}, so it will go straight through."}
        else:
            answer = {"text": "I can answer questions about your project, the workspace rules and what your "
                              "team has already built."}
            supervisor = agent.get()
            if supervisor:
                try:
                    said, _ = agent.run(supervisor, "The employee asks you, before sending anything: "
                                                 f"<question>{question}</question> Answer in two sentences.")
                    if said:
                        answer = {"text": said}
                except Exception as exc:
                    db.audit("server", "agent_failed", str(exc))
    finally:
        tools.end_run()
    db.audit(db.EMPLOYEE["name"], "ask", {"question": question[:200], "answer": answer["text"][:200]})
    return answer


@app.post("/api/approvals")
def create_approval(body: ApprovalIn):
    tools.start_run(None)
    try:
        tools.request_manager_approval(body.prompt.strip(), body.note)
        request_id = tools._scratch["request_id"]
    finally:
        tools.end_run()
    return {"id": request_id, "approver": db.MANAGER}


@app.get("/api/approvals")
def list_approvals():
    return db.query("SELECT id, prompt, note, status, approver FROM approvals ORDER BY id DESC")


@app.post("/api/approvals/{request_id}/decide")
def decide(request_id: str, body: DecideIn):
    """The manager's answer. Only this, never the model, can approve a held prompt."""
    number = request_id.removeprefix("EX-")
    if not number.isdigit():
        raise HTTPException(404, "No such request.")
    rows = db.query("SELECT * FROM approvals WHERE id = ?", (int(number),))
    if not rows:
        raise HTTPException(404, "No such request.")
    status = "approved" if body.approved else "declined"
    db.execute("UPDATE approvals SET status = ? WHERE id = ?", (status, int(number)))
    policy.record(rows[0]["prompt"], f"manager-{status}", body.approved, f"{db.MANAGER} {status} it.", db.MANAGER)
    return {"ok": True, "status": status}


@app.post("/api/feedback")
def feedback(body: FeedbackIn):
    """The employee's side of a decision. What it unlocks depends on what the company allows."""
    prompt = body.prompt.strip()
    db.execute("INSERT INTO feedback (kind, prompt, created_at) VALUES (?, ?, strftime('%s','now'))",
               (body.kind, prompt))
    policy_mode, unsure_mode = db.setting("policy_mode"), db.setting("unsure_mode")
    allowed, learned = False, []
    if body.kind in ("override", "related") and policy_mode == "warn":
        allowed = True
    elif body.kind == "note" and unsure_mode == "ask":
        allowed = True
    elif body.kind == "unsure-allowed" and unsure_mode == "allow":
        allowed = True
    elif body.kind == "skipped-reuse":
        allowed = True
    if body.kind in ("related", "note"):
        learned = policy.learn_from(prompt)
    if allowed:
        reason = body.note or f"Employee chose: {body.kind}."
        policy.record(prompt, f"employee-{body.kind}", True, reason, db.EMPLOYEE["name"])
    return {"allowed": allowed, "learned": learned}


@app.post("/api/chat")
def chat(body: ChatIn):
    """The workspace model. A prompt only gets here with an allowing decision on record."""
    prompt = body.prompt.strip()
    if not policy.may_send(prompt):
        db.audit("gate", "blocked_send", prompt[:200])
        raise HTTPException(403, "Layers has not cleared this prompt.")
    if not agent.MODEL:
        return {"text": "Layers cleared this prompt. No workspace model is connected yet, so there is no answer to show.",
                "placeholder": True}
    try:
        from langchain.chat_models import init_chat_model

        agent.spend_run()
        CHAT.append({"role": "user", "content": prompt})
        seen = [t.model_dump() for t in body.context] if body.context is not None else CHAT[-24:-1]
        reply = init_chat_model(agent.MODEL).invoke(
            [{"role": "system", "content": WORKSPACE_PROMPT}, *seen, {"role": "user", "content": prompt}])
        text = reply.content
        if isinstance(text, list):  # some providers answer in content blocks
            text = "".join(part.get("text", "") for part in text if isinstance(part, dict))
        CHAT.append({"role": "assistant", "content": text})
        return {"text": text, "placeholder": False}
    except Exception as exc:
        db.audit("server", "chat_failed", str(exc))
        return {"text": "Layers cleared this prompt, but the workspace model did not answer.", "placeholder": True}


@app.get("/api/approvals/{request_id}")
def approval_status(request_id: str):
    number = request_id.removeprefix("EX-")
    rows = db.query("SELECT status FROM approvals WHERE id = ?", (int(number),)) if number.isdigit() else []
    if not rows:
        raise HTTPException(404, "No such request.")
    return {"status": rows[0]["status"]}


@app.get("/api/manager")
def manager():
    """What the manager sees. Prompts appear only when the employee sent them for approval.
    Everything else is shown as counts and outcomes, never as text."""
    first = db.EMPLOYEE["name"].split()[0]
    pending = []
    for row in db.query("SELECT * FROM approvals WHERE status = 'pending' ORDER BY id DESC"):
        screen = policy.screen(row["prompt"])
        why = db.query("SELECT reason FROM decisions WHERE prompt = ? AND allowed = 0 ORDER BY id DESC LIMIT 1",
                       (row["prompt"],))
        pending.append({"id": f"EX-{row['id']:04d}", "prompt": row["prompt"], "note": row["note"],
                        "reason": why[0]["reason"] if why else screen["reason"], "signals": screen["signals"],
                        "from": db.EMPLOYEE["name"], "at": row["created_at"]})

    feed = []
    for a in db.query("SELECT ts, actor, action, detail FROM audit ORDER BY id DESC LIMIT 200"):
        action, text = a["action"], None
        if action == "tool:create_project_artifact":
            text = f"{first} reused a team workflow. A comparison sheet was added to {db.PROJECT['name']}."
        elif action == "tool:request_manager_approval":
            text = f"{first} asked for your approval."
        elif action == "decision:manager-approved":
            text = "You approved a request."
        elif action == "decision:manager-declined":
            text = "You declined a request."
        elif action == "decision:policy":
            text = "Layers held a prompt under rule AI-01."
        elif action == "decision:unsure":
            text = "Layers was not sure about a prompt and asked before sending."
        elif action == "decision:employee-note":
            text = f"{first} explained an unclear prompt and sent it."
        elif action == "decision:employee-override":
            text = f"{first} sent a prompt after a warning. It is logged as an exception."
        elif action == "undo":
            text = f"{first} undid a reused workflow."
        if text:
            feed.append({"ts": a["ts"], "text": text})

    def count(where: str) -> int:
        return db.query(f"SELECT COUNT(*) AS n FROM decisions WHERE {where}")[0]["n"]

    return {
        "manager": db.MANAGER, "employee": db.EMPLOYEE, "project": db.PROJECT,
        "pending": pending, "feed": feed[:12],
        "tasks": db.query("SELECT id, title, status FROM tasks"),
        "counts": {
            "checked": count("decided_by IN ('gate', 'agent')"),
            "passed": count("decided_by IN ('gate', 'agent') AND allowed = 1"),
            "held": count("verdict IN ('policy', 'unsure')"),
            "reused": db.query("SELECT COUNT(*) AS n FROM artifacts")[0]["n"],
        },
    }


@app.get("/api/audit")
def audit_log():
    return db.query("SELECT ts, actor, action, detail FROM audit ORDER BY id DESC LIMIT 100")
