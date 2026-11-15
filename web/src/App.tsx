import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { BranchPanel, type PanelTab } from './branches/BranchPanel';
import {
  PROMOTE_AFTER,
  addPrompt,
  branchFrom,
  chatOf,
  chatTitle,
  chatsOf,
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
import {
  DesignLab,
  defaultLab,
  loadName,
  saveName,
  type GlowLevel,
  type LabScene,
  type LabSettings,
} from './lab/DesignLab';
import { AgentCluster } from './layers/AgentCluster';
import type { BubbleActions, Prefs } from './layers/Bubble';
import { EdgeGlow, type GlowMode } from './layers/EdgeGlow';
import { connect, type BackendStatus } from './layers/apiService';
import { createMockService, previewSteps } from './layers/mockService';
import { Toast, type ToastState } from './layers/Toast';
import type { Counters, Hold, KnowledgeItem, Message, RestMode, Scene, Step, Task, Verdict } from './layers/types';
import { useMediaQuery } from './ui/useMediaQuery';
import { competitorMatrix, conversations, examplePrompts, manager, project, seedMessages, seedTasks } from './workspace/data';
import { Workspace, type ForkMark } from './workspace/Workspace';

/** What the first chat is called. Branches that become chats are named after their direction. */
const ROOT_TITLE = conversations[0]!;

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
  const [messages, setMessages] = useState<Message[]>(seedMessages);
  const [tasks, setTasks] = useState<Task[]>(seedTasks);
  const [draft, setDraft] = useState('');
  const [hold, setHold] = useState<Hold | null>(null);
  const [setAside, setSetAside] = useState<string | null>(null);
  const [scene, setScene] = useState<Scene>({ name: 'ambient' });
  const [toast, setToast] = useState<ToastState | null>(null);
  const [counters, setCounters] = useState<Counters>(NO_COUNTS);
  const [nod, setNod] = useState(0);
  /** True while the agent is melted into the chat box. */
  const [absorbed, setAbsorbed] = useState(false);
  /** Room the chat leaves above the chat box so Layers never covers a message. */
  const [reserve, setReserve] = useState(0);
  /** The agent is being held over the chat box. */
  const [dropReady, setDropReady] = useState(false);
  // On a phone-width screen the lab floats over the page, so it starts closed there.
  const [lab, setLab] = useState<LabSettings>(() => ({
    ...defaultLab,
    open: !window.matchMedia('(max-width: 760px)').matches,
    name: loadName(),
  }));
  const name = lab.name;
  useEffect(() => saveName(name), [name]);
  /** The branch map and today-so-far page, when it is open. */
  const [panel, setPanel] = useState<PanelTab | null>(null);

  /** Bumped whenever the current flow is superseded, so late async work can tell it is stale. */
  const run = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const speed = useRef(1);
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
  const mock = useMemo(() => createMockService(() => speed.current), []);
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
  useEffect(() => {
    if (active) void service.sync?.({ policyMode: lab.policyMode, unsureMode: lab.unsureMode });
  }, [active, service, lab.policyMode, lab.unsureMode]);

  /** The latest thing told to the server. Sending waits for it, so the gate sees it first. */
  const settled = useRef<Promise<unknown>>(Promise.resolve());
  const tell = (kind: Parameters<typeof service.recordFeedback>[0], prompt: string, note?: string) => {
    settled.current = service.recordFeedback(kind, prompt, note).catch(() => {});
  };

  const systemReduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const reduced = systemReduced || lab.reduceMotion;
  const sidebarHidden = useMediaQuery('(max-width: 760px)');

  // The shape of the conversation: which prompts sit on which branch.
  const [tree, setTree] = useState<Tree>(() => seedTree(seedMessages[0]!.text ?? ''));
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const seq = useRef(seedMessages.length);
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
    const ripe = !!back && !back.settled && back.visits >= PROMOTE_AFTER;
    const quiet = branchModeRef.current === 'auto';
    const from = back?.parent ? titleOf(back.parent) : ROOT_TITLE;
    if (back && ripe && quiet) next = promote(next, back.id, true);
    changeTree(next);

    const say = (scene: Scene) =>
      setTimeout(() => {
        if (sceneRef.current.name === 'ambient') setScene(scene);
      }, 700);
    if (back && ripe) {
      say({ name: 'branch', lineId: back.id, label: lineLabel(back), what: quiet ? 'moved' : 'offer', from });
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
      .filter((m) => !m.placeholder && m.text && isVisible(treeRef.current, m))
      .slice(-16)
      .map((m) => ({ role: m.role === 'user' ? ('user' as const) : ('assistant' as const), content: m.text ?? '' }));
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
    try {
      verdict = await service.preflight(
        prompt,
        (p) => {
          if (token === run.current) setScene({ name: 'checking', engaged: p.engaged, note: p.note });
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
    if (!watching || !service.approvalStatus) return;
    const check = service.approvalStatus;
    const timer = setInterval(() => {
      void check(watching).then((status) => {
        if (status !== 'pending') decideRef.current(status === 'approved', true);
      });
    }, 1500);
    return () => clearInterval(timer);
  }, [watching, service]);

  const runWorkflow = async (item: KnowledgeItem, prompt: string, instant = false) => {
    const token = ++run.current;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    post({ role: 'user', text: prompt }, track(prompt));
    setDraft('');
    setHold(null);
    stash.current = null;
    setScene({ name: 'working', item, steps: [] });

    speed.current = instant ? 0 : 1;
    await service
      .applyWorkflow(
      item.id,
      prompt,
      (e) => {
        if (token !== run.current) return;
        if (e.type === 'plan') {
          setScene((prev) => (prev.name === 'working' ? { ...prev, plan: e.todos } : prev));
          return;
        }
        if (e.type === 'step') {
          setScene((prev) => (prev.name === 'working' ? { ...prev, steps: upsert(prev.steps, e.step) } : prev));
          return;
        }
        post({
          role: 'layers',
          text: `Reused ${item.name} instead of generating a new sheet.`,
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
    speed.current = 1;
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
    notify('Removed the sheet and reset the task.');
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
    name,
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
  };

  const reset = () => {
    run.current++;
    abort.current?.abort();
    speed.current = 1;
    stash.current = null;
    hints.current.clear();
    setPanel(null);
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
  };

  const typeInto = async (text: string, token: number) => {
    if (reduced) {
      setDraft(text);
      return;
    }
    for (let i = 1; i <= text.length; i++) {
      if (token !== run.current) return;
      setDraft(text.slice(0, i));
      await wait(14 + Math.random() * 22);
    }
    await wait(260);
  };

  /** Design lab: put the interface into one of its states from a clean start. */
  const play = async (name: LabScene) => {
    reset();
    const token = run.current;
    if (name === 'rest') return;

    if (name === 'ask') {
      setScene({ name: 'ask', question: '', busy: false, answer: null });
      return;
    }

    if (name === 'settings') {
      setScene({ name: 'settings' });
      return;
    }

    if (name === 'policy' || name === 'knowledge' || name === 'unsure') {
      const text =
        name === 'policy'
          ? examplePrompts.offTopic
          : name === 'unsure'
            ? examplePrompts.unsure
            : examplePrompts.rebuild;
      focusPrompt();
      await wait(120);
      await typeInto(text, token);
      if (token === run.current) await send(text);
      return;
    }

    if (name === 'working') {
      post({ role: 'user', text: examplePrompts.rebuild }, track(examplePrompts.rebuild));
      setScene({ name: 'working', item: competitorMatrix, steps: previewSteps });
      return;
    }

    await runWorkflow(competitorMatrix, examplePrompts.rebuild, true);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Alt+L hides the agent or brings it back, from anywhere, even mid-sentence.
      if (e.altKey && e.code === 'KeyL') {
        e.preventDefault();
        toggleHiddenRef.current();
        return;
      }
      if (e.key === 'Escape') {
        dismissRef.current();
        return;
      }
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable);
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() === 'l') setLab((s) => ({ ...s, open: !s.open }));
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

  const labFloating = sidebarHidden || lab.layout === 'focus';
  const labPanel = (
    <DesignLab
      settings={lab}
      floating={labFloating}
      backend={backend}
      awaitingManager={hold?.kind === 'pending'}
      onChange={setLab}
      onScene={(name) => void play(name)}
      onDecide={decide}
    />
  );

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
        sidebarSlot={labFloating ? null : labPanel}
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
      {labFloating && labPanel}
      <div className="sr-only" role="status" aria-live="polite">
        {announce(scene, name)}
      </div>
    </div>
  );
}
