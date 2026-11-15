"""Writes web/public/preview/manager.json: the manager's page after a short session.

The public preview has no server, so its manager page shows this sample instead of a live
one. It is made the same way as the free checks: a copy of the server in a temporary folder,
with no model, driven through the same functions the web app calls. Everyone in it is marked
as a sample.

Run: .venv/bin/python scripts/preview_manager.py
"""

import asyncio
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "public" / "preview" / "manager.json"
SANDBOX = Path(tempfile.mkdtemp(prefix="layers-preview-"))
shutil.copytree(ROOT / "server", SANDBOX / "server", ignore=shutil.ignore_patterns("__pycache__"))
os.environ["LAYERS_MODEL"] = ""  # rules only: nothing here can reach a model
os.environ["LANGSMITH_API_KEY"] = ""
os.chdir(SANDBOX)
sys.path.insert(0, str(SANDBOX))

from server import main  # noqa: E402

SKI = "Plan my ski vacation this weekend"
SHEET = "Build me an Excel automation that compares our five competitors"


async def _events(response) -> list[dict]:
    out = []
    async for chunk in response.body_iterator:
        text = chunk.decode() if isinstance(chunk, bytes) else chunk
        out += [json.loads(line[5:]) for line in text.split("\n") if line.startswith("data:")]
    return out


def play(response) -> list[dict]:
    return asyncio.run(_events(response))


def check(prompt: str) -> None:
    play(main.preflight(main.PreflightIn(prompt=prompt)))


def build() -> dict:
    main.reset()
    check("Summarize how Stocksmith and Pantryline price their plans")
    check("What pricing gaps can we use against Stocksmith?")
    check(SKI)
    main.create_approval(main.ApprovalIn(prompt=SKI, note=""))
    check(SHEET)
    play(main.apply(main.ApplyIn(workflow_id="wf-competitor-matrix-v2", prompt=SHEET)))
    draft = [e for e in play(main.draft_update()) if e["type"] == "draft"][-1]
    play(main.send_update(main.SendUpdateIn(thread=None, text=draft["text"], approved=True)))
    now = time.time()
    main.branches(main.BranchesIn.model_validate({
        "lines": [
            {"id": "main", "kind": "main", "topic": "research"},
            {"id": "l1", "kind": "explicit", "parent": "main", "fork": 0, "topic": "analysis", "promoted": True},
            {"id": "l2", "kind": "implicit", "parent": "main", "fork": 2, "topic": "sheet"},
        ],
        "nodes": [
            {"line": "main", "at": now - 900}, {"line": "l1", "at": now - 780}, {"line": "main", "at": now - 640},
            {"line": "l1", "visit": 2, "at": now - 520}, {"line": "l2", "at": now - 300},
            {"line": "l1", "visit": 3, "at": now - 120},
        ],
        "active": "l1",
        "stops": [{"line": "main", "after": 2, "state": "waiting", "why": "policy", "at": now - 600}],
    }))
    page = main.manager()
    for person in page["team"]:
        person["sample"] = True
    for way in page["processes"]:
        way["sample"] = True
    return page


if __name__ == "__main__":
    try:
        page = build()
        OUT.write_text(json.dumps(page, indent=1, default=str) + "\n")
        print(f"wrote {OUT.relative_to(ROOT)}: {len(page['team'])} people, {len(page['pending'])} waiting, {len(page['audit'])} audit lines")
    finally:
        os.chdir(ROOT)
        shutil.rmtree(SANDBOX, ignore_errors=True)
