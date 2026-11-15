"""The gate. Plain code decides whether a prompt may be sent; the model never does.

A quick screen sorts each prompt into clear, off-project, unsure, or a possible rebuild
of something the team already has. Only the last three are worth the agent's time.
"""

import re

from . import db

OFF_TOPIC = re.compile(
    r"\b(vacation|holiday|ski|skiing|snowboard|trip|flights?|hotel|airbnb|itinerary|recipe|dinner|"
    r"movie|netflix|dating|birthday|gift|workout|gym|fantasy football|horoscope|wedding|apartment|"
    r"crypto|lottery|video games?|playlist|concert)\b", re.I)
ON_PROJECT = re.compile(
    r"\b(competitors?|competitive|comparison|compares?|pricing|market|analysis|project x|stocksmith|"
    r"pantryline|crateworks|tallyhouse|larder|presentation|deck|slides|findings|grocers?|inventory)\b", re.I)
REBUILD = re.compile(
    r"\b(build|create|make|generate|write|set up|automate)\b[\s\S]*"
    r"\b(spreadsheet|excel|sheet|matrix|table|template|workflow|automation)\b", re.I)
VAGUE = re.compile(r"\b(budget|offsite|email|schedule)\b", re.I)


def _hits(pattern: re.Pattern, text: str) -> list[str]:
    seen: list[str] = []
    for m in pattern.finditer(text):
        word = m.group(0).lower()
        if word not in seen:
            seen.append(word)
    return seen


def _quoted(words: list[str]) -> str:
    return ", ".join(f'"{w}"' for w in words)


def screen(prompt: str) -> dict:
    """Deterministic first pass. Returns kind (pass, policy, unsure, reuse or review),
    the reason, and the words that counted each way."""
    learned = [r["term"] for r in db.query("SELECT term FROM learned_terms")]
    fits = _hits(ON_PROJECT, prompt) + [t for t in learned if t in prompt.lower()]
    against = _hits(OFF_TOPIC, prompt)
    project = db.PROJECT["name"]

    if fits and against:
        return {"kind": "unsure", "signals": {"fits": fits, "against": against},
                "reason": f"It mentions {_quoted(fits)} from the {project} brief, and also "
                          f"{_quoted(against)}, which the brief does not cover."}
    if not fits and not against and VAGUE.search(prompt):
        return {"kind": "unsure", "signals": {"fits": [], "against": _hits(VAGUE, prompt)},
                "reason": f"Nothing here names {project} or anything in its brief, but it could still be work."}
    if against:
        return {"kind": "policy", "signals": {"fits": fits, "against": against},
                "reason": f"Nothing in the prompt connects to the {db.PROJECT['title'].lower()}."}
    if fits and REBUILD.search(prompt):
        return {"kind": "reuse", "signals": {"fits": fits, "against": []},
                "reason": "This asks to build something the team may already have."}
    if fits:
        return {"kind": "pass", "signals": {"fits": fits, "against": []}, "reason": ""}
    # Nothing recognisable either way. The rules cannot clear this, so the agent has to look.
    return {"kind": "review", "signals": {"fits": [], "against": []},
            "reason": f"Nothing in this prompt names {project} or anything in its brief."}


def learn_from(prompt: str) -> list[str]:
    """The employee said this prompt is project work. Remember its distinctive words so
    the same kind of request is not flagged again. This is the adaptive part, and it is
    plain bookkeeping: no model is trained."""
    words = [w for w in re.findall(r"[a-z]{5,}", prompt.lower())
             if not OFF_TOPIC.search(w) and not ON_PROJECT.search(w)]
    stop = {"about", "would", "could", "should", "please", "there", "their", "which", "write", "draft"}
    learned = [w for w in dict.fromkeys(words) if w not in stop][:4]
    for term in learned:
        db.execute("INSERT OR IGNORE INTO learned_terms VALUES (?, ?, strftime('%s','now'))", (term, prompt[:200]))
    return learned


def may_send(prompt: str) -> bool:
    """The only thing that lets a prompt reach the workspace model: an allowing decision on record."""
    rows = db.query("SELECT allowed FROM decisions WHERE prompt = ? ORDER BY id DESC LIMIT 1", (prompt,))
    return bool(rows and rows[0]["allowed"])


def record(prompt: str, verdict: str, allowed: bool, reason: str, decided_by: str) -> None:
    db.execute("INSERT INTO decisions (prompt, verdict, allowed, reason, decided_by, created_at) "
               "VALUES (?, ?, ?, ?, ?, strftime('%s','now'))",
               (prompt, verdict, int(allowed), reason, decided_by))
    db.audit(decided_by, f"decision:{verdict}", {"prompt": prompt[:200], "allowed": allowed, "reason": reason})
