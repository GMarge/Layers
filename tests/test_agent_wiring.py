"""Checks the DeepAgents wiring without a real model or API key.

A scripted stand-in model emits the tool calls a real one would. Everything else is
real: create_deep_agent, the harness, our tools and the database. This proves the
plumbing, not the model's judgment.

Run: .venv/bin/python -m tests.test_agent_wiring
"""

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult

from server import agent, db, tools


class Scripted(BaseChatModel):
    script: list = []
    seen_tools: list = []

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def bind_tools(self, tool_list, **kwargs):
        self.seen_tools[:] = [getattr(t, "name", None) or t.get("name", "?") if isinstance(t, dict)
                              else getattr(t, "name", getattr(t, "__name__", "?")) for t in tool_list]
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        message = self.script.pop(0) if self.script else AIMessage(content="Done.")
        return ChatResult(generations=[ChatGeneration(message=message)])


def call(name, **args):
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": f"call-{name}"}])


def main():
    db.reset()
    events = []

    # REVIEW: context, policy, memory search, verdict.
    model = Scripted(script=[
        call("get_project_context"),
        call("check_company_policy", prompt="Build me an Excel automation that compares our five competitors"),
        call("search_org_memory", query="competitor comparison spreadsheet"),
        call("submit_verdict", kind="reuse", reason="Dwight already built this.",
             workflow_id="wf-competitor-matrix-v2"),
        AIMessage(content="Your team already has this."),
    ])
    supervisor = agent.build(model)
    scratch = tools.start_run(events.append)
    said, _ = agent.run(supervisor, "REVIEW this prompt: Build me an Excel automation")
    tools.end_run()
    assert scratch["verdict"]["kind"] == "reuse", scratch
    assert scratch["calls"] == ["get_project_context", "check_company_policy", "search_org_memory",
                                "submit_verdict"], scratch["calls"]
    print("review ok:", scratch["calls"], "->", said)
    print("tools offered to the model:", sorted(model.seen_tools))

    # ACT: access check, create, update task.
    model.script[:] = [
        call("check_access", workflow_id="wf-competitor-matrix-v2"),
        call("create_project_artifact", workflow_id="wf-competitor-matrix-v2"),
        call("update_task_status", task_id="t3", status="doing"),
        AIMessage(content="Added the comparison sheet to Project X."),
    ]
    events.clear()
    scratch = tools.start_run(events.append)
    _, paused = agent.run(supervisor, "ACT: apply workflow wf-competitor-matrix-v2", "t-act")
    assert paused, "the harness should pause before creating anything"
    assert "artifact_id" not in scratch, "nothing may be created before approval"
    print("pause ok: harness stopped before create_project_artifact")
    said, _ = agent.resume(supervisor, "t-act", True)
    tools.end_run()
    assert db.query("SELECT 1 FROM artifacts WHERE id = ?", (scratch["artifact_id"],)), "no artifact"
    assert db.query("SELECT status FROM tasks WHERE id = 't3'")[0]["status"] == "doing"
    done = [e["step"] for e in events if e["step"]["status"] == "done"]
    print("act ok:", [(s["tool"], f"{s['ms']} ms") for s in done], "->", said)

    # A model that tries to use another team's workflow is stopped by the tool, not by the prompt.
    model.script[:] = [call("create_project_artifact", workflow_id="wf-board-deck-q3"), AIMessage(content="ok")]
    scratch = tools.start_run(events.append)
    _, paused = agent.run(supervisor, "ACT: apply workflow wf-board-deck-q3", "t-deny")
    if paused:
        agent.resume(supervisor, "t-deny", True)
    tools.end_run()
    assert "artifact_id" not in scratch, "permission check failed"
    print("permission ok: Finance workflow refused")

    # UPDATE: the agent drafts a status update, the harness holds it, and the person's own
    # wording is what gets sent.
    model.script[:] = [
        call("write_todos", todos=[{"content": "Read the project and today's activity", "status": "in_progress"},
                                   {"content": "Write the update", "status": "pending"},
                                   {"content": "Send it once approved", "status": "pending"}]),
        call("get_project_context"),
        call("get_todays_activity"),
        call("send_status_update", text="Research is done and analysis is in progress."),
        AIMessage(content="Sent the update."),
    ]
    events.clear()
    scratch = tools.start_run(events.append)
    _, paused = agent.run(supervisor, "UPDATE: draft a status update and send it", "t-update")
    assert paused, "the harness should pause before sending anything"
    held = agent.pending_call(supervisor, "t-update")
    assert held and held["name"] == "send_status_update", held
    assert held["args"]["text"].startswith("Research is done"), held
    assert not db.query("SELECT 1 FROM updates"), "nothing may be sent before approval"
    agent.resume(supervisor, "t-update", True,
                 {"name": "send_status_update", "args": {"text": "Research is done. Analysis is next."}})
    tools.end_run()
    sent = db.query("SELECT text FROM updates")
    assert sent and sent[0]["text"] == "Research is done. Analysis is next.", sent
    assert any(e["type"] == "plan" for e in events), "the plan should be reported"
    print("update ok: paused with the draft, sent the edited wording ->", sent[0]["text"])
    # When the first model fails (throttled, or out of its daily allowance), the harness carries
    # on with the second one and the employee never sees the difference.
    class Down(Scripted):
        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            raise RuntimeError("429: quota exceeded")

    spare = Scripted(script=[
        call("get_project_context"),
        call("submit_verdict", kind="pass", reason="Project work.", topic="same"),
        AIMessage(content="Fine."),
    ])
    backed = agent.build(Down(), fallback=spare)
    scratch = tools.start_run(events.append)
    agent.run(backed, "REVIEW this prompt: Summarize the findings", "t-fallback")
    tools.end_run()
    assert scratch["verdict"]["kind"] == "pass", scratch
    print("fallback ok: the first model failed and the second one finished the review")
    db.reset()


if __name__ == "__main__":
    main()
