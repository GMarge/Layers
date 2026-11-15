"""Layers API. Run with: .venv/bin/python -m uvicorn server.main:app --port 8000"""

import json
import queue
import re
import threading
import uuid
from typing import Callable, Literal

from dotenv import load_dotenv

load_dotenv()  # reads .env, which is never committed

import os  # noqa: E402

# Tracing switches on only when a LangSmith key has been provided.
if os.environ.get("LANGSMITH_API_KEY", "").strip():
    os.environ.setdefault("LANGSMITH_TRACING", "true")
else:
    os.environ["LANGSMITH_TRACING"] = "false"

from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.responses import StreamingResponse  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from . import agent, db, policy, tools  # noqa: E402

app = FastAPI(title="Layers", docs_url=None, redoc_url=None)

# Agent runs the harness has paused, waiting for the employee's click. Keyed by prompt.
PAUSED: dict[str, dict] = {}
# Status updates the agent has drafted and is paused on, keyed by the run's thread.
DRAFTS: dict[str, dict] = {}

SEED_CHAT = [
    {"role": "user", "content": "Which five competitors should the Project X analysis cover? One line on each."},
    {"role": "assistant", "content": "These five cover the range: " + ", ".join(db.COMPETITORS) + "."},
]
# What the workspace model has been told so far, so follow-up questions make sense.
CHAT: list[dict] = list(SEED_CHAT)


WORKSPACE_PROMPT = (
    f"You are the work assistant at {db.COMPANY}. The employee is working on {db.PROJECT['name']} "
    f"({db.PROJECT['title']}). Answer clearly and briefly. Use short paragraphs, and simple lists where they "
    "help. Do not use LaTeX or tables."
)


# The four parts of the project a conversation can be on. The branch map names these and
# nothing else, so a line about anything off the brief reaches the manager as "Other direction".
TOPIC_LABELS = {"research": "Competitor research", "analysis": "Analysis",
                "sheet": "Comparison spreadsheet", "deck": "Presentation"}


TOPIC_IDS = {label.lower(): key for key, label in TOPIC_LABELS.items()}
# The project task each area of the conversation works towards.
TOPIC_TASKS = {"research": "t1", "analysis": "t2", "sheet": "t3", "deck": "t4"}


def clean_label(text: str) -> str:
    """A direction's name as plain words. It goes into the agent's task, so nothing else gets in."""
    return " ".join(re.sub(r"[^A-Za-z0-9 ]", " ", text).split())[:40]


def topic_of(said: dict | None, current: str = "") -> tuple[bool, dict | None]:
    """What the agent said a prompt is about, as the branch map wants it. Returns (judged, hint).
    A hint of None means the prompt carries on with what the conversation was doing."""
    raw = clean_label(str((said or {}).get("topic", ""))).lower()
    if not raw:
        return False, None
    if raw in ("same", "none", "continue", "follow up", "current") or raw == current.lower():
        return True, None
    key = raw if raw in TOPIC_LABELS else TOPIC_IDS.get(raw)
    if key:
        return True, {"id": key, "label": TOPIC_LABELS[key]}
    words = raw.split()[:3]
    return True, {"id": "x-" + "-".join(words), "label": " ".join(words).capitalize()}


def task_for(workflow_id: str) -> str:
    """The project task a workflow moves along when it is applied."""
    row = tools._workflow_row(workflow_id)
    return tools.plan_of(row)["task"] if row else "t3"


def said_phrases(text: object, prompt: str) -> list[str]:
    """The words the agent says counted, kept only if they really are in the prompt."""
    low = prompt.lower()
    found = []
    for part in re.split(r"[;\n]", str(text or "")):
        phrase = " ".join(part.strip(" \"'.,").split())
        if phrase and len(phrase) <= 48 and phrase.lower() in low and phrase.lower() not in (f.lower() for f in found):
            found.append(phrase)
    return found[:3]


def said_part(text: object, prompt: str) -> str:
    """The agent's cut-down prompt, kept only if it is a real part of what the employee wrote:
    shorter than the prompt, and made almost entirely of the prompt's own words."""
    part = " ".join(str(text or "").split()).strip(" \"'")
    if not part or len(part) >= len(prompt.strip()):
        return ""
    theirs = set(re.findall(r"[a-z0-9']+", prompt.lower()))
    words = re.findall(r"[a-z0-9']+", part.lower())
    if len(words) < 2 or sum(w in theirs for w in words) < 0.8 * len(words):
        return ""
    return part[:400]


def act_task(workflow_id: str) -> str:
    return (f"ACT: apply workflow {workflow_id} to {db.PROJECT['name']} for the employee. "
            f"The task it moves along is {task_for(workflow_id)}.")

Prompt = Field(min_length=1, max_length=4000)


class PromptIn(BaseModel):
    prompt: str = Prompt


class PreflightIn(PromptIn):
    # Where the conversation is, by name, so the agent can say whether this prompt leaves it.
    current: str | None = Field(default=None, max_length=60)
    others: list[str] = Field(default_factory=list, max_length=12)


class BranchPromptIn(BaseModel):
    n: int = Field(ge=0, le=2000)
    text: str = Field(max_length=300)


class BranchIn(BaseModel):
    """One branch of the employee's own conversation, sent with a question so their agent can
    look through it. It is used for that one answer and not kept."""
    id: str = Field(pattern=r"^[a-z0-9]{1,12}$")
    label: str = Field(max_length=60)
    kind: Literal["main", "implicit", "explicit"]
    prompts: list[BranchPromptIn] = Field(max_length=80)


class AskIn(PromptIn):
    branches: list[BranchIn] | None = Field(default=None, max_length=40)


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
    # Who changed it: the manager from their page, or the design lab on the demo workspace.
    actor: Literal["manager", "lab"] = "lab"


class UndoIn(BaseModel):
    artifact_id: str = Field(max_length=80)
    task_id: str = Field(max_length=20)


LINE_ID = r"^[a-z0-9]{1,12}$"


class LineIn(BaseModel):
    id: str = Field(pattern=LINE_ID)
    kind: Literal["main", "implicit", "explicit"]
    parent: str | None = Field(default=None, pattern=LINE_ID)
    fork: int | None = Field(default=None, ge=-1, le=2000)
    topic: str | None = Field(default=None, max_length=24)
    merged: bool = False
    promoted: bool = False


class NodeIn(BaseModel):
    line: str = Field(pattern=LINE_ID)
    reopened: bool = False
    visit: int = Field(default=1, ge=1, le=99)
    at: float | None = None  # when it was sent


class StopIn(BaseModel):
    """A prompt that was stopped: where it happened and how it ended. Not what it said."""
    line: str = Field(pattern=LINE_ID)
    after: int = Field(default=0, ge=-1, le=2000)
    state: Literal["held", "waiting", "declined"] = "held"
    why: Literal["policy", "unsure"] = "policy"
    at: float | None = None


class BranchesIn(BaseModel):
    """The shape of a conversation. There is no field here that could carry what was typed."""
    lines: list[LineIn] = Field(max_length=80)
    nodes: list[NodeIn] = Field(max_length=600)
    active: str = Field(pattern=LINE_ID)
    stops: list[StopIn] = Field(default_factory=list, max_length=200)


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
    return {"ok": True, **agent.status(), "tracing": os.environ.get("LANGSMITH_TRACING") == "true"}


@app.post("/api/reset")
def reset():
    db.reset()
    PAUSED.clear()
    DRAFTS.clear()
    CHAT[:] = SEED_CHAT
    return {"ok": True}


def company_settings() -> dict:
    return {"policy_mode": db.setting("policy_mode") or "approval",
            "unsure_mode": db.setting("unsure_mode") or "ask"}


@app.get("/api/settings")
def read_settings():
    """What the company has chosen. Every workspace reads this and follows it. It also says
    how many of today's model runs are used, so the workspace can say so before they run out."""
    return {**company_settings(), "runs": agent.usage(), "memory": {
        # What Layers can draw on besides the conversation in front of it.
        "team": len([p for p in tools.team_processes() if p["who"] != db.EMPLOYEE["name"]]),
        "workflows": len([w for w in db.query("SELECT * FROM workflows") if tools._can_use(w)]),
        "learned": [r["term"] for r in db.query("SELECT term FROM learned_terms ORDER BY created_at")][:12],
    }}


@app.post("/api/settings")
def settings(body: SettingsIn):
    chosen = {"policy_mode": body.policy_mode, "unsure_mode": body.unsure_mode}
    if chosen != company_settings():
        for key, value in chosen.items():
            db.execute("INSERT OR REPLACE INTO settings VALUES (?, ?)", (key, value))
        db.audit(db.MANAGER if body.actor == "manager" else "design-lab", "settings", chosen)
    return {"ok": True, **chosen}


@app.post("/api/preflight")
def preflight(body: PreflightIn):
    """Runs when the employee presses Send. Decides whether the prompt may go to the workspace model."""
    prompt = body.prompt.strip()
    current = clean_label(body.current or "")
    known = [current] if current else []
    for name in [*(clean_label(o) for o in body.others), *TOPIC_LABELS.values()]:
        if name and name.lower() not in (k.lower() for k in known):
            known.append(name)
    directions = (
        f"The conversation is on this direction right now: {current or 'none yet'}.\n"
        f"Directions it could belong to: {', '.join(known)}.\n"
        "For topic, give one of those names exactly when the prompt belongs there. A prompt that only "
        "refines, shortens or continues the last answer belongs to the current direction. Give two or "
        "three plain words for a new direction only when it is about something none of them cover."
    )

    def work(emit):
        screen = policy.screen(prompt)
        if screen["kind"] == "pass":
            policy.record(prompt, "pass", True, "On project.", "gate")
            emit({"type": "progress", "engaged": False})
            return {"type": "verdict", "verdict": {"kind": "pass", "by": "gate"}}

        def note(event):  # each tool call shows up as a line of plain English, then in full
            if event["type"] == "plan":
                emit({"type": "progress", "engaged": True, "note": "Planning the steps"})
            elif event["type"] == "step":
                step = event["step"]
                emit({"type": "progress", "engaged": True, "step": step,
                      **({"note": step["label"]} if step["status"] == "running" else {})})

        scratch = tools.start_run(note)
        try:
            kind, reason, workflow = screen["kind"], screen["reason"], None
            if kind == "review":  # if the agent cannot be reached, do not guess: ask
                kind = "unsure"
            decided_by = "gate"
            judged, hint = False, None
            looked = False  # whether the agent read the prompt, whoever ended up deciding
            signals = screen["signals"]
            question, trimmed = "", policy.project_part(prompt) if screen["kind"] == "unsure" else ""

            def verdict(found: dict) -> dict:
                # When the agent read the prompt it also said what it is about. That costs no
                # extra model run, and it is what lets the branches follow meaning, not keywords.
                if judged:
                    found["topic"] = hint
                found["by"] = "agent" if looked else "gate"
                return {"type": "verdict", "verdict": found}

            supervisor = agent.get()
            # The agent is asked only when the rules leave something open. A clear hold, and a
            # clear match with a team workflow, are settled in code: at once, with no model call,
            # and with nothing a prompt could argue with.
            if supervisor and screen["kind"] in ("review", "unsure"):
                try:
                    recent = "\n".join(f"{m['role']}: {m['content'][:300]}" for m in CHAT[-4:])
                    agent.run(supervisor,
                              f"REVIEW this prompt the employee tried to send:\n<prompt>\n{prompt}\n</prompt>\n"
                              f"The conversation so far, for context only:\n<conversation>\n{recent}\n</conversation>\n"
                              f"{directions}")
                    scratch = tools._scratch
                    said = scratch.get("verdict")
                    judged, hint = topic_of(said, current)
                    looked = bool(said)
                    if said:
                        # What the agent adds to any decision: the words that counted, the question
                        # that would settle it, and the project part of a mixed prompt.
                        question = " ".join(str(said.get("question", "")).split())[:160]
                        trimmed = said_part(said.get("project_part"), prompt) or trimmed
                        if not signals["fits"] and not signals["against"]:
                            signals = {"fits": said_phrases(said.get("fits"), prompt),
                                       "against": said_phrases(said.get("against"), prompt)}
                    if said and screen["kind"] == "unsure":
                        # The rules themselves could not tell. That is the company's call (ask the
                        # employee, send and log, or send to a person), so the agent may not settle
                        # it either way. Its reading is added to the explanation instead.
                        if said["reason"]:
                            reason = f"{reason} The agent's reading: {said['reason']}"
                    # The model may explain and refine, but it cannot clear what the rules flagged.
                    elif said and not (screen["kind"] == "policy" and said["kind"] in ("pass", "reuse")):
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
                            if event["type"] == "plan" or (event["type"] == "step" and event["step"]["status"] != "running"):
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
                    return verdict({"kind": "reuse", "item": item,
                                    "reason": f"{item['author']} already built a workflow for this."})
            if kind == "pass":
                policy.record(prompt, "pass", True, reason or "On project.", decided_by)
                return verdict({"kind": "pass"})

            policy.record(prompt, kind, False, reason, decided_by)
            held = {"kind": kind, "rule": rule("AI-01"), "reason": reason, "signals": signals}
            if kind == "unsure":
                # Two ways out that the agent can offer: answer its question, or send only the
                # project part. That part goes back through the gate like any other prompt.
                if question:
                    held["question"] = question
                if trimmed and policy.screen(trimmed)["kind"] in ("pass", "reuse"):
                    held["trimmed"] = trimmed
            return verdict(held)
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
            task_id = task_for(body.workflow_id)
            if scratch.get("task_id") != task_id:
                tools.update_task_status(task_id, "doing")
            if "artifact_id" not in scratch:
                return {"type": "error", "message": "It could not be created."}

            art = db.query("SELECT * FROM artifacts WHERE id = ?", (scratch["artifact_id"],))[0]
            plan = tools.plan_of(tools._workflow_row(body.workflow_id))
            rows = json.loads(art["rows"])
            task = db.query("SELECT title FROM tasks WHERE id = ?", (task_id,))[0]["title"]
            filled = (f"Its {len(rows)} sections are laid out and ready to fill in." if plan["rows"]
                      else f"The {len(rows)} competitors from this project are filled in.")
            policy.record(body.prompt, "reuse", False, "Reused a team workflow instead of sending.", "employee")
            return {
                "type": "result",
                "summary": f"{plan['noun']} added to {db.PROJECT['name']}.",
                "detail": f'{filled} "{task}" is now in progress.',
                "taskId": task_id,
                "artifact": {"id": art["id"], "title": art["title"], "source": art["source"],
                             "author": art["author"], "columns": json.loads(art["columns"]), "rows": rows},
            }
        finally:
            tools.end_run()

    return stream(work)


@app.post("/api/undo")
def undo(body: UndoIn):
    db.execute("DELETE FROM artifacts WHERE id = ?", (body.artifact_id,))
    db.execute("DELETE FROM processes WHERE id = (SELECT MAX(id) FROM processes WHERE sample = 0)")
    db.execute("UPDATE tasks SET status = 'todo' WHERE id = ?", (body.task_id,))
    db.audit(db.EMPLOYEE["name"], "undo", body.model_dump())
    return {"ok": True}


UPDATE_TASK = (f"UPDATE: draft a short status update on {db.PROJECT['name']} for {db.MANAGER}, "
               "written as the employee, then send it.")


def plain_update() -> str:
    """The same update written by plain code, for when no model is connected."""
    tasks = db.query("SELECT title, status FROM tasks")
    made = [a["title"] for a in db.query("SELECT title FROM artifacts ORDER BY created_at")]

    def named(status: str) -> str:
        return ", ".join(t["title"].lower() for t in tasks if t["status"] == status)

    parts = [f"Here is where {db.PROJECT['name']} stands."]
    if named("done"):
        parts.append(f"Done: {named('done')}.")
    if named("doing"):
        parts.append(f"In progress: {named('doing')}.")
    if made:
        parts.append(f"Added to the project today: {', '.join(made)}.")
    if named("todo"):
        parts.append(f"Still to start: {named('todo')}.")
    return " ".join(parts)


class SendUpdateIn(BaseModel):
    thread: str | None = Field(default=None, max_length=40)
    text: str = Field(min_length=1, max_length=1200)
    approved: bool = True


@app.post("/api/update/draft")
def draft_update():
    """The agent drafts a status update from the day's results. The harness stops it before
    anything is sent, and the draft comes back here for the employee to read."""

    def work(emit):
        scratch = tools.start_run(emit)
        try:
            text, thread = "", None
            supervisor = agent.get()
            if supervisor:
                try:
                    thread = f"update-{uuid.uuid4().hex[:8]}"
                    _, paused = agent.run(supervisor, UPDATE_TASK, thread)
                    call = agent.pending_call(supervisor, thread) if paused else None
                    if call and call["name"] == "send_status_update":
                        text = " ".join(str(call["args"].get("text", "")).split())
                        db.audit("harness", "paused_for_approval", {"workflow": "send_status_update"})
                except Exception as exc:
                    db.audit("server", "agent_failed", str(exc))
            if not text:  # no model, or it did not get as far as a draft: plain code writes it
                thread = None
                calls = scratch.get("calls", [])
                if "get_project_context" not in calls:
                    tools.get_project_context()
                if "get_todays_activity" not in calls:
                    tools.get_todays_activity()
                text = plain_update()
            if thread:
                DRAFTS[thread] = {"text": text}
            return {"type": "draft", "text": text, "thread": thread, "by": "agent" if thread else "code"}
        finally:
            tools.end_run()

    return stream(work)


@app.post("/api/update/send")
def send_update(body: SendUpdateIn):
    """The employee's answer to a drafted update: send it as written, send their own wording, or drop it."""

    def work(emit):
        scratch = tools.start_run(emit)
        try:
            text = " ".join(body.text.split())
            held = DRAFTS.pop(body.thread, None) if body.thread else None
            supervisor = agent.get()
            if held and supervisor:
                edited = text != held["text"]
                try:
                    db.audit(db.EMPLOYEE["name"],
                             "approved_paused_action" if body.approved else "declined_paused_action",
                             {"workflow": "send_status_update", "edited": edited})
                    emit({"type": "step", "step": {
                        "id": f"approval-{body.thread}", "tool": "human_approval", "status": "done",
                        "label": "Paused until you approved" if body.approved else "You chose not to send it",
                        "detail": (("edited and approved by " if edited else "approved by ") + db.EMPLOYEE["name"])
                        if body.approved else f"declined by {db.EMPLOYEE['name']}"}})
                    agent.resume(supervisor, body.thread, body.approved,
                                 {"name": "send_status_update", "args": {"text": text}} if edited else None)
                except Exception as exc:
                    db.audit("server", "agent_failed", str(exc))
            if not body.approved:
                return {"type": "discarded"}
            if "update_id" not in scratch:
                tools.send_status_update(text)
            # Whatever the model sent on, the words the employee approved are the ones kept.
            db.execute("UPDATE updates SET text = ? WHERE id = ?", (text, scratch["update_id"]))
            return {"type": "sent", "text": text}
        finally:
            tools.end_run()

    return stream(work)


FIND_WORDS = ("where did", "where is", "where was", "where were", "find ", "which chat", "which branch",
              "did i ask", "did i already", "when did i", "look for", "locate")
TEAM_WORDS = ("who else", "teammate", "anyone else", "how did", "how have", "how has", "colleague",
              "other people", "someone else", "others")
SKIP_WORDS = {"where", "find", "asked", "about", "talk", "talked", "chat", "branch", "which", "when", "have",
              "that", "this", "with", "what", "locate", "look", "already", "thing", "something"}


def plain_find(question: str, branches: list[dict]) -> dict | None:
    """Find a prompt by following the branches, in plain code: pick the branch whose prompts share
    the most words with the question, then the prompt in it that shares the most."""
    words = [w[:4] for w in re.findall(r"[a-z]{4,}", question.lower()) if w not in SKIP_WORDS]
    if not words or not branches:
        return None
    tools.get_branch_map()

    def score(text: str) -> int:
        return sum(1 for w in words if w in text.lower())

    best = max(branches, key=lambda b: score(b["label"]) * 2 + max((score(p["text"]) for p in b["prompts"]), default=0))
    hit = max(best["prompts"], key=lambda p: score(p["text"]), default=None)
    if not hit or score(hit["text"]) + score(best["label"]) == 0:
        return None
    tools.read_branch(best["label"])
    return {"line": best["id"], "index": hit["n"], "label": best["label"], "prompt": hit["text"], "what": ""}


@app.post("/api/ask")
def ask(body: AskIn):
    """A question to Layers itself. Nothing here goes to the workspace model."""
    question = body.prompt.strip()
    low = question.lower()
    screen = policy.screen(question)
    answer: dict
    steps: list[dict] = []  # each tool call made for this answer, so the employee can see them
    by = "code"

    def keep(event):
        if event["type"] == "step" and event["step"]["status"] != "running":
            steps.append(event["step"])

    tools.start_run(keep)
    try:
        if body.branches and any(w in low for w in FIND_WORDS):
            # The branches are the index. The agent reads the map, opens only the branch that
            # could hold the answer, and points at the prompt.
            branches = [b.model_dump() for b in body.branches]
            tools._scratch["branches"] = branches
            found = None
            supervisor = agent.get()
            if supervisor:
                try:
                    agent.run(supervisor, "FIND: the employee asks where this is in their conversation: "
                                          f"<question>{question}</question>")
                    found = tools._scratch.get("found")
                    by = "agent"
                except Exception as exc:
                    db.audit("server", "agent_failed", str(exc))
                tools._scratch["branches"] = branches
            found = found or plain_find(question, branches)
            if found:
                answer = {"text": found["what"] or f"It is in {found['label']}, prompt {found['index'] + 1}.",
                          "found": {k: found[k] for k in ("line", "index", "label", "prompt")}}
            else:
                answer = {"text": "I followed the branches of this conversation and could not find that."}
        elif any(w in low for w in TEAM_WORDS):
            # The layer between workers: how people on the same team did similar work.
            found = json.loads(tools.search_team_processes(question)) or tools.team_processes()[:3]
            found = [p for p in found if p["who"] != db.EMPLOYEE["name"]]
            if found:
                found = found[:2]  # the two closest fit in the bubble; the manager's page has them all
                names = list(dict.fromkeys(p["who"].split()[0] for p in found))
                answer = {"text": f"{' and '.join(names)} on your team {'has' if len(names) == 1 else 'have'} "
                                  "done work like this. Here is how.", "processes": found}
                used = tools._workflow_row(found[0]["workflow_id"]) if found[0]["workflow_id"] else None
                if used and tools._can_use(used):
                    answer["item"] = tools.workflow_public(used)
            else:
                answer = {"text": "Nobody on your team has done work like that through Layers yet."}
        elif any(w in low for w in ("limit", "allowed", "rule", "policy", "what can i")):
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
    return {**answer, "steps": steps, "by": by}


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


def team_knowledge(prompt: str) -> dict | None:
    """What the company already knows that bears on a prompt: how people did similar work and
    what they used. Only for questions that ask about that, and only what this employee may see."""
    if not policy.ASKS_TEAM.search(prompt):
        return None
    found = json.loads(tools.search_team_processes(prompt)) or tools.team_processes()[:3]
    found = [p for p in found if p["who"] != db.EMPLOYEE["name"]][:3]
    known: dict = {"processes": found, "restricted": tools.other_teams()}
    used = tools._workflow_row(found[0]["workflow_id"]) if found and found[0]["workflow_id"] else None
    if used and tools._can_use(used):
        known["item"] = tools.workflow_public(used)
    return known


def knowledge_brief(known: dict) -> str:
    """The same records as an instruction for the workspace model, so its answer stays on them."""
    return ("\n\nThis question is about how people at the company have done similar work. Answer from these "
            "records only. Name the person and the project, say what steps they took and what they used, and "
            f"invent nobody.\nRecords: {json.dumps(known['processes'])}\n"
            f"Teams with similar work that is not shared with this employee: {', '.join(known['restricted']) or 'none'}. "
            "Say only that it exists and that their manager can ask for access.")


def knowledge_answer(known: dict) -> str:
    """The answer in plain words from the records alone, for when no model can be asked."""
    if not known["processes"]:
        return "Nobody on your team has done work like that through Layers yet."
    lines = [f"**{p['who']}** on {p['project']}: {p['did'].lower()}. Steps: {' → '.join(p['path'])}."
             + (f" Used `{p['workflow']}`." if p["workflow"] else "") for p in known["processes"]]
    if known["restricted"]:
        lines.append(f"{' and '.join(known['restricted'])} also has similar work, but it is not shared with your "
                     f"team. {db.MANAGER.split()[0]} can ask for access.")
    return "Here is how people on your team did similar work.\n\n" + "\n".join(f"- {line}" for line in lines)


@app.post("/api/chat")
def chat(body: ChatIn):
    """The workspace model. A prompt only gets here with an allowing decision on record."""
    prompt = body.prompt.strip()
    if not policy.may_send(prompt):
        db.audit("gate", "blocked_send", prompt[:200])
        raise HTTPException(403, "Layers has not cleared this prompt.")
    # Questions about how others did similar work are answered from the company's own records.
    known = team_knowledge(prompt)
    extra = {"knowledge": known} if known else {}
    if not agent.MODEL:
        if known:
            return {"text": knowledge_answer(known), "placeholder": False, **extra}
        return {"text": "Layers cleared this prompt. No workspace model is connected yet, so there is no answer to show.",
                "placeholder": True}
    try:
        agent.spend_run()
        CHAT.append({"role": "user", "content": prompt})
        seen = [t.model_dump() for t in body.context] if body.context is not None else CHAT[-24:-1]
        reply = agent.answering_model().invoke(
            [{"role": "system", "content": WORKSPACE_PROMPT + (knowledge_brief(known) if known else "")},
             *seen, {"role": "user", "content": prompt}])
        text = reply.content
        if isinstance(text, list):  # some providers answer in content blocks
            text = "".join(part.get("text", "") for part in text if isinstance(part, dict))
        CHAT.append({"role": "assistant", "content": text})
        return {"text": text, "placeholder": False, **extra}
    except agent.CapReached:
        if known:  # the records answer it without a model
            return {"text": knowledge_answer(known), "placeholder": False, **extra}
        return {"text": f"Layers cleared this prompt. Today's {agent.DAILY_RUN_CAP} model runs are used up, so the "
                        "workspace model was not asked.", "placeholder": True}
    except Exception as exc:
        db.audit("server", "chat_failed", str(exc))
        if known:
            return {"text": knowledge_answer(known), "placeholder": False, **extra}
        return {"text": "Layers cleared this prompt, but the workspace model did not answer.", "placeholder": True}


class SameIn(BaseModel):
    new: str = Prompt
    earlier: str = Prompt


SAME_PROMPT = ("Two prompts from one conversation. Answer with a single word. Say 'same' if answering the "
               "second would repeat the answer to the first. Say 'different' if it asks for anything new, "
               "for more detail, or for a change to an earlier answer.")


@app.post("/api/same")
def same(body: SameIn):
    """The thinking step before an answer: has this already been asked? Plain code settles the
    plain cases. The model is asked only about the unclear ones, and only this one short
    question, which costs far less than writing the whole answer again."""
    def squash(text: str) -> str:
        return " ".join(re.sub(r"[^a-z0-9]+", " ", text.lower()).split())

    if squash(body.new) == squash(body.earlier):
        return {"same": True, "by": "code"}
    if not agent.MODEL:
        return {"same": False, "by": "code"}
    try:
        agent.spend_run()
        reply = agent.answering_model().invoke([
            {"role": "system", "content": SAME_PROMPT},
            {"role": "user", "content": f"First: {body.earlier}\nSecond: {body.new}"}])
        text = reply.content
        if isinstance(text, list):
            text = "".join(part.get("text", "") for part in text if isinstance(part, dict))
        said = str(text).strip().lower().startswith("same")
        db.audit("layers-agent", "memory_check", {"same": said})
        return {"same": said, "by": "agent"}
    except Exception as exc:
        db.audit("server", "agent_failed", str(exc))
        return {"same": False, "by": "code"}


@app.get("/api/approvals/{request_id}")
def approval_status(request_id: str):
    number = request_id.removeprefix("EX-")
    rows = db.query("SELECT status FROM approvals WHERE id = ?", (int(number),)) if number.isdigit() else []
    if not rows:
        raise HTTPException(404, "No such request.")
    return {"status": rows[0]["status"]}


@app.post("/api/branches")
def branches(body: BranchesIn):
    """The shape of the employee's conversation, kept for the manager. Each line is named
    from the fixed list above, never from anything the employee wrote."""
    shape = {
        "lines": [{"id": line.id, "kind": line.kind, "parent": line.parent, "fork": line.fork,
                   "label": TOPIC_LABELS.get(line.topic or "", "Other direction" if line.topic else "New branch"),
                   "task": TOPIC_TASKS.get(line.topic or ""),
                   "merged": line.merged, "promoted": line.promoted} for line in body.lines],
        "nodes": [node.model_dump() for node in body.nodes],
        "active": body.active,
        "stops": [stop.model_dump() for stop in body.stops],
    }
    db.execute("INSERT OR REPLACE INTO settings VALUES (?, ?)", ("branches", json.dumps(shape)))
    return {"ok": True}


def _shape(lines: list[tuple], nodes: list[tuple], active: str, stops: tuple = ()) -> dict:
    seen: dict[str, int] = {}
    dots = []
    for line, visit in nodes:  # a prompt re-opens a line when it starts a new visit to it
        dots.append({"line": line, "reopened": visit > seen.get(line, visit), "visit": visit})
        seen[line] = visit
    return {
        "lines": [{"id": i, "kind": kind, "parent": parent, "fork": fork, "label": label,
                   "merged": merged, "promoted": promoted}
                  for i, kind, parent, fork, label, merged, promoted in lines],
        "nodes": dots,
        "active": active,
        "stops": [{"line": line, "after": after, "state": state} for line, after, state in stops],
    }


# Two sample teammates, so the manager's page shows what a team looks like. They are not
# connected to anything: the page marks them "Sample", and only the signed-in employee is live.
SAMPLE_TEAM = [
    {
        "id": "dwight", "name": "Dwight Schrute", "role": "Assistant to the Manager", "team": "Strategy", "sample": True,
        "project": {"name": "Project Y", "title": "Customer interview synthesis", "due": "Wed, Nov 25"},
        "tasks": [
            {"id": "y1", "title": "Collect interview notes", "status": "done"},
            {"id": "y2", "title": "Tag themes", "status": "done"},
            {"id": "y3", "title": "Draft the synthesis", "status": "doing"},
            {"id": "y4", "title": "Review with Michael", "status": "todo"},
        ],
        "counts": {"checked": 14, "passed": 12, "held": 1, "reused": 1},
        "pending": 0,
        "feed": [
            {"text": "Layers moved a direction Dwight kept returning to into its own chat."},
            {"text": "Dwight reused a team workflow. A synthesis sheet was added to Project Y."},
            {"text": "Layers held a prompt under rule AI-01."},
        ],
        "branches": _shape(
            [("main", "main", None, None, "Interview notes", False, False),
             ("l1", "implicit", "main", 1, "Theme tagging", True, False),
             ("l2", "explicit", "main", 4, "Synthesis draft", False, True)],
            [("main", 1), ("main", 1), ("l1", 1), ("l1", 1), ("main", 2), ("l2", 1), ("main", 3),
             ("l2", 2), ("l2", 2), ("l2", 2)],
            "l2", (("main", 3, "held"),)),
    },
    {
        "id": "pam", "name": "Pam Beesly", "role": "Office Administrator", "team": "Strategy", "sample": True,
        "project": {"name": "Project Z", "title": "Pricing page teardown", "due": "Mon, Nov 23"},
        "tasks": [
            {"id": "z1", "title": "Capture competitor pricing pages", "status": "done"},
            {"id": "z2", "title": "Compare plan tiers", "status": "doing"},
            {"id": "z3", "title": "Write recommendations", "status": "todo"},
        ],
        "counts": {"checked": 10, "passed": 10, "held": 0, "reused": 0},
        "pending": 0,
        "feed": [
            {"text": "Layers noticed a new direction and gave it its own line."},
            {"text": "Ten prompts went straight through."},
        ],
        "branches": _shape(
            [("main", "main", None, None, "Pricing pages", False, False),
             ("l1", "implicit", "main", 6, "Plan tiers", False, False)],
            [("main", 1)] * 7 + [("l1", 1), ("l1", 1), ("main", 2)],
            "main"),
    },
]


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
            text = f"{first} reused a team workflow. The result was added to {db.PROJECT['name']}."
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
        elif action == "settings" and a["actor"] == db.MANAGER:
            text = "You changed the workspace rules."
        elif action == "tool:send_status_update":
            text = f"{first} sent you a status update."
        if text:
            feed.append({"ts": a["ts"], "text": text})

    def count(where: str) -> int:
        return db.query(f"SELECT COUNT(*) AS n FROM decisions WHERE {where}")[0]["n"]

    tasks = db.query("SELECT id, title, status FROM tasks")
    counts = {
        "checked": count("decided_by IN ('gate', 'agent')"),
        "passed": count("decided_by IN ('gate', 'agent') AND allowed = 1"),
        "held": count("verdict IN ('policy', 'unsure')"),
        "reused": db.query("SELECT COUNT(*) AS n FROM artifacts")[0]["n"],
    }
    live = {
        "id": "me", "name": db.EMPLOYEE["name"], "role": db.EMPLOYEE["role"],
        "team": db.EMPLOYEE["team"], "sample": False, "project": db.PROJECT, "tasks": tasks,
        "counts": counts, "pending": len(pending), "feed": feed[:12],
        "branches": json.loads(db.setting("branches") or "null"),
        # Sent by the employee on purpose, after reading it, so the manager may read it too.
        "updates": db.query("SELECT text, created_at AS ts FROM updates ORDER BY id DESC LIMIT 5"),
    }
    return {
        "manager": db.MANAGER, "employee": db.EMPLOYEE, "project": db.PROJECT,
        "pending": pending, "feed": feed[:12], "tasks": tasks, "counts": counts,
        "team": [live, *SAMPLE_TEAM],
        "settings": company_settings(),
        "processes": tools.team_processes(),
        "rules": db.query("SELECT id, name, text FROM rules"),
        "audit": audit_trail(),
    }


ACTORS = {"layers-agent": "Layers agent", "gate": "Gate", "agent": "Layers agent", "harness": "Harness",
          "server": "Server", "employee": db.EMPLOYEE["name"], "design-lab": "Design lab"}
VERDICTS = {"pass": "cleared a prompt", "policy": "held a prompt under AI-01", "unsure": "could not tell, and asked",
            "reuse": "offered a team workflow instead", "manager-approved": "approved a request",
            "manager-declined": "declined a request", "employee-override": "sent after a warning",
            "employee-related": "said a prompt is project work", "employee-note": "sent with a reason",
            "employee-unsure-allowed": "sent an unclear prompt, logged", "employee-skipped-reuse": "skipped a team workflow"}


def audit_trail(limit: int = 40) -> list[dict]:
    """The audit log as the manager may read it: who did what, when, and how long it took.
    What the employee typed is left out of every row."""
    rows = []
    for a in db.query("SELECT ts, actor, action, detail FROM audit ORDER BY id DESC LIMIT ?", (limit * 2,)):
        action = a["action"]
        try:
            detail = json.loads(a["detail"])
        except ValueError:
            detail = a["detail"]
        info = detail if isinstance(detail, dict) else {}
        what, note = "", ""
        if action.startswith("tool:"):
            what = f"called {action[5:]}"
            # A verdict's direction can echo the prompt, so only the verdict itself is kept.
            said = str(info.get("detail", "")).split(",")[0] if action == "tool:submit_verdict" else info.get("detail", "")
            note = " · ".join(str(part) for part in (said, f"{info.get('ms', 0)} ms") if part != "")
        elif action.startswith("decision:"):
            what = VERDICTS.get(action[9:], action[9:])
            note = "sent on" if info.get("allowed") else "not sent"
        elif action == "plan":
            what, note = "wrote its plan", f"{len(detail) if isinstance(detail, list) else 0} steps"
        elif action == "settings":
            what = "changed the rules"
            note = f"off-project: {info.get('policy_mode')}, unsure: {info.get('unsure_mode')}"
        elif action == "paused_for_approval":
            what, note = "paused the agent before it created anything", str(info.get("workflow", ""))
        elif action == "approved_paused_action":
            what = "approved the paused action"
            note = str(info.get("workflow", "")) + (", after editing it" if info.get("edited") else "")
        elif action == "declined_paused_action":
            what, note = "declined the paused action", str(info.get("workflow", ""))
        elif action == "undo":
            what = "undid a reused workflow"
        elif action == "ask":
            what, note = "asked Layers a question", "question not shown"
        elif action == "memory_check":
            what = "checked whether a prompt was already asked"
            note = "it was, so it was not answered again" if info.get("same") else "it was new"
        elif action == "blocked_send":
            what = "blocked a send with no clearing decision"
        elif action in ("error", "agent_failed", "chat_failed"):
            what, note = action.replace("_", " "), "see the server log"
        else:
            continue
        rows.append({"ts": a["ts"], "who": ACTORS.get(a["actor"], a["actor"]), "what": what, "note": note})
    return rows[:limit]


@app.get("/api/audit")
def audit_log():
    return db.query("SELECT ts, actor, action, detail FROM audit ORDER BY id DESC LIMIT 100")
