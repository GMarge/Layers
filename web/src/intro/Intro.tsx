import { type CSSProperties, useEffect, useState } from 'react';
import { EdgeGlow, type GlowMode } from '../layers/EdgeGlow';
import { MascotGlyph } from '../layers/Mascot';

/**
 * The screen to leave up between demos. It shows how a prompt moves through Layers, one
 * example at a time, and has one button to start the live demo.
 *
 * The path is drawn the way the product draws a conversation: dots on a line, and a red
 * dead end where a prompt was stopped.
 */

type Tone = 'go' | 'stop' | 'ask';
type StageId = 'send' | 'gate' | 'agent' | 'person' | 'work';

const STAGES: { id: StageId; name: string; does: string }[] = [
  { id: 'send', name: 'You press Send', does: 'Layers reads a prompt at this moment, and at no other.' },
  { id: 'gate', name: 'The gate', does: 'Plain code. It decides what may be sent, and no model can overrule it.' },
  { id: 'agent', name: 'The agent', does: 'A LangChain DeepAgent. It looks when the gate cannot tell, with a plan and tools.' },
  { id: 'person', name: 'A person', does: 'You or your manager approve anything the agent wants to create or send.' },
  { id: 'work', name: 'The work', does: 'The answer, or the document, lands in the project.' },
];

interface Story {
  prompt: string;
  /** The stages this prompt reaches, and how each one turns out. */
  path: Partial<Record<StageId, Tone>>;
  says: Partial<Record<StageId, string>>;
  line: string;
  glow: GlowMode;
}

const STORIES: Story[] = [
  {
    prompt: 'Summarize how Stocksmith prices its plans',
    path: { send: 'go', gate: 'go', work: 'go' },
    says: { gate: 'On the project', work: 'Answered' },
    line: 'On the project. The gate lets it through in code: no agent, no wait, no extra model call.',
    glow: 'ambient',
  },
  {
    prompt: 'Plan my ski vacation this weekend',
    path: { send: 'go', gate: 'stop' },
    says: { gate: 'Held under rule AI-01' },
    line: 'Off the project. Held at the gate, with the rule and the exact words that triggered it. Nothing is sent.',
    glow: 'policy',
  },
  {
    prompt: 'Make that shorter',
    path: { send: 'go', gate: 'ask', agent: 'go', work: 'go' },
    says: { gate: 'Cannot tell', agent: 'Reads the conversation', work: 'Answered' },
    line: 'No project words, so the agent reads the brief and the conversation, then lets it through.',
    glow: 'checking',
  },
  {
    prompt: 'Build me a spreadsheet that compares our competitors',
    path: { send: 'go', gate: 'ask', agent: 'go', person: 'go', work: 'go' },
    says: { gate: 'The team has this', agent: 'Plans, checks access, pauses', person: 'You approve', work: 'Sheet built' },
    line: 'A teammate already built this. The agent plans, checks access, and stops until you approve.',
    glow: 'working',
  },
  {
    prompt: 'Draft an email with my status update',
    path: { send: 'go', gate: 'ask', agent: 'ask', person: 'go', work: 'go' },
    says: { gate: 'Could be either', agent: 'Asks one question', person: 'You explain, or your manager decides', work: 'Sent' },
    line: 'It could be work or not. The agent asks the one question that would settle it, and the company decides who answers.',
    glow: 'unsure',
  },
  {
    prompt: 'How do Stocksmith and Pantryline price their plans?',
    path: { send: 'go', gate: 'ask', agent: 'stop' },
    says: { gate: 'Looks familiar', agent: 'Already asked, in Analysis' },
    line: 'Asked before in other words. The agent checks its memory and points back to it, so it is not answered twice.',
    glow: 'knowledge',
  },
];

/** Timing, in milliseconds: the wait before the first stage, the gap between stages, and how long the result stays up. */
const FIRST = 700;
const EACH = 750;
const HOLD = 3600;
/** The line takes this long to cross a stage it does not stop at, and this long to arrive. */
const HOP = 160;
const DRAW = 300;

export function Intro() {
  const [at, setAt] = useState(0);
  /** How many stages of this example's path have lit up so far. */
  const [step, setStep] = useState(0);
  /**
   * Whether the Layers server is answering. Without it the workspace runs its scripted preview,
   * and the button says so. The first guess is by address, so the label does not flicker.
   */
  const [live, setLive] = useState(() => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname));
  const story = STORIES[at]!;
  /** The stages on this example's path, as positions along the line. */
  const stops = STAGES.flatMap((stage, i) => (story.path[stage.id] ? [i] : []));
  const reached = step > 0 ? stops[step - 1]! : -1;
  const before = step > 1 ? stops[step - 2]! : -1;
  const total = FIRST + stops.length * EACH + HOLD;
  const done = step >= stops.length;

  /** Both at once, so a new example never shows a frame of the last one's lights. */
  const show = (i: number) => {
    setStep(0);
    setAt((i + STORIES.length) % STORIES.length);
  };

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setStep(stops.length);
      return;
    }
    const timers = stops.map((_, i) => window.setTimeout(() => setStep(i + 1), FIRST + i * EACH));
    const next = window.setTimeout(() => show(at + 1), total);
    return () => {
      timers.forEach(clearTimeout);
      clearTimeout(next);
    };
    // One run per example. The path is fixed by the example.
  }, [at]);

  useEffect(() => {
    let here = true;
    fetch('/api/health')
      .then((r) => (r.ok ? r.json() : null))
      .then((health: { ok?: boolean } | null) => here && setLive(health?.ok === true))
      .catch(() => here && setLive(false));
    return () => {
      here = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const on = e.target as HTMLElement | null;
      if (e.key === 'Enter' && !on?.closest?.('a, button')) window.location.hash = '';
      else if (e.key === 'ArrowRight') show(at + 1);
      else if (e.key === 'ArrowLeft') show(at - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [at]);

  /** A stage the line is only now arriving at waits for the line to get there. */
  const arriving = (j: number) => j > before && j <= reached;
  const wait = (j: number) => (arriving(j) ? (j - before - 1) * HOP : 0);

  return (
    <div className="root">
      <main className="intro">
        <header className="intro__head">
          <p className="intro__brand">
            <MascotGlyph shape="drop" />
            Layers
          </p>
          <h1>
            AI does the work. <span>Layers manages the work.</span>
          </h1>
          <p className="intro__sub">
            A management layer on a company's AI workspace. It checks every prompt when you press Send, points to what
            the team already built, and asks a person before anything is created or sent.
          </p>
        </header>

        <section className="intro__flow" aria-label="How a prompt moves through Layers">
          <div className="intro__box" data-sent={step > 0 ? '' : undefined}>
            <p className="intro__prompt" key={at}>
              {story.prompt}
            </p>
            <span className="intro__send" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 16 16">
                <path d="M8 13V3.5M3.8 7.4 8 3.2l4.2 4.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </div>

          <ol className="intro__track" key={at}>
            {STAGES.map((stage, j) => {
              const tone = story.path[stage.id];
              const on = !!tone && j <= reached;
              const timing = {
                '--line-d': `${wait(j + 1)}ms`,
                '--node-d': `${j > 0 && arriving(j) ? wait(j) + DRAW : 0}ms`,
              } as CSSProperties;
              return (
                <li
                  key={stage.id}
                  data-tone={on ? tone : undefined}
                  data-pass={!tone && j < reached ? '' : undefined}
                  data-skip={tone ? undefined : ''}
                  data-out={j < reached ? '' : undefined}
                  style={timing}
                >
                  <span className="intro__node" aria-hidden="true" />
                  <h2>{stage.name}</h2>
                  <p className="intro__does">{stage.does}</p>
                  <p className="intro__says">{on ? story.says[stage.id] : ''}</p>
                </li>
              );
            })}
          </ol>

          <p className="intro__line" key={`line-${at}`} data-on={done ? '' : undefined}>
            {story.line}
          </p>

          <div className="intro__picks" role="group" aria-label="Examples" style={{ '--dur': `${total}ms` } as CSSProperties}>
            {STORIES.map((s, i) => (
              <button key={s.prompt} type="button" aria-pressed={i === at} aria-label={`Example ${i + 1}: ${s.prompt}`} onClick={() => show(i)} />
            ))}
          </div>
        </section>

        <section className="intro__memory" aria-label="What it remembers">
          <ul>
            <li>
              <b>The conversation, as a map.</b> Every prompt is a dot on a branch, so a repeat is pointed back to.
            </li>
            <li>
              <b>How the team works.</b> The steps teammates took and what they reused.
            </li>
            <li>
              <b>What you taught it.</b> Explain a prompt once and that kind is not questioned again.
            </li>
            <li>
              <b>Everything it did.</b> Each check, tool call and approval, logged without what was typed.
            </li>
          </ul>
        </section>

        <footer className="intro__foot">
          <a className="intro__start" href="#">
            {live ? 'Start the live demo' : 'Try the scripted preview'}
            <kbd>Enter</kbd>
          </a>
          <a className="intro__more" href="#manager">
            See the manager's side
          </a>
          <p>The gate is code. The agent is one DeepAgent with fourteen tools. The pause is the framework's own.</p>
        </footer>
      </main>
      <EdgeGlow mode={done ? story.glow : 'ambient'} variant="glow" quiet={false} />
    </div>
  );
}
