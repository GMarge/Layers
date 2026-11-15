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
        call("submit_verdict", kind="reuse", reason="Marcus already built this.",
             workflow_id="wf-competitor-matrix-v2"),
        AIMessage(content="Your team already has this."),
    ])
    supervisor = agent.build(model)
    scratch = tools.start_run(events.append)
    said = agent.run(supervisor, "REVIEW this prompt: Build me an Excel automation")
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
    said = agent.run(supervisor, "ACT: apply workflow wf-competitor-matrix-v2")
    tools.end_run()
    assert db.query("SELECT 1 FROM artifacts WHERE id = ?", (scratch["artifact_id"],)), "no artifact"
    assert db.query("SELECT status FROM tasks WHERE id = 't3'")[0]["status"] == "doing"
    done = [e["step"] for e in events if e["step"]["status"] == "done"]
    print("act ok:", [(s["tool"], f"{s['ms']} ms") for s in done], "->", said)

    # A model that tries to use another team's workflow is stopped by the tool, not by the prompt.
    model.script[:] = [call("create_project_artifact", workflow_id="wf-board-deck-q3"), AIMessage(content="ok")]
    scratch = tools.start_run(events.append)
    agent.run(supervisor, "ACT: apply workflow wf-board-deck-q3")
    tools.end_run()
    assert "artifact_id" not in scratch, "permission check failed"
    print("permission ok: Finance workflow refused")
    db.reset()


if __name__ == "__main__":
    main()
