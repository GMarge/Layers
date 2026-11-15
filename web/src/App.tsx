import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { BranchPanel, type PanelTab } from './branches/BranchPanel';
import {
  addPrompt,
  branchFrom,
  chatOf,
  chatTitle,
  chatsOf,
  earnsChat,
  fold,
  isVisible,
  lastLineIn,
  lineLabel,
  mergeAll,
  mergeBack,
  openLines,
  outlineOf,
  promote,
  seedTree,
  settle,
  type TopicHint,
  type Tree,
} from './branches/model';
import { defaultSettings, loadName, saveName, type GlowLevel, type Settings } from './layers/prefs';
import { AgentCluster } from './layers/AgentCluster';
import type { BubbleActions, Prefs } from './layers/Bubble';
import { EdgeGlow, type GlowMode } from './layers/EdgeGlow';
import { connect, type BackendStatus } from './layers/apiService';
import { createMockService } from './layers/mockService';
import { Toast, type ToastState } from './layers/Toast';
import type {
  AgentEvent,
  AgentRun,
  Counters,
  Hold,
  KnowledgeItem,
  Message,
  PolicyMode,
  RestMode,
  Scene,
  Step,
  Task,
  Todo,
  UnsureMode,
  UpdateState,
  Verdict,
} from './layers/types';
import { useMediaQuery } from './ui/useMediaQuery';
import { conversations, manager, project, seedMessages, seedTasks, tryPrompts } from './workspace/data';
import { Workspace, type ForkMark } from './workspace/Workspace';

/** What the first chat is called. Branches that become chats are named after their direction. */
const ROOT_TITLE = conversations[0]!;

const SESSION_KEY = 'layers.session.v1';

/** What survives a refresh: the conversation, its branches, the tasks and the counts. */
interface Saved {
  messages: Message[];
  tree: Tree;
  tasks: Task[];
  counters: Counters;
  seq: number;
  /** When this was written, so a workspace coming back on screen can tell if it is behind. */
  at: number;
  /** A request that was with the manager when the page closed. */
  pending?: Extract<Scene, { name: 'pending' }>;
  /** What the agent did, most recent first. */
  runs?: AgentRun[];
}

const NO_UPDATE: UpdateState = { phase: 'idle', text: '', thread: null, by: 'code', steps: [] };

const OUTCOME: Record<Verdict['kind'], string> = {
  pass: 'Cleared. It went to the workspace model.',
  policy: 'Held under rule AI-01. Nothing was sent.',
  unsure: 'Could not tell if it is project work, so it asked.',
  reuse: 'Found an approved team workflow and offered it instead.',
};

function loadSession(): Saved | null {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as Saved | null;
    const sound =
      !!s &&
      Array.isArray(s.messages) &&
      Array.isArray(s.tasks) &&
      Array.isArray(s.tree?.lines) &&
      Array.isArray(s.tree?.nodes) &&
      s.tree.lines.every((l) => typeof l.visits === 'number') &&
      typeof s.seq === 'number';
    return sound ? s : null;
  } catch {
    return null;
  }
}

const NO_COUNTS: Counters = { checked: 0, held: 0, reused: 0 };
const GLOW: Record<GlowLevel, number> = { soft: 0.6, standard: 1, bold: 1.5 };

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const upsert = (steps: Step[], step: Step) =>
  steps.some((s) => s.id === step.id) ? steps.map((s) => (s.id === step.id ? step : s)) : [...steps, step];

function glowFor(scene: Scene): GlowMode {
  switch (scene.name) {
    case 'checking':
    case 'ask':
      return 'checking';
    case 'branch':
      return 'knowledge';
    case 'unsure':
      return 'unsure';
    case 'policy':
    case 'pending':
      return 'policy';
    case 'decided':
      return scene.approved ? 'done' : 'policy';
    case 'reuse':
      return 'knowledge';
    case 'working':
      return 'working';
    case 'done':
      return 'done';
    default:
      return 'ambient';
  }
}

/** One-line summary of the current scene for screen readers. */
function announce(scene: Scene, name: string): string {
  switch (scene.name) {
    case 'policy':
      return `${name} held your prompt. It looks unrelated to ${project.name}. Nothing was sent.`;
    case 'branch':
      return scene.what === 'noticed'
        ? `${name} noticed a new direction: ${scene.label}.`
        : scene.what === 'moved'
          ? `${name} moved ${scene.label} into a chat of its own.`
          : `${name} asks whether ${scene.label} should be a chat of its own.`;
    case 'unsure':
      return `${name} is not sure this fits ${project.name}. Nothing was sent.`;
    case 'pending':
      return `Approval request ${scene.requestId} sent to ${scene.approver}.`;
    case 'decided':
      return scene.approved ? `${scene.approver} approved your request.` : `${scene.approver} declined your request.`;
    case 'reuse':
      return `${name} found an approved team workflow: ${scene.item.name}.`;
    case 'working':
      return `${name} is applying ${scene.item.name}.`;
    case 'done':
      return scene.summary;
    default:
      return '';
  }
}

/**
 * `active` is false while this workspace is mounted but not the one on screen, as on the
 * manager's page. A workspace nobody is using must not tell the server anything.
 */
export default function App({ active = true }: { active?: boolean }) {
  // Whatever was saved the last time this workspace was open, so a refresh loses nothing.
  const [saved] = useState(loadSession);
  const [messages, setMessages] = useState<Message[]>(saved?.messages ?? seedMessages);
  const [tasks, setTasks] = useState<Task[]>(saved?.tasks ?? seedTasks);
  const [draft, setDraft] = useState(saved?.pending?.prompt ?? '');
  const [hold, setHold] = useState<Hold | null>(
    saved?.pending
      ? { kind: 'pending', label: `Waiting on ${saved.pending.approver}. Request ${saved.pending.requestId}.` }
      : null,
  );
  const [setAside, setSetAside] = useState<string | null>(null);
  const [scene, setScene] = useState<Scene>(saved?.pending ?? { name: 'ambient' });
  const [toast, setToast] = useState<ToastState | null>(null);
  const [counters, setCounters] = useState<Counters>(saved?.counters ?? NO_COUNTS);
  const [runs, setRuns] = useState<AgentRun[]>(saved?.runs ?? []);
  const logRun = (run: Omit<AgentRun, 'id' | 'at'>) =>
    setRuns((all) => [{ ...run, id: crypto.randomUUID(), at: Date.now() }, ...all].slice(0, 20));
  const [nod, setNod] = useState(0);
  /** True while the agent is melted into the chat box. */
  const [absorbed, setAbsorbed] = useState(false);
  /** Room the chat leaves above the chat box so Layers never covers a message. */
  const [reserve, setReserve] = useState(0);
  /** The agent is being held over the chat box. */
  const [dropReady, setDropReady] = useState(false);
  const [lab, setLab] = useState<Settings>(() => ({ ...defaultSettings, name: loadName() }));
  const name = lab.name;
  useEffect(() => saveName(name), [name]);
  /** The branch map and today-so-far page, when it is open. */
  const [panel, setPanel] = useState<PanelTab | null>(null);

  /** Bumped whenever the current flow is superseded, so late async work can tell it is stale. */
  const run = useRef(0);
  const abort = useRef<AbortController | null>(null);
  /** The intervention the employee dismissed without resolving, so Review can bring it back. */
  const stash = useRef<Scene | null>(null);

  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const modeRef = useRef(lab.policyMode);
  modeRef.current = lab.policyMode;
  const unsureRef = useRef(lab.unsureMode);
  unsureRef.current = lab.unsureMode;
  /** Where the agent was resting before it was hidden, so it can go back there. */
  const restBeforeHide = useRef<Exclude<RestMode, 'hidden'>>('absorbed');

  // The real Layers server is used when it is running. Otherwise the scripted stand-in is.
  const mock = useMemo(() => createMockService(), []);
  const [service, setService] = useState(mock);
  const [backend, setBackend] = useState<BackendStatus | null>(null);
  useEffect(() => {
    let live = true;
    void connect().then((found) => {
      if (!live || !found) return;
      setService(found.service);
      setBackend(found.status);
    });
    return () => {
      live = false;
    };
  }, []);

  // The company's choices live on the server, which is what actually enforces them.
  // The manager can change them from their page, so this workspace reads them back and follows.
  const known = useRef<{ policyMode: PolicyMode; unsureMode: UnsureMode } | null>(null);
  /** Just after a change made here, an older answer from the server is not allowed to undo it. */
  const quietUntil = useRef(0);
  useEffect(() => {
    if (!active || !service.settings) return;
    const read = service.settings;
    let live = true;
    const pull = () =>
      void read()
        .then((s) => {
          if (!live || Date.now() < quietUntil.current) return;
          const before = known.current;
          known.current = s;
          setLab((l) => (l.policyMode === s.policyMode && l.unsureMode === s.unsureMode ? l : { ...l, ...s }));
          if (before && (before.policyMode !== s.policyMode || before.unsureMode !== s.unsureMode)) {
            setToast({ id: Date.now(), text: `${manager.first} changed a workspace rule. It applies from your next prompt.` });
          }
        })
        .catch(() => {});
    pull();
    const timer = setInterval(pull, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [active, service]);

  useEffect(() => {
    if (!active || !service.sync) return;
    // Until the server's own choices have been read, there is nothing here worth sending.
    if (service.settings && !known.current) return;
    const k = known.current;
    if (k && k.policyMode === lab.policyMode && k.unsureMode === lab.unsureMode) return;
    known.current = { policyMode: lab.policyMode, unsureMode: lab.unsureMode };
    quietUntil.current = Date.now() + 2500;
    void service.sync({ policyMode: lab.policyMode, unsureMode: lab.unsureMode });
  }, [active, service, lab.policyMode, lab.unsureMode]);

  /** The latest thing told to the server. Sending waits for it, so the gate sees it first. */
  const settled = useRef<Promise<unknown>>(Promise.resolve());
  const tell = (kind: Parameters<typeof service.recordFeedback>[0], prompt: string, note?: string) => {
    settled.current = service.recordFeedback(kind, prompt, note).catch(() => {});
  };

  const systemReduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const reduced = systemReduced;

  // The shape of the conversation: which prompts sit on which branch.
  const [tree, setTree] = useState<Tree>(() => saved?.tree ?? seedTree(seedMessages[0]!.text ?? ''));
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const seq = useRef(saved?.seq ?? seedMessages.length);
  const branchModeRef = useRef(lab.branchMode);
  branchModeRef.current = lab.branchMode;

  const changeTree = (next: Tree) => {
    treeRef.current = next;
    setTree(next);
  };

  // The manager sees the shape of the branches: how many, of what kind, on which part of
  // the project. The prompts themselves are not in what is sent.
  useEffect(() => {
    if (active) void service.branches?.(outlineOf(tree)).catch(() => {});
  }, [active, service, tree]);

  /** The direction the conversation is on, and the others this chat has taken, by name. */
  const where = () => {
    const t = treeRef.current;
    const chat = chatOf(t, t.active);
    const current = t.lines.find((l) => l.id === t.active)!;
    const near = (l: (typeof t.lines)[number]) =>
      chatOf(t, l.id) === chat || (!!l.promoted && !!l.parent && chatOf(t, l.parent) === chat);
    const others = t.lines.filter((l) => l.id !== current.id && !l.merged && (l.topic || l.label) && near(l));
    return {
      current: current.topic || current.label ? lineLabel(current) : null,
      others: [...new Set(others.map(lineLabel))].slice(0, 12),
    };
  };

  /** What the agent said each prompt is about, kept until the prompt is actually sent. */
  const hints = useRef(new Map<string, TopicHint | null>());
  const titleOf = (lineId: string) => chatTitle(treeRef.current, chatOf(treeRef.current, lineId), ROOT_TITLE);

  const post = (m: Omit<Message, 'id'>, line?: string) => {
    const full: Message = { ...m, id: crypto.randomUUID(), line: line ?? treeRef.current.active, seq: seq.current++ };
    messagesRef.current = [...messagesRef.current, full];
    setMessages((ms) => [...ms, full]);
  };

  const notify = (text: string) => setToast({ id: Date.now(), text });

  /** Put a sent prompt on the map. Returns the line it landed on. */
  const track = (prompt: string): string => {
    // The agent's reading of the prompt if it gave one. Otherwise the keyword list decides.
    const hint = hints.current.has(prompt) ? hints.current.get(prompt) : undefined;
    hints.current.delete(prompt);
    const added = addPrompt(treeRef.current, prompt, seq.current, hint);
    let next = added.tree;
    const back = added.returned;
    // Coming back to the same noticed direction again: it has earned a chat of its own.
    const ripe = !!back && earnsChat(added.tree, back);
    const quiet = branchModeRef.current === 'auto';
    const from = back?.parent ? titleOf(back.parent) : ROOT_TITLE;
    if (back && ripe && quiet) next = promote(next, back.id, true);
    changeTree(next);

    const say = (scene: Scene) =>
      setTimeout(() => {
        if (sceneRef.current.name === 'ambient') setScene(scene);
      }, 700);
    if (back && ripe) {
      const mine = added.tree.nodes.filter((n) => n.line === back.id).length;
      const chat = chatOf(added.tree, back.id);
      const all = added.tree.nodes.filter((n) => chatOf(added.tree, n.line) === chat).length;
      const evidence = `It is ${mine} of the ${all} prompts in ${from}, over ${back.visits} visits.`;
      say({ name: 'branch', lineId: back.id, label: lineLabel(back), what: quiet ? 'moved' : 'offer', from, evidence });
    } else if (added.routed) {
      notify(`That belongs with ${lineLabel(added.routed)}, so it went to that chat.`);
    } else if (added.branched && !quiet) {
      // Quiet mode: the map shows the new branch and nothing interrupts the employee.
      const line = added.branched;
      say({ name: 'branch', lineId: line.id, label: lineLabel(line), what: 'noticed', from });
    }
    return next.active;
  };
  const focusPrompt = () => requestAnimationFrame(() => document.getElementById('prompt')?.focus());

  /** The prompt is cleared to go to the workspace model. */
  const forward = (prompt: string) => {
    const line = track(prompt);
    // The model is told what this branch of the conversation has seen, and nothing else.
    const context = messagesRef.current
      // What Layers did counts as an answer, so the model does not try to redo it.
      .filter((m) => !m.placeholder && (m.text || m.artifact) && isVisible(treeRef.current, m))
      .slice(-16)
      .map((m) => ({
        role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
        // Everything the employee can see in the message, including a list or a document in it.
        content: [
          m.text ?? '',
          ...(m.list ?? []).map((item) => `${item.name}: ${item.note}`),
          m.artifact
            ? `Document added to the project: ${m.artifact.title}. Columns: ${m.artifact.columns.join(', ')}. Rows: ${m.artifact.rows.map((r) => r[0]).join(', ')}.`
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
      }));
    post({ role: 'user', text: prompt }, line);
    if (service.reply) {
      const reply = service.reply;
      void settled.current.then(() => reply(prompt, context)).then((r) => post({ role: 'ai', ...r }, line));
    } else {
      post(
        {
          role: 'ai',
          placeholder: true,
          text: 'No model is connected in this preview build. Layers let this prompt through.',
        },
        line,
      );
    }
    setDraft('');
    setHold(null);
    stash.current = null;
  };

  /** The prompt stays in the chat box and Layers explains why. */
  const holdPrompt = (prompt: string, verdict: Exclude<Verdict, { kind: 'pass' }>) => {
    // Unsure, and the company has said to let those through: send it, log it, say so.
    if (verdict.kind === 'unsure' && unsureRef.current === 'allow') {
      tell('unsure-allowed', prompt);
      forward(prompt);
      setScene({ name: 'ambient' });
      setNod((n) => n + 1);
      notify(`Sent. I couldn't tell if it fits ${project.name}, so it is logged for review.`);
      focusPrompt();
      return;
    }

    setCounters((c) => ({ ...c, held: c.held + 1 }));
    if (verdict.kind === 'policy') {
      setHold({ kind: 'policy', label: `Not sent. Held by rule ${verdict.rule.id}.` });
      setScene({
        name: 'policy',
        prompt,
        rule: verdict.rule,
        reason: verdict.reason,
        signals: verdict.signals,
        showRule: false,
      });
      return;
    }
    if (verdict.kind === 'reuse') {
      setHold({ kind: 'reuse', label: 'Not sent yet. Your team has a workflow for this.' });
      setScene({ name: 'reuse', prompt, item: verdict.item, reason: verdict.reason, showPreview: false });
      return;
    }

    // Unsure, and the company wants a person to look: hand it over and explain why.
    if (unsureRef.current === 'defer') {
      const token = ++run.current;
      setHold({ kind: 'pending', label: 'Not sent yet. A person is being asked to review it.' });
      setScene({ name: 'checking', engaged: true, note: `Asking ${manager.first} to take a look` });
      void service.requestApproval(prompt, verdict.reason).then(({ id, approver }) => {
        if (token !== run.current) return;
        setHold({ kind: 'pending', label: `Waiting on ${approver}. Request ${id}.` });
        setScene({
          name: 'pending',
          prompt,
          rule: verdict.rule,
          requestId: id,
          approver,
          why: `${verdict.reason} Your company sends unclear requests to a person instead of letting me guess.`,
        });
      });
      return;
    }

    // Unsure, and the employee gets to decide.
    setHold({ kind: 'policy', label: `Not sent yet. ${name} has a question.` });
    setScene({ name: 'unsure', prompt, rule: verdict.rule, reason: verdict.reason, signals: verdict.signals });
  };

  const send = async (text?: string) => {
    const prompt = (text ?? draftRef.current).trim();
    const now = sceneRef.current.name;
    if (!prompt || now === 'checking' || now === 'working') return;

    const token = ++run.current;
    stash.current = null;
    setScene({ name: 'checking', engaged: false });
    let verdict: Verdict;
    const began = performance.now();
    let seen: Step[] = [];
    try {
      verdict = await service.preflight(
        prompt,
        (p) => {
          if (p.step) seen = upsert(seen, p.step);
          // A finished tool call has no new line to show, so the last one stays up.
          if (token === run.current && (p.note || !p.engaged)) {
            setScene({ name: 'checking', engaged: p.engaged, note: p.note });
          }
        },
        where(),
      );
    } catch {
      if (token !== run.current) return;
      setScene({ name: 'ambient' });
      notify(`${name} could not check that, so nothing was sent.`);
      return;
    }
    if (token !== run.current) return;
    if (verdict.topic !== undefined) hints.current.set(prompt, verdict.topic);
    logRun({
      kind: 'review',
      prompt,
      by: !backend ? 'preview' : verdict.by === 'agent' ? 'agent' : 'code',
      outcome: verdict.kind === 'reuse' ? `Found ${verdict.item.name} and offered it instead.` : OUTCOME[verdict.kind],
      steps: seen,
      ms: Math.round(performance.now() - began),
    });

    setCounters((c) => ({ ...c, checked: c.checked + 1 }));
    if (verdict.kind === 'pass') {
      forward(prompt);
      setScene({ name: 'ambient' });
      setNod((n) => n + 1);
      focusPrompt();
      return;
    }
    holdPrompt(prompt, verdict);
  };

  /** Layers ask mode: a question to the agent itself. Nothing goes to the workspace model. */
  const ask = async (question: string) => {
    const q = question.trim();
    if (!q) return;
    const token = ++run.current;
    setScene({ name: 'ask', question: q, busy: true, answer: null });
    const answer = await service.ask(q);
    if (token !== run.current) return;
    setScene({ name: 'ask', question: q, busy: false, answer });
  };

  /** Runs the same check as Send on the current draft, without sending it. */
  const precheck = async () => {
    const prompt = draftRef.current.trim();
    if (!prompt) return;
    const token = ++run.current;
    setScene({ name: 'ask', question: 'Can I send my draft?', busy: true, answer: null });
    const verdict = await service.preflight(prompt, () => {}, where());
    if (token !== run.current) return;
    if (verdict.topic !== undefined) hints.current.set(prompt, verdict.topic);
    setCounters((c) => ({ ...c, checked: c.checked + 1 }));
    if (verdict.kind !== 'pass') {
      holdPrompt(prompt, verdict);
      return;
    }
    setScene({
      name: 'ask',
      question: 'Can I send my draft?',
      busy: false,
      answer: { text: `Yes. It fits ${project.name}, so it will go straight through.`, canSend: true },
    });
  };

  const requestFromAsk = async () => {
    const s = sceneRef.current;
    if (s.name !== 'ask' || !s.answer) return;
    const requested = await service.requestApproval(s.question);
    setScene((prev) =>
      prev.name === 'ask' && prev.answer && prev.question === s.question
        ? { ...prev, answer: { ...prev.answer, canRequest: false, requested } }
        : prev,
    );
  };

  const sendDraft = () => {
    setScene({ name: 'ambient' });
    void send();
  };

  const backToProject = () => {
    const text = draftRef.current.trim();
    const wasPending = sceneRef.current.name === 'pending';
    run.current++;
    if (text) setSetAside(text);
    setDraft('');
    setHold(null);
    stash.current = null;
    setScene({ name: 'ambient' });
    if (text) notify(wasPending ? 'Request withdrawn. Draft set aside.' : 'Draft set aside. Nothing was sent.');
    focusPrompt();
  };

  const restoreDraft = () => {
    if (!setAside) return;
    setDraft(setAside);
    setSetAside(null);
    focusPrompt();
  };

  const askApproval = async (note?: string) => {
    const s = sceneRef.current;
    if (s.name !== 'policy' && s.name !== 'unsure') return;
    const token = ++run.current;
    const { id, approver } = await service.requestApproval(s.prompt, note);
    if (token !== run.current) return;
    setHold({ kind: 'pending', label: `Waiting on ${approver}. Request ${id}.` });
    setScene({ name: 'pending', prompt: s.prompt, rule: s.rule, requestId: id, approver });
  };

  const sendWithNote = (note: string) => {
    const s = sceneRef.current;
    if (s.name !== 'unsure') return;
    run.current++;
    tell('note', s.prompt, note);
    forward(s.prompt);
    setScene({ name: 'ambient' });
    notify('Sent. Your reason is logged with it.');
    focusPrompt();
  };

  const sendAnyway = () => {
    const s = sceneRef.current;
    if (s.name !== 'policy') return;
    run.current++;
    tell('override', s.prompt);
    forward(s.prompt);
    setScene({ name: 'ambient' });
    notify(`Sent. Logged as an exception to rule ${s.rule.id}.`);
    focusPrompt();
  };

  const markRelated = () => {
    const s = sceneRef.current;
    if (s.name !== 'policy') return;
    tell('related', s.prompt);
    if (modeRef.current === 'approval') {
      void askApproval(`${project.name} connection claimed by the employee.`);
      return;
    }
    run.current++;
    forward(s.prompt);
    setScene({ name: 'ambient' });
    notify(`Sent. Noted that this relates to ${project.name}.`);
    focusPrompt();
  };

  /** Stands in for the manager's inbox until the backend exists. */
  /** `answered` is true when the manager already recorded the answer on the server. */
  const decide = (approved: boolean, answered = false) => {
    const s = sceneRef.current.name === 'pending' ? sceneRef.current : stash.current;
    if (!s || s.name !== 'pending') return;
    const token = ++run.current;
    stash.current = null;
    if (!answered) settled.current = service.decide?.(s.requestId, approved).catch(() => {}) ?? Promise.resolve();
    setScene({ name: 'decided', approved, approver: s.approver });
    if (!approved) {
      setHold({ kind: 'policy', label: `Declined by ${s.approver}. Draft kept.` });
      return;
    }
    setHold(null);
    void wait(1300).then(() => {
      if (token !== run.current) return;
      forward(s.prompt);
      setScene({ name: 'ambient' });
      focusPrompt();
    });
  };

  const decideRef = useRef(decide);
  decideRef.current = decide;

  // While a request is with the manager, watch for their answer.
  const pendingId = hold?.kind === 'pending' && scene.name === 'pending' ? scene.requestId : null;
  const watchedId = useRef<string | null>(null);
  if (pendingId) watchedId.current = pendingId;
  if (hold?.kind !== 'pending') watchedId.current = null;
  const watching = hold?.kind === 'pending' ? watchedId.current : null;
  useEffect(() => {
    // Only the workspace on screen watches, so one approval is never acted on twice.
    if (!active || !watching || !service.approvalStatus) return;
    const check = service.approvalStatus;
    const timer = setInterval(() => {
      void check(watching).then((status) => {
        if (status !== 'pending') decideRef.current(status === 'approved', true);
      });
    }, 1500);
    return () => clearInterval(timer);
  }, [active, watching, service]);

  const runWorkflow = async (item: KnowledgeItem, prompt: string) => {
    const token = ++run.current;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    post({ role: 'user', text: prompt }, track(prompt));
    setDraft('');
    setHold(null);
    stash.current = null;
    setScene({ name: 'working', item, steps: [] });
    const began = performance.now();
    let done: Step[] = [];
    let planned: Todo[] | undefined;

    await service
      .applyWorkflow(
      item.id,
      prompt,
      (e) => {
        if (token !== run.current) return;
        if (e.type === 'plan') {
          planned = e.todos;
          setScene((prev) => (prev.name === 'working' ? { ...prev, plan: e.todos } : prev));
          return;
        }
        if (e.type === 'step') {
          done = upsert(done, e.step);
          setScene((prev) => (prev.name === 'working' ? { ...prev, steps: upsert(prev.steps, e.step) } : prev));
          return;
        }
        logRun({
          kind: 'apply',
          prompt,
          by: !backend ? 'preview' : backend.agent ? 'agent' : 'code',
          outcome: e.summary,
          plan: planned,
          steps: done,
          ms: Math.round(performance.now() - began),
        });
        post({
          role: 'layers',
          text: `Reused ${item.name} instead of generating a new one.`,
          artifact: e.artifact,
        });
        setTasks((ts) => ts.map((t) => (t.id === e.taskId ? { ...t, status: 'doing' } : t)));
        setCounters((c) => ({ ...c, reused: c.reused + 1 }));
        setScene((prev) =>
          prev.name === 'working'
            ? {
                name: 'done',
                item: prev.item,
                steps: prev.steps,
                plan: prev.plan,
                summary: e.summary,
                detail: e.detail,
                artifactId: e.artifact.id,
                taskId: e.taskId,
                showSteps: false,
              }
            : prev,
        );
      },
      controller.signal,
      )
      .catch(() => {
        if (token !== run.current) return;
        setScene({ name: 'ambient' });
        notify(`${name} could not finish that. Nothing was changed.`);
      });
  };

  const applyWorkflow = () => {
    const s = sceneRef.current;
    if (s.name === 'reuse') void runWorkflow(s.item, s.prompt);
  };

  const useFromAsk = () => {
    const s = sceneRef.current;
    if (s.name === 'ask' && s.answer?.item) void runWorkflow(s.answer.item, s.question);
  };

  const undoWorkflow = () => {
    const s = sceneRef.current;
    if (s.name !== 'done') return;
    run.current++;
    void service.undo?.(s.artifactId, s.taskId);
    setMessages((ms) => ms.filter((m) => m.artifact?.id !== s.artifactId));
    setTasks((ts) => ts.map((t) => (t.id === s.taskId ? { ...t, status: 'todo' } : t)));
    setCounters((c) => ({ ...c, reused: Math.max(0, c.reused - 1) }));
    setScene({ name: 'ambient' });
    notify('Removed it and reset the task.');
  };

  const buildAnyway = () => {
    const s = sceneRef.current;
    if (s.name !== 'reuse') return;
    run.current++;
    tell('skipped-reuse', s.prompt);
    forward(s.prompt);
    setScene({ name: 'ambient' });
    notify(`Sent. Logged that ${s.item.name} was skipped.`);
    focusPrompt();
  };

  const dismiss = () => {
    const s = sceneRef.current;
    if (s.name === 'ambient' || s.name === 'working' || s.name === 'checking') return;
    // Remember what was on screen so tapping the agent can bring it back.
    const unresolved = s.name === 'policy' || s.name === 'reuse' || s.name === 'pending' || s.name === 'unsure';
    if (unresolved || s.name === 'done' || (s.name === 'ask' && s.answer)) stash.current = s;
    setScene({ name: 'ambient' });
    focusPrompt();
  };
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;

  const review = () => {
    if (stash.current) {
      setScene(stash.current);
      stash.current = null;
    } else {
      void send();
    }
  };

  const changeDraft = (text: string) => {
    setDraft(text);
    if (!hold || hold.kind === 'pending') return;
    // Editing the draft makes it a new request, so the old verdict no longer applies.
    run.current++;
    setHold(null);
    stash.current = null;
    const now = sceneRef.current.name;
    if (now === 'policy' || now === 'reuse' || now === 'decided' || now === 'unsure') setScene({ name: 'ambient' });
  };

  /** Tapping the agent pulls it up so the employee can ask it something before sending. */
  const openAsk = () => {
    const now = sceneRef.current.name;
    if (now === 'ask' || now === 'settings') {
      setScene({ name: 'ambient' });
      return;
    }
    if (now !== 'ambient') return;
    // If it said something earlier, show that again. Otherwise it is ready for a question.
    if (stash.current) {
      setScene(stash.current);
      stash.current = null;
    } else {
      setScene({ name: 'ask', question: '', busy: false, answer: null });
    }
  };

  /** Hide the agent completely, or bring it back to where it was resting. */
  const toggleHidden = () => {
    setLab((s) => {
      if (s.rest === 'hidden') return { ...s, rest: restBeforeHide.current };
      restBeforeHide.current = s.rest;
      return { ...s, rest: 'hidden' };
    });
    const now = sceneRef.current.name;
    if (now === 'ask' || now === 'settings') setScene({ name: 'ambient' });
  };
  const toggleHiddenRef = useRef(toggleHidden);
  toggleHiddenRef.current = toggleHidden;

  const prefs: Prefs = {
    shape: lab.shape,
    eyes: lab.eyes,
    rest: lab.rest,
    outline: lab.outline,
    policyMode: lab.policyMode,
    unsureMode: lab.unsureMode,
    branchMode: lab.branchMode,
    name,
  };

  // Keep the conversation on this device, so a refresh or a change of view brings it back.
  const stamp = useRef(saved?.at ?? 0);
  const adopted = useRef(false);
  const wasActive = useRef(active);
  useEffect(() => {
    const back = active && !wasActive.current;
    wasActive.current = active;
    if (!back) return;
    // Another copy of this workspace (the side-by-side view) may have moved on since.
    const s = loadSession();
    if (!s || s.at <= stamp.current) return;
    stamp.current = s.at;
    adopted.current = true;
    setMessages(s.messages);
    messagesRef.current = s.messages;
    seq.current = s.seq;
    changeTree(s.tree);
    setTasks(s.tasks);
    setCounters(s.counters);
    setRuns(s.runs ?? []);
  }, [active]);
  useEffect(() => {
    if (!active) return;
    if (adopted.current) {
      adopted.current = false;
      return;
    }
    const waiting =
      scene.name === 'pending'
        ? scene
        : hold?.kind === 'pending' && stash.current?.name === 'pending'
          ? stash.current
          : undefined;
    const at = Date.now();
    stamp.current = at;
    try {
      const session: Saved = { messages, tree, tasks, counters, seq: seq.current, at, pending: waiting, runs };
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch {
      // Private windows can refuse storage. The conversation just won't survive a refresh.
    }
  }, [active, messages, tree, tasks, counters, scene, hold, runs]);

  // A status update for the manager. The agent drafts it, and it goes nowhere until approved.
  const [update, setUpdate] = useState<UpdateState>(NO_UPDATE);
  const updateRef = useRef(update);
  updateRef.current = update;
  const updateBegan = useRef(0);
  const onUpdateEvent = (e: AgentEvent) =>
    setUpdate((u) =>
      e.type === 'plan' ? { ...u, plan: e.todos } : e.type === 'step' ? { ...u, steps: upsert(u.steps, e.step) } : u,
    );

  const draftUpdate = async () => {
    if (!service.draftUpdate || updateRef.current.phase === 'working') return;
    updateBegan.current = performance.now();
    setUpdate({ ...NO_UPDATE, phase: 'working' });
    try {
      const draft = await service.draftUpdate(onUpdateEvent);
      setUpdate((u) => ({ ...u, phase: 'draft', text: draft.text, thread: draft.thread, by: backend ? draft.by : 'preview' }));
    } catch {
      setUpdate(NO_UPDATE);
      notify(`${name} could not draft that. Nothing was sent.`);
    }
  };

  const sendUpdate = async (wording: string, approved: boolean) => {
    const draft = updateRef.current;
    const text = wording.trim();
    if (draft.phase !== 'draft' || !service.sendUpdate || (approved && !text)) return;
    setUpdate({ ...draft, phase: 'sending' });
    try {
      await service.sendUpdate(draft.thread, text || draft.text, approved, onUpdateEvent);
    } catch {
      setUpdate({ ...draft, phase: 'draft' });
      notify('That did not go through. Nothing was sent.');
      return;
    }
    const after = updateRef.current;
    logRun({
      kind: 'update',
      prompt: `Status update for ${manager.first}`,
      by: draft.by,
      outcome: !approved
        ? 'You chose not to send it. Nothing left the workspace.'
        : text !== draft.text
          ? 'Sent in your own wording, after you edited it.'
          : 'Sent after you approved it.',
      plan: after.plan,
      steps: after.steps,
      ms: Math.round(performance.now() - updateBegan.current),
    });
    setUpdate(approved ? { ...after, phase: 'sent', text, at: Date.now() } : NO_UPDATE);
    notify(approved ? `Sent to ${manager.first}.` : 'Draft dropped. Nothing was sent.');
  };

  /** Open a chat from the list, on the line the employee was last on inside it. */
  const openChat = (chat: string) => {
    changeTree({ ...treeRef.current, active: lastLineIn(treeRef.current, chat) });
    focusPrompt();
  };

  /** Jump to one prompt: open its chat and bring the prompt into view. */
  const openNode = (nodeId: string) => {
    const node = treeRef.current.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    setPanel(null);
    changeTree({ ...treeRef.current, active: node.line });
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`.msg--user[data-seq="${node.seq}"]`);
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el?.setAttribute('data-flash', '');
      setTimeout(() => el?.removeAttribute('data-flash'), 1500);
    });
  };

  /** The employee wants a direction as a chat of its own. */
  const detachBranch = (lineId: string) => {
    const line = treeRef.current.lines.find((l) => l.id === lineId);
    if (!line) return;
    changeTree(promote(treeRef.current, lineId, false));
    setScene({ name: 'ambient' });
    notify(`${lineLabel(line)} is now a chat of its own.`);
  };

  /** Put a chat that started as a noticed direction back where it came from. */
  const foldBranch = (lineId: string) => {
    const line = treeRef.current.lines.find((l) => l.id === lineId);
    if (!line?.parent) return;
    const back = titleOf(line.parent);
    changeTree(fold(treeRef.current, lineId));
    setScene({ name: 'ambient' });
    notify(`Put back into ${back}. I won't move it again.`);
  };

  const mergeAllBranches = () => {
    const tree = treeRef.current;
    const count = openLines(tree, chatOf(tree, tree.active)).length;
    if (count === 0) return;
    changeTree(mergeAll(tree));
    notify(count === 1 ? 'Merged 1 branch back.' : `Merged ${count} branches back.`);
  };

  const actions: BubbleActions = {
    backToProject,
    askApproval: () => void askApproval(),
    sendAnyway,
    markRelated,
    applyWorkflow,
    buildAnyway,
    undoWorkflow,
    dismiss,
    toggleRule: () => setScene((s) => (s.name === 'policy' ? { ...s, showRule: !s.showRule } : s)),
    togglePreview: () => setScene((s) => (s.name === 'reuse' ? { ...s, showPreview: !s.showPreview } : s)),
    toggleSteps: () => setScene((s) => (s.name === 'done' ? { ...s, showSteps: !s.showSteps } : s)),
    ask: (question) => void ask(question),
    precheck: () => void precheck(),
    requestFromAsk: () => void requestFromAsk(),
    useFromAsk,
    sendDraft,
    sendWithNote,
    toggleHidden,
    openSettings: () => setScene({ name: 'settings' }),
    mergeBranch: (lineId) => {
      changeTree(mergeBack(treeRef.current, lineId));
      setScene({ name: 'ambient' });
      notify('Merged back into the line it came from.');
    },
    detachBranch,
    foldBranch,
    leaveBranch: (lineId) => {
      changeTree(settle(treeRef.current, lineId));
      setScene({ name: 'ambient' });
    },
    openBranches: () => {
      setScene({ name: 'ambient' });
      setPanel('branches');
    },
    setPrefs: (change) => setLab((s) => ({ ...s, ...change })),
    // With no server there is no manager's page, so the preview lets you answer as the manager.
    previewDecide: backend ? undefined : (approved) => decide(approved),
  };

  const reset = () => {
    run.current++;
    abort.current?.abort();
    stash.current = null;
    hints.current.clear();
    setPanel(null);
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      // Nothing was saved, so there is nothing to clear.
    }
    void service.reset?.();
    setMessages(seedMessages);
    messagesRef.current = seedMessages;
    seq.current = seedMessages.length;
    changeTree(seedTree(seedMessages[0]!.text ?? ''));
    setTasks(seedTasks);
    setDraft('');
    setHold(null);
    setSetAside(null);
    setScene({ name: 'ambient' });
    setToast(null);
    setCounters(NO_COUNTS);
    setRuns([]);
    setUpdate(NO_UPDATE);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Alt+L hides the agent or brings it back, from anywhere, even mid-sentence.
      if (e.altKey && e.code === 'KeyL') {
        e.preventDefault();
        toggleHiddenRef.current();
        return;
      }
      if (e.key === 'Escape') dismissRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The chats this conversation has split into, and where the open one sits among them.
  const chats = chatsOf(tree);
  const here = chatOf(tree, tree.active);
  const thisChat = chats.find((c) => c.id === here);
  const marks: ForkMark[] = chats
    .filter((c) => c.parent === here)
    .map((c) => ({
      id: c.id,
      seq: c.startsAt,
      title: chatTitle(tree, c.id, ROOT_TITLE),
      prompts: c.prompts,
      byLayers: c.byLayers,
    }));

  return (
    <div
      className={reduced ? 'root reduce-motion' : 'root'}
      data-outline={lab.outline}
      data-eyes={lab.eyes}
      style={{ '--glow': GLOW[lab.glow], '--reserve': `${reserve}px` } as CSSProperties}
    >
      <Workspace
        messages={messages.filter((m) => isVisible(tree, m))}
        agentName={name}
        chats={chats.map((c) => ({
          id: c.id,
          title: chatTitle(tree, c.id, ROOT_TITLE),
          depth: c.depth,
          current: c.id === here,
          byLayers: c.byLayers,
        }))}
        onOpenChat={openChat}
        title={chatTitle(tree, here, ROOT_TITLE)}
        crumb={thisChat?.parent ? chatTitle(tree, thisChat.parent, ROOT_TITLE) : null}
        marks={marks}
        origin={
          thisChat?.parent
            ? { seq: thisChat.startsAt, title: chatTitle(tree, thisChat.parent, ROOT_TITLE), byLayers: thisChat.byLayers }
            : null
        }
        branchCount={tree.lines.length - 1}
        onOpenBranches={() => setPanel('branches')}
        tasks={tasks}
        draft={draft}
        hold={hold}
        busy={scene.name === 'checking' || scene.name === 'working'}
        setAside={setAside}
        layout={lab.layout}
        layersIn={absorbed}
        dropReady={dropReady}
        layersHidden={lab.rest === 'hidden'}
        onShowLayers={toggleHidden}
        reserve={reserve}
        tries={tryPrompts}
        onTry={(prompt) => {
          changeDraft(prompt);
          focusPrompt();
        }}
        status={
          !backend
            ? 'Preview without the Layers server. Checks and branches work; answers are placeholders.'
            : backend.agent
              ? `Live agent on ${(backend.model ?? '').split(':').pop()}.`
              : backend.model
                ? 'Live server on rules only. The model did not load.'
                : 'Live server on rules only. No model key is set.'
        }
        onReset={reset}
        onDraftChange={changeDraft}
        onSend={() => void send()}
        onReview={review}
        onRestore={restoreDraft}
        onOpenRules={() => void ask('What are my limits here?')}
      />
      <EdgeGlow mode={glowFor(scene)} variant={lab.edge} quiet={lab.rest === 'hidden' && scene.name === 'ambient'} />
      <AgentCluster
        scene={scene}
        placement={lab.placement}
        shape={lab.shape}
        rest={lab.rest}
        reducedMotion={reduced}
        nod={nod}
        counters={counters}
        hasDraft={draft.trim().length > 0}
        prefs={prefs}
        actions={actions}
        onMascotClick={openAsk}
        onOpenPanel={setPanel}
        onRestChange={(rest) => setLab((s) => (s.rest === rest ? s : { ...s, rest }))}
        onAbsorbedChange={setAbsorbed}
        onOverBoxChange={setDropReady}
        onReserveChange={setReserve}
      />
      {panel && (
        <BranchPanel
          tab={panel}
          tree={tree}
          rootTitle={ROOT_TITLE}
          projectName={project.name}
          agentName={name}
          tasks={tasks}
          counters={counters}
          runs={runs}
          update={update}
          managerName={manager.first}
          onDraftUpdate={() => void draftUpdate()}
          onSendUpdate={(text, approved) => void sendUpdate(text, approved)}
          live={
            !backend
              ? 'This is the preview without the Layers server, so a scripted stand-in plays the agent.'
              : backend.agent
                ? `The agent is live on ${(backend.model ?? '').split(':').pop()}.`
                : 'The server is on rules only, so plain code does the work and no model is called.'
          }
          onTab={setPanel}
          onClose={() => setPanel(null)}
          onOpenNode={openNode}
          onOpenChat={(chat) => {
            setPanel(null);
            openChat(chat);
          }}
          onBranch={(nodeId) => {
            setPanel(null);
            changeTree(branchFrom(treeRef.current, nodeId));
            notify('New chat. It starts from that prompt, and your next one goes here.');
            focusPrompt();
          }}
          onMerge={(lineId) => changeTree(mergeBack(treeRef.current, lineId))}
          onMergeAll={mergeAllBranches}
          onDetach={(lineId) => {
            setPanel(null);
            detachBranch(lineId);
          }}
          onFold={foldBranch}
        />
      )}
      <Toast toast={toast} onClose={() => setToast(null)} />
      <div className="sr-only" role="status" aria-live="polite">
        {announce(scene, name)}
      </div>
    </div>
  );
}
