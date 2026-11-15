export type PolicyMode = 'warn' | 'approval';
export type Placement = 'right' | 'above';
/** Where the agent waits when it has nothing to say. */
export type RestMode = 'absorbed' | 'floating' | 'hidden';
/** What the company wants Layers to do when it cannot tell whether a prompt is on-project. */
export type UnsureMode = 'ask' | 'allow' | 'defer';

/** The words in a prompt that pushed the decision each way. Shown to the employee as the reason. */
export interface Signals {
  fits: string[];
  against: string[];
}

export interface Rule {
  id: string;
  name: string;
  text: string;
  owner: string;
  scope: string;
}

export interface KnowledgeItem {
  id: string;
  name: string;
  kind: string;
  summary: string;
  author: string;
  team: string;
  reviewedOn: string;
  approvedBy: string;
  access: string;
  columns: string[];
  inputs: string;
  /** Teammates who have already used it, and what for. */
  usedBy?: { who: string; project: string }[];
}

/** How someone on the team did a piece of work: the steps they went through and what they used. */
export interface TeamProcess {
  who: string;
  project: string;
  did: string;
  path: string[];
  workflow: string;
  when: string;
  sample: boolean;
}

export interface Step {
  id: string;
  /** Name of the tool the agent called. */
  tool: string;
  /** The same call in plain English. */
  label: string;
  status: 'running' | 'done' | 'error';
  detail?: string;
  /** Measured duration. Only set when the backend reports one. */
  ms?: number;
}

export interface Artifact {
  id: string;
  title: string;
  source: string;
  author: string;
  columns: string[];
  rows: string[][];
}

export interface Task {
  id: string;
  title: string;
  status: 'todo' | 'doing' | 'done';
}

export interface Message {
  id: string;
  role: 'user' | 'ai' | 'layers';
  text?: string;
  list?: { name: string; note: string }[];
  artifact?: Artifact;
  /** Stand-in reply shown while no model is connected. */
  placeholder?: boolean;
  /** Which branch of the conversation this belongs to, and its position in it. */
  line?: string;
  seq?: number;
}

/** Why the prompt in the composer has not been sent. */
export interface Hold {
  kind: 'policy' | 'reuse' | 'pending';
  label: string;
}

export interface Counters {
  checked: number;
  held: number;
  reused: number;
}

export type Verdict = (
  | { kind: 'pass' }
  | { kind: 'policy'; rule: Rule; reason: string; signals: Signals }
  | {
      kind: 'unsure';
      rule: Rule;
      reason: string;
      signals: Signals;
      /** The one question that would settle it, when the agent has one. */
      question?: string;
      /** For a mixed prompt: the project work alone, which could be sent by itself. */
      trimmed?: string;
    }
  | { kind: 'reuse'; item: KnowledgeItem; reason: string }
) & {
  /**
   * What the agent said the prompt is about, when it reviewed it. Null means it carries on
   * with what the conversation was doing. Left out when only the quick screen looked.
   */
  topic?: { id: string; label: string } | null;
  /** Who decided: the gate's plain code, or the agent after looking. */
  by?: 'gate' | 'agent';
};

/** Where a status update for the manager stands: being drafted, waiting on the employee, or sent. */
export interface UpdateState {
  phase: 'idle' | 'working' | 'draft' | 'sending' | 'sent';
  text: string;
  /** The paused agent run that wrote it, when there is one. */
  thread: string | null;
  by: 'agent' | 'code' | 'preview';
  plan?: Todo[];
  steps: Step[];
  at?: number;
}

/** One piece of work Layers did, kept so the employee can see exactly what happened. */
export interface AgentRun {
  id: string;
  at: number;
  kind: 'review' | 'apply' | 'update' | 'ask';
  /** What it was about, in the employee's own words. */
  prompt: string;
  /** agent: the DeepAgent ran. code: plain code decided, no model. preview: the scripted stand-in. */
  by: 'agent' | 'code' | 'preview';
  outcome: string;
  plan?: Todo[];
  steps: Step[];
  ms: number;
}

export interface CheckProgress {
  /** True when the quick screen could not clear the prompt and the agent is looking at it. */
  engaged: boolean;
  note?: string;
  /** The tool call this line is about, when the server reports it in full. */
  step?: Step;
}

/** What Layers says back when the employee asks it something before sending. */
export interface AskAnswer {
  text: string;
  rule?: Rule;
  item?: KnowledgeItem;
  /** Show the rules that apply to this employee. */
  showLimits?: boolean;
  /** The answer was no, and Layers can ask the manager for an exception. */
  canRequest?: boolean;
  /** The draft in the chat box is clear to send. */
  canSend?: boolean;
  requested?: { id: string; approver: string };
  /** How teammates did similar work. */
  processes?: TeamProcess[];
  /** A prompt in the employee's own conversation, found by following its branches. */
  found?: { line: string; index: number; label: string; prompt: string };
  /** The tool calls made to get this answer, and whether the agent or plain code made them. */
  steps?: Step[];
  by?: 'agent' | 'code';
}

/** One branch of the conversation, as the agent sees it when asked to find something. */
export interface BranchIndex {
  id: string;
  label: string;
  kind: 'main' | 'implicit' | 'explicit';
  prompts: { n: number; text: string }[];
}

/** One line of the agent's own to-do list. */
export interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export type AgentEvent =
  | { type: 'step'; step: Step }
  | { type: 'plan'; todos: Todo[] }
  | { type: 'result'; summary: string; detail: string; artifact: Artifact; taskId: string };

/** The contract between the UI and the Layers backend. */
export interface LayersService {
  /**
   * Runs when the employee presses Send, before the prompt reaches the workspace model.
   * `where` names the direction the conversation is on and the others it has taken, so the
   * agent can say whether this prompt leaves it.
   */
  preflight(
    prompt: string,
    onProgress: (p: CheckProgress) => void,
    where?: { current: string | null; others: string[] },
  ): Promise<Verdict>;
  /** Applies an approved workflow and reports each tool call as it happens. */
  applyWorkflow(itemId: string, prompt: string, onEvent: (e: AgentEvent) => void, signal: AbortSignal): Promise<void>;
  /** Answers a question about rules, limits or existing team work. Nothing is sent to the workspace model. */
  ask(question: string, branches?: BranchIndex[]): Promise<AskAnswer>;
  requestApproval(prompt: string, note?: string): Promise<{ id: string; approver: string }>;
  recordFeedback(
    kind: 'related' | 'override' | 'skipped-reuse' | 'unsure-allowed' | 'note',
    prompt: string,
    note?: string,
  ): Promise<void>;

  // Only the real backend has these. The scripted stand-in leaves them out.
  /** The workspace model's answer to a prompt Layers has cleared. */
  reply?(prompt: string, context?: { role: 'user' | 'assistant'; content: string }[]): Promise<{ text: string; placeholder: boolean }>;
  undo?(artifactId: string, taskId: string): Promise<void>;
  /** The manager's answer to an approval request. */
  decide?(requestId: string, approved: boolean): Promise<void>;
  /** Tell the server what the company has chosen. The server enforces it. */
  sync?(settings: { policyMode: PolicyMode; unsureMode: UnsureMode }): Promise<void>;
  /** What the company has chosen, as the server has it. The manager can change it. */
  settings?(): Promise<{ policyMode: PolicyMode; unsureMode: UnsureMode; runs?: { used: number; cap: number } }>;
  reset?(): Promise<void>;
  /** Where an approval request stands, so the employee's side updates when the manager answers. */
  approvalStatus?(requestId: string): Promise<'pending' | 'approved' | 'declined'>;
  /** The shape of the conversation's branches, for the manager. No prompt text is in it. */
  branches?(outline: unknown): Promise<void>;
  /** The agent drafts a status update for the manager from the day's results, and stops before sending. */
  draftUpdate?(onEvent: (e: AgentEvent) => void): Promise<{ text: string; thread: string | null; by: 'agent' | 'code' }>;
  /** The employee's answer to the draft: send it, in their own wording if they changed it, or drop it. */
  sendUpdate?(thread: string | null, text: string, approved: boolean, onEvent: (e: AgentEvent) => void): Promise<void>;
}

/** What the Layers overlay is showing right now. */
export type Scene =
  | { name: 'ambient' }
  | { name: 'ask'; question: string; busy: boolean; answer: AskAnswer | null }
  | { name: 'checking'; engaged: boolean; note?: string }
  | { name: 'settings' }
  | {
      name: 'branch';
      lineId: string;
      label: string;
      /** noticed: a new direction. moved: Layers gave it its own chat. offer: Layers asks first. */
      what: 'noticed' | 'moved' | 'offer';
      /** The chat it split off from. */
      from: string;
      /** What made Layers act: how much of the chat it is, over how many visits. */
      evidence?: string;
    }
  | { name: 'policy'; prompt: string; rule: Rule; reason: string; signals: Signals; showRule: boolean }
  | { name: 'unsure'; prompt: string; rule: Rule; reason: string; signals: Signals; question?: string; trimmed?: string }
  | { name: 'pending'; prompt: string; rule: Rule; requestId: string; approver: string; why?: string }
  | { name: 'decided'; approved: boolean; approver: string }
  | { name: 'reuse'; prompt: string; item: KnowledgeItem; reason: string; showPreview: boolean }
  | { name: 'working'; item: KnowledgeItem; steps: Step[]; plan?: Todo[] }
  | {
      name: 'done';
      item: KnowledgeItem;
      steps: Step[];
      plan?: Todo[];
      summary: string;
      detail: string;
      artifactId: string;
      taskId: string;
      showSteps: boolean;
    };
