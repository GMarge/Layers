import { useEffect, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { ArrowUp, Check, Close } from '../ui/icons';
import { manager, project, rules } from '../workspace/data';
import { DEFAULT_NAME, type EyeStyle, type OutlineStyle } from './prefs';
import { MascotGlyph, SHAPES, type Shape } from './Mascot';
import type { Counters, KnowledgeItem, PolicyMode, RestMode, Scene, Signals, Step, Todo, UnsureMode } from './types';

export type BubblePlacement = 'right' | 'above';

/** What the employee can choose for themselves, plus the two things the company decides. */
export interface Prefs {
  shape: Shape;
  eyes: EyeStyle;
  rest: RestMode;
  outline: OutlineStyle;
  policyMode: PolicyMode;
  unsureMode: UnsureMode;
  /** What the employee calls the agent. */
  name: string;
  /** When a new direction is noticed: say so, or just put it on the map. */
  branchMode: 'ask' | 'auto';
}

export interface BubbleActions {
  backToProject(): void;
  askApproval(): void;
  sendAnyway(): void;
  markRelated(): void;
  toggleRule(): void;
  applyWorkflow(): void;
  togglePreview(): void;
  buildAnyway(): void;
  undoWorkflow(): void;
  toggleSteps(): void;
  /** Ask Layers a question without sending anything to the workspace model. */
  ask(question: string): void;
  /** Check the draft in the chat box without sending it. */
  precheck(): void;
  requestFromAsk(): void;
  useFromAsk(): void;
  sendDraft(): void;
  /** Send a prompt Layers was unsure about, with the employee's reason attached. */
  sendWithNote(note: string): void;
  openSettings(): void;
  /** Fold a direction Layers split off back into the main line. */
  mergeBranch(lineId: string): void;
  /** Make a direction Layers split off into a chat of its own. */
  detachBranch(lineId: string): void;
  /** Put a chat Layers made back inside the chat it came from. */
  foldBranch(lineId: string): void;
  /** Leave a line where it is, and stop offering to move it. */
  leaveBranch(lineId: string): void;
  /** Open the page with the branch map. */
  openBranches(): void;
  setPrefs(change: Partial<Pick<Prefs, 'shape' | 'eyes' | 'rest' | 'outline' | 'name' | 'branchMode'>>): void;
  /** Only in the preview without a server: answer a request as the manager would. */
  previewDecide?(approved: boolean): void;
  /** Hide the agent completely, or bring it back. */
  toggleHidden(): void;
  dismiss(): void;
}

interface View {
  /** One-line chip instead of a full bubble. */
  compact?: boolean;
  /** Move keyboard focus here because the employee has to decide something. */
  takeFocus?: boolean;
  dismissible?: boolean;
  shortcuts?: Record<string, () => void>;
  node: ReactNode;
}

interface Context {
  prefs: Prefs;
  counters: Counters;
  hasDraft: boolean;
  a: BubbleActions;
}

const SUGGESTIONS = ['What are my limits here?', 'Can I plan personal travel?', 'Has my team built a competitor matrix?'];

/** A scene is a chip when it only needs one line. */
export function isCompact(scene: Scene): boolean {
  return scene.name === 'checking' || (scene.name === 'done' && !scene.showSteps);
}

function Act(props: { children: ReactNode; hint?: string; primary?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={props.primary ? 'act act--primary' : 'act'} onClick={props.onClick}>
      <span>{props.children}</span>
      {props.hint && <kbd aria-hidden="true">{props.hint}</kbd>}
    </button>
  );
}

/** The words that pushed the decision each way, so the reasoning is never a black box. */
function SignalList({ signals }: { signals: Signals }) {
  if (signals.fits.length === 0 && signals.against.length === 0) return null;
  return (
    <dl className="b-signals">
      {signals.fits.length > 0 && (
        <div data-side="fits">
          <dt>Fits {project.name}</dt>
          {signals.fits.map((w) => (
            <dd key={w}>{w}</dd>
          ))}
        </div>
      )}
      {signals.against.length > 0 && (
        <div data-side="against">
          <dt>Not in the brief</dt>
          {signals.against.map((w) => (
            <dd key={w}>{w}</dd>
          ))}
        </div>
      )}
    </dl>
  );
}

function Choice<T extends string>(props: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (value: T) => void;
}) {
  return (
    <div className="b-set">
      <span>{props.label}</span>
      <div className="b-seg" role="group" aria-label={props.label}>
        {props.options.map(([value, text]) => (
          <button key={value} type="button" aria-pressed={value === props.value} onClick={() => props.onChange(value)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

/** When Layers cannot tell, the employee explains the connection and decides. */
function UnsureForm({ a }: { a: BubbleActions }) {
  const [note, setNote] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (note.trim()) a.sendWithNote(note.trim());
      }}
    >
      <div className="b-main b-main--flush">
        <div className="b-ask">
          <input
            type="text"
            value={note}
            placeholder={`How does it connect to ${project.name}?`}
            aria-label={`How this connects to ${project.name}`}
            autoComplete="off"
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <p className="b-fine">
          Your company lets you decide when I can't tell. Your reason is logged with the prompt.{' '}
          <button type="button" className="b-link" onClick={a.askApproval}>
            Ask {manager.first} to decide instead
          </button>
        </p>
      </div>
      <div className="b-actions">
        <button type="submit" className="act act--primary" disabled={!note.trim()}>
          <span>Send with my reason</span>
        </button>
        <Act onClick={a.backToProject}>Back to {project.name}</Act>
      </div>
    </form>
  );
}

const POLICY_TEXT: Record<PolicyMode, string> = {
  approval: 'Held until your manager approves',
  warn: 'You are warned and can still send',
};

const UNSURE_TEXT: Record<UnsureMode, string> = {
  ask: 'I ask you, and you decide',
  allow: 'It is sent and logged for review',
  defer: 'A person reviews it before it is sent',
};

function ItemCard({ item }: { item: KnowledgeItem }) {
  return (
    <div className="b-item">
      <p className="b-item__name">
        <code>{item.name}</code>
        <span className="b-tag">{item.kind}</span>
      </p>
      <p className="b-text">{item.summary}</p>
      <p className="b-fine">
        By {item.author}, {item.team}. Reviewed {item.reviewedOn}. You have access.
      </p>
    </div>
  );
}

function RuleList() {
  return (
    <ul className="b-rules">
      {rules.map((r) => (
        <li key={r.id}>
          <code>{r.id}</code>
          <span>
            <b>{r.name}.</b> {r.text}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The agent's name. It can be cleared while typing, and falls back to Layers if left empty. */
function NameField({ name, onChange }: { name: string; onChange: (name: string) => void }) {
  const [value, setValue] = useState(name);
  return (
    <label className="b-set b-name">
      <span>Name</span>
      <input
        type="text"
        value={value}
        maxLength={16}
        placeholder={DEFAULT_NAME}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          setValue(e.target.value);
          onChange(e.target.value.trim() || DEFAULT_NAME);
        }}
        onBlur={() => setValue(value.trim() || DEFAULT_NAME)}
      />
    </label>
  );
}

function AskForm({ name, onAsk, disabled }: { name: string; onAsk: (question: string) => void; disabled: boolean }) {
  const [value, setValue] = useState('');
  return (
    <form
      className="b-ask"
      onSubmit={(e) => {
        e.preventDefault();
        if (!value.trim()) return;
        onAsk(value);
        setValue('');
      }}
    >
      <input
        type="text"
        value={value}
        placeholder="Am I allowed to…"
        aria-label={`Ask ${name}`}
        autoComplete="off"
        onChange={(e) => setValue(e.target.value)}
      />
      <button type="submit" aria-label="Ask" disabled={disabled || !value.trim()}>
        <ArrowUp />
      </button>
    </form>
  );
}

/** The to-do list the agent wrote for itself before starting, in its own words. */
export function Plan({ todos }: { todos?: Todo[] }) {
  if (!todos || todos.length === 0) return null;
  return (
    <div className="b-plan">
      <p className="b-fine">The agent's plan</p>
      <ol>
        {todos.map((t, i) => (
          <li key={i} data-status={t.status}>
            {t.content}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Each tool call the agent made, in plain English, with the real call underneath. */
export function Steps({ steps }: { steps: Step[] }) {
  if (steps.length === 0) {
    return (
      <p className="b-wait">
        <span className="ring" aria-hidden="true" />
        Starting
      </p>
    );
  }
  return (
    <ol className="steps">
      {steps.map((s) => (
        <li key={s.id} data-status={s.status}>
          <span className="steps__mark" aria-hidden="true">
            {s.status === 'done' && <Check />}
          </span>
          <span className="steps__body">
            <span className="steps__label">{s.label}</span>
            <code className="steps__tool">
              {s.tool}
              {s.detail ? `: ${s.detail}` : ''}
              {s.ms != null ? ` (${s.ms} ms)` : ''}
            </code>
          </span>
        </li>
      ))}
    </ol>
  );
}

function viewFor(scene: Scene, { prefs, counters, hasDraft, a }: Context): View | null {
  const mode = prefs.policyMode;
  switch (scene.name) {
    case 'ambient':
      return null;

    case 'checking':
      if (!scene.engaged) return null;
      return {
        compact: true,
        node: (
          <p className="b-line">
            <span className="ring" aria-hidden="true" />
            {scene.note ?? 'Checking this prompt'}
          </p>
        ),
      };

    case 'ask': {
      const ans = scene.answer;
      const fresh = !ans && !scene.busy;
      return {
        takeFocus: true,
        dismissible: true,
        node: (
          <>
            <div className="b-main">
              <h2 className="b-title">{fresh ? 'Ask me before you send.' : scene.question}</h2>
              {fresh && (
                <p className="b-text">
                  I can tell you what this workspace allows, where your limits are, and what your team has already
                  built. If something needs sign-off, I'll ask for you.
                </p>
              )}
              {scene.busy && (
                <p className="b-wait">
                  <span className="ring" aria-hidden="true" />
                  Checking the rules and team workflows
                </p>
              )}
              {ans && <p className="b-text">{ans.text}</p>}
              {ans?.rule && (
                <p className="b-rule">
                  <code>{ans.rule.id}</code>
                  {ans.rule.name}
                </p>
              )}
              {ans?.showLimits && <RuleList />}
              {ans?.item && <ItemCard item={ans.item} />}
              {ans?.requested && (
                <p className="b-fine">
                  Request <code>{ans.requested.id}</code> is with {ans.requested.approver}. Nothing is held while you
                  wait.
                </p>
              )}
              <AskForm name={prefs.name} onAsk={a.ask} disabled={scene.busy} />
              {fresh && (
                <div className="b-chips">
                  {hasDraft && (
                    <button type="button" onClick={a.precheck}>
                      Check my draft
                    </button>
                  )}
                  {SUGGESTIONS.map((s) => (
                    <button key={s} type="button" onClick={() => a.ask(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              )}
              <p className="b-foot">
                <span aria-label="This session">
                  {counters.checked} checked, {counters.held} held, {counters.reused} reused
                </span>
                <span className="b-foot__links">
                  <button type="button" className="b-link" onClick={a.openSettings}>
                    Settings
                  </button>
                  <button type="button" className="b-link" onClick={a.toggleHidden}>
                    Hide me
                  </button>
                </span>
              </p>
            </div>
            {ans?.item && (
              <div className="b-actions">
                <Act primary onClick={a.useFromAsk}>
                  Use it for {project.name}
                </Act>
              </div>
            )}
            {ans?.canRequest && !ans.requested && (
              <div className="b-actions">
                <Act primary onClick={a.requestFromAsk}>
                  Ask {manager.first} for me
                </Act>
              </div>
            )}
            {ans?.canSend && (
              <div className="b-actions">
                <Act primary onClick={a.sendDraft}>
                  Send it
                </Act>
              </div>
            )}
          </>
        ),
      };
    }

    case 'policy': {
      const needsApproval = mode === 'approval';
      return {
        takeFocus: true,
        dismissible: true,
        shortcuts: {
          b: a.backToProject,
          w: a.toggleRule,
          ...(needsApproval ? { a: a.askApproval } : { s: a.sendAnyway }),
        },
        node: (
          <>
            <div className="b-main">
              <h2 className="b-title">This looks unrelated to {project.name}.</h2>
              <p className="b-text">
                Nothing was sent, and your draft is still in the box.{' '}
                <button type="button" className="b-link" aria-expanded={scene.showRule} onClick={a.toggleRule}>
                  {scene.showRule ? 'Hide the rule' : 'Why was this held?'}
                </button>
              </p>
              {scene.showRule && (
                <div className="b-detail">
                  <p className="b-rule">
                    <code>{scene.rule.id}</code>
                    {scene.rule.name}
                  </p>
                  <p className="b-quote">{scene.rule.text}</p>
                  <p className="b-fine">
                    {scene.reason} Set by {scene.rule.owner}. {scene.rule.scope}. I compared the prompt you tried to
                    send with the {project.name} brief and looked at nothing else.
                  </p>
                  <SignalList signals={scene.signals} />
                  <button type="button" className="b-link" onClick={a.markRelated}>
                    It is related to {project.name}
                  </button>
                </div>
              )}
            </div>
            <div className="b-actions">
              <Act primary hint="B" onClick={a.backToProject}>
                Back to {project.name}
              </Act>
              {needsApproval ? (
                <Act hint="A" onClick={a.askApproval}>
                  Ask {manager.first}
                </Act>
              ) : (
                <Act hint="S" onClick={a.sendAnyway}>
                  Send anyway
                </Act>
              )}
            </div>
          </>
        ),
      };
    }

    case 'unsure':
      return {
        takeFocus: true,
        dismissible: true,
        node: (
          <>
            <div className="b-main">
              <h2 className="b-title">I'm not sure this fits {project.name}.</h2>
              <p className="b-text">{scene.reason} Nothing was sent yet.</p>
              <SignalList signals={scene.signals} />
            </div>
            <UnsureForm a={a} />
          </>
        ),
      };

    case 'branch':
      // Layers already moved it: say so, and make it one key to put back.
      if (scene.what === 'moved') {
        return {
          dismissible: true,
          shortcuts: { k: a.dismiss, u: () => a.foldBranch(scene.lineId) },
          takeFocus: true,
          node: (
            <>
              <div className="b-main">
                <h2 className="b-title">You keep coming back to {scene.label}.</h2>
                <p className="b-text">
                  So I gave it a chat of its own and moved its prompts there together. {scene.from} carries on without
                  them.
                </p>
                {scene.evidence && <p className="b-fine">{scene.evidence}</p>}
                <button type="button" className="b-link" onClick={a.openBranches}>
                  See the branch map
                </button>
              </div>
              <div className="b-actions">
                <Act primary hint="K" onClick={a.dismiss}>
                  Keep it
                </Act>
                <Act hint="U" onClick={() => a.foldBranch(scene.lineId)}>
                  Put it back
                </Act>
              </div>
            </>
          ),
        };
      }
      if (scene.what === 'offer') {
        return {
          dismissible: true,
          shortcuts: { m: () => a.detachBranch(scene.lineId), n: () => a.leaveBranch(scene.lineId) },
          takeFocus: true,
          node: (
            <>
              <div className="b-main">
                <h2 className="b-title">You keep coming back to {scene.label}.</h2>
                <p className="b-text">
                  Want it as a chat of its own? Its prompts move there together, and {scene.from} carries on without
                  them.
                </p>
                {scene.evidence && <p className="b-fine">{scene.evidence}</p>}
                <button type="button" className="b-link" onClick={a.openBranches}>
                  See the branch map
                </button>
              </div>
              <div className="b-actions">
                <Act primary hint="M" onClick={() => a.detachBranch(scene.lineId)}>
                  Make it a chat
                </Act>
                <Act hint="N" onClick={() => a.leaveBranch(scene.lineId)}>
                  Leave it
                </Act>
              </div>
            </>
          ),
        };
      }
      return {
        dismissible: true,
        shortcuts: { k: a.dismiss, m: () => a.mergeBranch(scene.lineId) },
        takeFocus: true,
        node: (
          <>
            <div className="b-main">
              <h2 className="b-title">This is a new direction: {scene.label}.</h2>
              <p className="b-text">
                I put it on its own branch so the earlier thread stays intact.{' '}
                <button type="button" className="b-link" onClick={a.openBranches}>
                  See the branch map
                </button>
              </p>
              <button type="button" className="b-link" onClick={() => a.detachBranch(scene.lineId)}>
                Make it a separate chat
              </button>
            </div>
            <div className="b-actions">
              <Act primary hint="K" onClick={a.dismiss}>
                Keep the branch
              </Act>
              <Act hint="M" onClick={() => a.mergeBranch(scene.lineId)}>
                Merge it back
              </Act>
            </div>
          </>
        ),
      };

    case 'settings':
      return {
        dismissible: true,
        node: (
          <div className="b-main">
            <h2 className="b-title">{prefs.name} settings</h2>
            <NameField name={prefs.name} onChange={(name) => a.setPrefs({ name })} />
            <div className="b-shapes" role="group" aria-label="How I look">
              {(Object.keys(SHAPES) as Shape[]).map((shape) => (
                <button
                  key={shape}
                  type="button"
                  aria-pressed={shape === prefs.shape}
                  aria-label={SHAPES[shape].name}
                  title={SHAPES[shape].name}
                  onClick={() => a.setPrefs({ shape })}
                >
                  <MascotGlyph shape={shape} />
                </button>
              ))}
            </div>
            <Choice
              label="Eyes"
              value={prefs.eyes}
              options={[
                ['oval', 'Oval'],
                ['dot', 'Dot'],
                ['wide', 'Wide'],
              ]}
              onChange={(eyes) => a.setPrefs({ eyes })}
            />
            <Choice
              label="I wait"
              value={prefs.rest}
              options={[
                ['absorbed', 'In chat box'],
                ['floating', 'Floating'],
                ['hidden', 'Hidden'],
              ]}
              onChange={(rest) => a.setPrefs({ rest })}
            />
            <Choice
              label="Outline"
              value={prefs.outline}
              options={[
                ['layers', 'Layers'],
                ['blue', 'Blue'],
              ]}
              onChange={(outline) => a.setPrefs({ outline })}
            />
            <Choice
              label="Branches"
              value={prefs.branchMode}
              options={[
                ['auto', 'Quietly'],
                ['ask', 'Tell me'],
              ]}
              onChange={(branchMode) => a.setPrefs({ branchMode })}
            />
            <p className="b-fine">
              Right-click me for the branch map, today so far, or to hide me. Right-click the same spot to bring me
              back, or press <kbd>Alt</kbd> <kbd>L</kbd>. Whatever I'm called and wherever I am, I still check each
              prompt when you press Send.
            </p>
            <div className="b-detail">
              <p className="b-rule">Set by {manager.name}'s team</p>
              <dl className="b-company">
                <div>
                  <dt>Off-project prompts</dt>
                  <dd>{POLICY_TEXT[prefs.policyMode]}</dd>
                </div>
                <div>
                  <dt>When I'm unsure</dt>
                  <dd>{UNSURE_TEXT[prefs.unsureMode]}</dd>
                </div>
              </dl>
            </div>
          </div>
        ),
      };

    case 'pending':
      return {
        takeFocus: true,
        dismissible: true,
        shortcuts: { b: a.backToProject },
        node: (
          <>
            <div className="b-main">
              <h2 className="b-title">Sent to {manager.first} for approval.</h2>
              <p className="b-text">
                Request <code>{scene.requestId}</code> is pending. Your draft stays in the box until {scene.approver}{' '}
                answers.
              </p>
              {scene.why && <p className="b-fine">{scene.why}</p>}
              {a.previewDecide && (
                <p className="b-fine">
                  This preview has no manager's page, so answer as {manager.first}:{' '}
                  <button type="button" className="b-link" onClick={() => a.previewDecide?.(true)}>
                    Approve
                  </button>{' '}
                  <button type="button" className="b-link" onClick={() => a.previewDecide?.(false)}>
                    Decline
                  </button>
                </p>
              )}
            </div>
            <div className="b-actions">
              <Act hint="B" onClick={a.backToProject}>
                Withdraw and go back
              </Act>
            </div>
          </>
        ),
      };

    case 'decided':
      if (scene.approved) {
        return {
          node: (
            <div className="b-main">
              <h2 className="b-title">{manager.first} approved it.</h2>
              <p className="b-text">Sending your prompt now.</p>
            </div>
          ),
        };
      }
      return {
        takeFocus: true,
        dismissible: true,
        shortcuts: { b: a.backToProject },
        node: (
          <>
            <div className="b-main">
              <h2 className="b-title">{manager.first} declined this one.</h2>
              <p className="b-text">Your draft is still in the box if you want to keep it.</p>
            </div>
            <div className="b-actions">
              <Act primary hint="B" onClick={a.backToProject}>
                Back to {project.name}
              </Act>
            </div>
          </>
        ),
      };

    case 'reuse': {
      const item = scene.item;
      return {
        takeFocus: true,
        dismissible: true,
        shortcuts: { u: a.applyWorkflow, p: a.togglePreview, n: a.buildAnyway },
        node: (
          <>
            <div className="b-main">
              <h2 className="b-title">Your team already built this.</h2>
              <ItemCard item={item} />
              {scene.showPreview && (
                <div className="b-detail">
                  <ul className="b-cols" aria-label="Columns">
                    {item.columns.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                  <p className="b-fine">
                    Needs {item.inputs.toLowerCase()}. Approved by {item.approvedBy}. {item.access}.
                  </p>
                </div>
              )}
              <button type="button" className="b-link" onClick={a.buildAnyway}>
                Build a new one anyway
              </button>
            </div>
            <div className="b-actions">
              <Act primary hint="U" onClick={a.applyWorkflow}>
                Use it for {project.name}
              </Act>
              <Act hint="P" onClick={a.togglePreview}>
                {scene.showPreview ? 'Hide preview' : 'Preview'}
              </Act>
            </div>
          </>
        ),
      };
    }

    case 'working':
      return {
        node: (
          <div className="b-main">
            <h2 className="b-title">
              Applying {scene.item.name} to {project.name}
            </h2>
            <Plan todos={scene.plan} />
            <Steps steps={scene.steps} />
          </div>
        ),
      };

    case 'done':
      if (!scene.showSteps) {
        return {
          compact: true,
          node: (
            <div className="b-chip">
              <span className="b-chip__ok" aria-hidden="true">
                <Check />
              </span>
              <span className="b-chip__text">{scene.summary}</span>
              <button type="button" className="b-chip__btn" onClick={a.toggleSteps}>
                What I did
              </button>
              <button type="button" className="b-chip__btn" onClick={a.undoWorkflow}>
                Undo
              </button>
              <button type="button" className="b-chip__btn" onClick={a.dismiss}>
                Done
              </button>
            </div>
          ),
        };
      }
      return {
        dismissible: true,
        node: (
          <>
            <div className="b-main">
              <h2 className="b-title">{scene.summary}</h2>
              <p className="b-text">{scene.detail}</p>
              <Plan todos={scene.plan} />
              <Steps steps={scene.steps} />
            </div>
            <div className="b-actions">
              <Act onClick={a.toggleSteps}>Hide details</Act>
              <Act onClick={a.undoWorkflow}>Undo</Act>
            </div>
          </>
        ),
      };
  }
}

interface Props {
  scene: Scene;
  placement: BubblePlacement;
  counters: Counters;
  prefs: Prefs;
  hasDraft: boolean;
  actions: BubbleActions;
  bubbleRef: RefObject<HTMLDivElement | null>;
}

export function Bubble({ scene, placement, counters, prefs, hasDraft, actions, bubbleRef }: Props) {
  const view = viewFor(scene, { prefs, counters, hasDraft, a: actions });
  const focusKey = view?.takeFocus ? scene.name : null;

  // Focus goes to the question field when there is one, otherwise to the bubble itself
  // so its single-key shortcuts work without stealing an accidental Enter.
  useEffect(() => {
    if (!focusKey) return;
    const el = bubbleRef.current;
    (el?.querySelector<HTMLInputElement>('input') ?? el)?.focus({ preventScroll: true });
  }, [focusKey, bubbleRef]);

  if (!view) return null;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const run = view.shortcuts?.[e.key.toLowerCase()];
    if (run) {
      e.preventDefault();
      run();
    }
  };

  return (
    <div
      ref={bubbleRef}
      className="bubble"
      data-placement={placement}
      data-compact={view.compact ? '' : undefined}
      role="dialog"
      aria-label={prefs.name}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="bubble__content" key={scene.name}>
        {view.node}
      </div>
      {view.dismissible && (
        <button type="button" className="bubble__close" aria-label="Dismiss" onClick={actions.dismiss}>
          <Close />
        </button>
      )}
    </div>
  );
}
