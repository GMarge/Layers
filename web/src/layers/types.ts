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
  | { kind: 'unsure'; rule: Rule; reason: string; signals: Signals }
  | { kind: 'reuse'; item: KnowledgeItem; reason: string }
) & {
  /**
   * What the agent said the prompt is about, when it reviewed it. Null means it carries on
   * with what the conversation was doing. Left out when only the quick screen looked.
   */
  topic?: { id: string; label: string } | null;
};

export interface CheckProgress {
  /** True when the quick screen could not clear the prompt and the agent is looking at it. */
  engaged: boolean;
  note?: string;
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
  ask(question: string): Promise<AskAnswer>;
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
  reset?(): Promise<void>;
  /** Where an approval request stands, so the employee's side updates when the manager answers. */
  approvalStatus?(requestId: string): Promise<'pending' | 'approved' | 'declined'>;
  /** The shape of the conversation's branches, for the manager. No prompt text is in it. */
  branches?(outline: unknown): Promise<void>;
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
    }
  | { name: 'policy'; prompt: string; rule: Rule; reason: string; signals: Signals; showRule: boolean }
  | { name: 'unsure'; prompt: string; rule: Rule; reason: string; signals: Signals }
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
