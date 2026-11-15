"""Takes the presentation screenshots by driving a real session in headless Chrome.

Nothing in the pictures is staged: the script types the prompts, the live agent answers,
and the screen is captured as it is. It needs a copy of Layers to work in, so it does not
disturb the one you are using:

  1. a server on port 8001 with its own database (copy the `server` folder somewhere
     else and start it there with the same environment as `.env`)
  2. a second web app pointed at it:
     LAYERS_API=http://127.0.0.1:8001 LAYERS_WEB_PORT=5174 npm --prefix web run dev

Run: .venv/bin/python scripts/shots.py        (about ten model runs, on that copy)
The pictures land in docs/shots at 2880 x 1800.
"""

import asyncio
import base64
import json
import os
import shutil
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

import websockets

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
URL = os.environ.get("LAYERS_SHOTS_URL", "http://127.0.0.1:5174/")
OUT = Path(__file__).resolve().parent.parent / "docs" / "shots"
PORT = 9333
PACE = float(os.environ.get("LAYERS_SHOTS_PACE", "9"))  # seconds between steps

HELPERS = """
window.L = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  until: async (fn, what, ms = 240000) => {
    const start = Date.now();
    for (;;) {
      const value = fn();
      if (value) return value;
      if (Date.now() - start > ms) throw new Error('timed out waiting for ' + what);
      await L.sleep(200);
    }
  },
  send: async (text) => {
    const box = document.getElementById('prompt');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await L.sleep(150);
    document.querySelector('.composer__send').click();
  },
  ask: async (text) => {
    const box = await L.until(() => document.querySelector('.b-ask input'), 'the ask box', 15000);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await L.sleep(150);
    box.form.requestSubmit();
  },
  answers: () => document.querySelectorAll('.msg--ai').length,
  title: () => document.querySelector('.bubble .b-title')?.textContent ?? '',
  button: (scope, text) => [...document.querySelectorAll(scope + ' button')].find((b) => b.textContent.includes(text)),
  click: async (scope, text) => (await L.until(() => L.button(scope, text), scope + ' ' + text, 20000)).click(),
  tab: (text) => [...document.querySelectorAll('.bpanel__tabs button')].find((b) => b.textContent.includes(text)).click(),
};
"""


async def session(ws) -> None:
    ids = iter(range(1, 10**6))

    async def call(method: str, **params):
        number = next(ids)
        await ws.send(json.dumps({"id": number, "method": method, "params": params}))
        while True:
            message = json.loads(await ws.recv())
            if message.get("id") == number:
                if "error" in message:
                    raise RuntimeError(message["error"])
                return message.get("result", {})

    async def js(body: str):
        result = await call("Runtime.evaluate", expression=f"(async () => {{ {body} }})()",
                            awaitPromise=True, returnByValue=True)
        if "exceptionDetails" in result:
            raise RuntimeError(result["exceptionDetails"].get("exception", {}).get("description", result))
        return result["result"].get("value")

    async def shot(name: str, settle: float = 0.9) -> None:
        await asyncio.sleep(settle)
        picture = await call("Page.captureScreenshot", format="jpeg", quality=90)
        (OUT / f"{name}.jpg").write_bytes(base64.b64decode(picture["data"]))
        print("saved", name, flush=True)
        # A free model tier throttles when prompts come back to back, so leave a gap after each step.
        await asyncio.sleep(PACE)

    await call("Page.enable")
    await call("Emulation.setDeviceMetricsOverride", width=1440, height=900, deviceScaleFactor=2, mobile=False)
    await call("Page.navigate", url=URL)
    await asyncio.sleep(3)
    await js(HELPERS)
    await js("await fetch('/api/reset', { method: 'POST' }); localStorage.clear();")
    await call("Page.navigate", url=URL)
    await asyncio.sleep(3)
    await js(HELPERS)
    live = await js("return document.querySelector('.side__fine')?.textContent ?? ''")
    print("workspace says:", live[:60], flush=True)

    await shot("01-workspace")

    await js("""await L.send('Which five competitors should the Project X analysis cover? One line on each.');
                await L.until(() => L.title().includes('asked this before'), 'the repeat', 20000);""")
    await shot("18-you-asked-this-before")
    await js("await L.click('.bubble', 'Go to it'); await L.sleep(900);")

    await js("""const n = L.answers(); await L.send('Summarize how Stocksmith and Pantryline price their plans');
                await L.until(() => L.answers() > n, 'the first answer');""")

    await js("""const n = L.answers();
                await L.send('How did someone on the other team do something similar, and what did they use?');
                await L.until(() => L.answers() > n && document.querySelector('.know'), 'the answer from company records');
                document.querySelector('.know').scrollIntoView({ block: 'center' });""")
    await shot("19-answers-from-company-records")

    try:
        await js("""document.querySelector('.views__try').click(); await L.sleep(250);
                    await L.click('.views__menu', 'Ask Layers');
                    await L.ask('Where did I ask about pricing?');
                    await L.until(() => L.button('.bubble', 'Go to it'), 'the prompt it found', 60000);""")
        await shot("15-finds-it-by-following-the-branches")
        await js("""await L.ask('How have teammates done this?');
                    await L.until(() => document.querySelector('.b-procs'), 'how teammates did it', 60000);""")
        await shot("16-how-teammates-did-it")
    except RuntimeError as problem:
        print("skipped the Ask Layers pictures:", str(problem)[:90], flush=True)
    await js("document.querySelector('.bubble__close')?.click(); await L.sleep(900);")

    await js("""await L.send('Plan my ski vacation this weekend');
                await L.until(() => L.title().includes('unrelated'), 'the hold');
                await L.click('.bubble', 'Why was this held');""")
    await shot("02-held-with-the-reason")

    await js("""await L.click('.bubble', 'Ask Michael');
                await L.until(() => document.querySelector('.composer__hold')?.textContent.includes('Waiting'), 'the request');
                location.hash = '#manager';
                await L.until(() => document.querySelector('.mgr__req'), 'the manager page');""")
    await shot("11-manager-needs-you", 1.5)

    await js("""await L.click('.mgr__acts', 'Decline'); await L.sleep(1200); location.hash = '';
                await L.until(() => L.title().includes('declined'), 'the decline');
                await L.click('.bubble', 'Back to Project X'); await L.sleep(900);""")

    await js("""await L.send('Draft an email to Michael with my status update');
                await L.until(() => L.title().includes('not sure'), 'the unsure question');""")
    await shot("03-not-sure-asks-you")
    await js("await L.click('.bubble', 'Back to Project X'); await L.sleep(900);")

    await js("""await L.send('Build me an Excel automation that compares our five competitors');
                await L.until(() => L.title().includes('already built'), 'the team workflow');
                await L.click('.bubble', 'Preview');""")
    await shot("04-team-already-built-it")

    await js("""await L.click('.bubble', 'Use it for Project X');
                await L.until(() => document.querySelector('.bubble .b-chip__text'), 'the finished workflow');
                await L.click('.bubble', 'What I did');""")
    await shot("05-agent-plan-and-tool-calls")
    await js("document.querySelector('.bubble__close')?.click(); await L.sleep(900);")

    await js("""let n = L.answers(); await L.send('Outline the presentation deck in five slides');
                await L.until(() => L.answers() > n, 'the deck answer'); await L.sleep(600);
                await L.send('What pricing gaps can we use against Stocksmith?');
                await L.until(() => L.title().includes('keep coming back'), 'the move to its own chat');""")
    await shot("06-moved-into-its-own-chat", 1.4)
    await js("await L.click('.bubble', 'Keep it'); await L.sleep(700);")

    await js("""document.querySelector('.topbar__branches').click();
                await L.until(() => document.querySelector('.bmap__stop'), 'the stopped prompt on the map', 10000);
                document.querySelector('.bmap__stop').click();""")
    await shot("07-branch-map")

    await js("""L.tab('Today'); await L.sleep(300); await L.click('.bpanel__update', 'Draft an update');
                await L.until(() => document.querySelector('.bpanel__draft'), 'the drafted update');""")
    await shot("08-update-waits-for-you")
    await js("""await L.click('.bpanel__update', 'Send to Michael');
                await L.until(() => document.querySelector('.bpanel__sent'), 'the sent update');""")

    await js("L.tab('Agent'); await L.until(() => !document.querySelector('.toast'), 'the note to clear', 15000);")
    await shot("09-how-the-agent-works")
    await js("""const runs = [...document.querySelectorAll('.bpanel__runs details')];
                const reviewed = runs.find((r) => r.textContent.includes('Applied')) ?? runs[0];
                reviewed.open = true; await L.sleep(200);
                const body = document.querySelector('.bpanel__body');
                body.scrollTop += reviewed.getBoundingClientRect().top - body.getBoundingClientRect().top - 60;""")
    await shot("10-what-the-agent-did")

    await js("""window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await L.sleep(400);
                location.hash = '#manager'; await L.until(() => document.querySelector('.mgr__updates'), 'the update on the manager page');
                document.querySelector('.mgr').scrollTo(0, document.getElementById('team').offsetTop - 84);""")
    await shot("12-manager-team-and-person", 1.5)
    await js("""document.querySelector('.mgr__more').click(); await L.sleep(300);
                document.querySelector('.mgr').scrollTo(0, document.getElementById('audit').offsetTop - 84);""")
    await shot("13-audit-trail")
    await js("""const mgr = document.querySelector('.mgr');
                mgr.scrollTo(0, document.getElementById('person').offsetTop - 84); await L.sleep(300);
                const names = [...document.querySelectorAll('.bmap__names button')];
                (names.find((b) => b.textContent.includes('Analysis')) ?? names[0]).click(); await L.sleep(400);
                mgr.scrollTo(0, document.querySelector('.bmap').getBoundingClientRect().top + mgr.scrollTop - 300);""")
    await shot("17-manager-clicks-a-line")

    await js("location.hash = '#both'; await L.sleep(3500);")
    await shot("14-side-by-side", 1.0)


async def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    profile = tempfile.mkdtemp(prefix="layers-shots-")
    chrome = subprocess.Popen(
        [CHROME, "--headless=new", f"--remote-debugging-port={PORT}", f"--user-data-dir={profile}",
         "--window-size=1440,900", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        targets = []
        for _ in range(60):
            try:
                targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json"))
                if any(t["type"] == "page" for t in targets):
                    break
            except OSError:
                pass
            time.sleep(0.25)
        page = next(t for t in targets if t["type"] == "page")
        async with websockets.connect(page["webSocketDebuggerUrl"], max_size=None) as ws:
            await session(ws)
    finally:
        chrome.terminate()
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    asyncio.run(main())
