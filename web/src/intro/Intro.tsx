import { useEffect, useState } from 'react';
import { EdgeGlow, type GlowMode } from '../layers/EdgeGlow';
import { MascotGlyph } from '../layers/Mascot';

/**
 * The screen to leave up between demos. It shows how a prompt moves through Layers, one
 * example at a time, and has one button to start the live demo.
 */

type Tone = 'go' | 'stop' | 'ask';
type StageId = 'send' | 'gate' | 'agent' | 'person' | 'work';

const STAGES: { id: StageId; name: string; kind: string; does: string }[] = [
  { id: 'send', name: 'You press Send', kind: 'The employee', does: 'Layers reads a prompt at this moment, and at no other.' },
  { id: 'gate', name: 'The gate', kind: 'Plain code', does: 'Decides what may be sent. No model can overrule it.' },
  { id: 'agent', name: 'The agent', kind: 'A LangChain DeepAgent', does: 'Looks when the gate cannot tell. It plans, uses its tools and remembers.' },
  { id: 'person', name: 'A person', kind: 'You, or your manager', does: 'Approves anything the agent wants to create or send.' },
  { id: 'work', name: 'The work', kind: 'The workspace model', does: 'The answer, or the document, lands in the project.' },
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

export function Intro() {
  const [at, setAt] = useState(0);
  /** How many stages of this example's path have lit up so far. */
  const [step, setStep] = useState(0);
  const story = STORIES[at]!;
  const path = STAGES.filter((s) => story.path[s.id]);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setStep(path.length);
      return;
    }
    setStep(0);
    const timers = path.map((_, i) => window.setTimeout(() => setStep(i + 1), 700 + i * 750));
    const next = window.setTimeout(() => setAt((a) => (a + 1) % STORIES.length), 700 + path.length * 750 + 3600);
    return () => {
      timers.forEach(clearTimeout);
      clearTimeout(next);
    };
    // One run per example. The path is fixed by the example.
  }, [at]);

  const done = step >= path.length;

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
          <p className="intro__prompt" key={at}>
            <span>Someone types</span>
            {story.prompt}
          </p>

          <ol className="intro__stages">
            {STAGES.map((stage) => {
              const tone = story.path[stage.id];
              const on = !!tone && path.findIndex((s) => s.id === stage.id) < step;
              return (
                <li key={stage.id} data-tone={on ? tone : undefined} data-skip={tone ? undefined : ''}>
                  <p className="intro__kind">{stage.kind}</p>
                  <h2>{stage.name}</h2>
                  <p className="intro__does">{stage.does}</p>
                  <p className="intro__says">{on ? story.says[stage.id] : ''}</p>
                </li>
              );
            })}
          </ol>

          <p className="intro__line" data-on={done ? '' : undefined}>
            {story.line}
          </p>

          <div className="intro__dots" role="group" aria-label="Examples">
            {STORIES.map((s, i) => (
              <button key={s.prompt} type="button" aria-pressed={i === at} aria-label={`Example ${i + 1}: ${s.prompt}`} onClick={() => setAt(i)} />
            ))}
          </div>
        </section>

        <section className="intro__memory" aria-label="What it remembers">
          <ul>
            <li>
              <b>The conversation, as a map.</b> Every prompt is a dot on a branch. A question already asked is pointed
              back to.
            </li>
            <li>
              <b>How the team works.</b> The steps teammates took and what they reused, offered to the next person.
            </li>
            <li>
              <b>What you taught it.</b> Explain a prompt once, and that kind is not questioned again.
            </li>
            <li>
              <b>Everything it did.</b> Each check, tool call and approval is logged for the manager, without what was
              typed.
            </li>
          </ul>
        </section>

        <footer className="intro__foot">
          <a className="intro__start" href="#">
            Start the live demo
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
