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
    r"\b(spreadsheet|excel|sheet|matrix|table|template|workflow|automation|outline)\b", re.I)
VAGUE = re.compile(r"\b(budget|offsite|email|schedule)\b", re.I)
# A question about how people at the company have done similar work. The answer comes from
# the company's own records, so it is work by definition.
ASKS_TEAM = re.compile(
    r"\b(who else|teammates?|anyone else|has anyone|have others|other teams?|another team|colleagues?|"
    r"someone (else|on|in)|people on (my|the|our) team|on (my|the|our) team|how did \w+|how have \w+|"
    r"what did (they|he|she|\w+) use|(done|did) (this|that|something similar)|similar (work|project|thing)|"
    r"company('s)? (knowledge|playbook|process(es)?)|been done before)\b", re.I)


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
    if ASKS_TEAM.search(prompt):
        return {"kind": "pass", "signals": {"fits": fits + _hits(ASKS_TEAM, prompt), "against": []}, "reason": ""}
    if fits and REBUILD.search(prompt):
        return {"kind": "reuse", "signals": {"fits": fits, "against": []},
                "reason": "This asks to build something the team may already have."}
    if fits:
        return {"kind": "pass", "signals": {"fits": fits, "against": []}, "reason": ""}
    # Nothing recognisable either way. The rules cannot clear this, so the agent has to look.
    return {"kind": "review", "signals": {"fits": [], "against": []},
            "reason": f"Nothing in this prompt names {project} or anything in its brief."}


CLAUSES = re.compile(r"\s*(?:;|\.\s+|,?\s+and then\s+|,?\s+and also\s+|,?\s+and\s+|,?\s+then\s+|,?\s+also\s+|,?\s+plus\s+)\s*", re.I)


def project_part(prompt: str) -> str:
    """For a prompt that mixes project work with something else: the project work alone.
    Empty when the two cannot be told apart. Whatever comes back is checked again when sent."""
    clauses = [c.strip(" .") for c in CLAUSES.split(prompt) if c and c.strip(" .")]
    kept = [c for c in clauses if ON_PROJECT.search(c) and not OFF_TOPIC.search(c)]
    if not kept or len(kept) == len(clauses):
        return ""
    text = " and ".join(kept)
    return text[0].upper() + text[1:]


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
