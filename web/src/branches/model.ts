/**
 * How a chat splits into branches.
 *
 * - implicit: nobody pressed anything, but the conversation moved to a different part of
 *   the project. Layers notices and gives the new direction its own line inside the chat.
 * - explicit: a chat of its own. It starts from the point it split off and shows up in the
 *   chat list. The employee makes one with Branch. Layers makes one when the employee
 *   keeps coming back to the same implicit line, so that work ends up together.
 *
 * Direction comes from the agent when it reviewed the prompt, and from plain keyword
 * matching otherwise, which costs nothing.
 */

export interface Line {
  id: string;
  kind: 'main' | 'implicit' | 'explicit';
  parent: string | null;
  /** The prompt this line split off after. */
  forkNode: string | null;
  topic: string | null;
  /** A name for a direction the keyword list does not know. The agent supplies it. */
  label?: string;
  /** An implicit line that was folded back into its parent. */
  merged: boolean;
  /** How many separate times the conversation has been on this line. */
  visits: number;
  /** Layers made this a chat of its own, because the employee kept coming back to it. */
  promoted?: boolean;
  /** The employee said to leave this line where it is, so Layers does not offer again. */
  settled?: boolean;
  /** For a line that began as an implicit one: the position its own messages start at. */
  cut?: number;
}

export interface PromptNode {
  id: string;
  line: string;
  text: string;
  /** Position of this prompt among all messages. */
  seq: number;
  /** First prompt after coming back to a line that had been left. */
  reopened: boolean;
  /** Which visit to the line this prompt started: 2 for the first time back, and so on. */
  visit: number;
}

/**
 * A prompt Layers stopped and that never went through. It is not a dot on a line, because
 * it was never sent: the map draws it as a short dead end off the line it was typed on.
 */
export interface Stop {
  id: string;
  line: string;
  /** Index of the last prompt sent before this one was stopped. */
  after: number;
  text: string;
  why: 'policy' | 'unsure';
  /** held: stopped, and left there. waiting: with the manager. declined: the manager said no. */
  state: 'held' | 'waiting' | 'declined';
}

export interface Tree {
  lines: Line[];
  nodes: PromptNode[];
  active: string;
  stops?: Stop[];
}

/** Record a prompt that was stopped. Stopping the same prompt again moves its mark. */
export function addStop(tree: Tree, text: string, why: Stop['why'], state: Stop['state'] = 'held'): Tree {
  const rest = (tree.stops ?? []).filter((s) => s.text !== text);
  const id = `s${Date.now().toString(36)}${rest.length}`;
  return { ...tree, stops: [...rest, { id, line: tree.active, after: tree.nodes.length - 1, text, why, state }] };
}

export function markStop(tree: Tree, text: string, state: Stop['state']): Tree {
  if (!tree.stops?.some((s) => s.text === text && s.state !== state)) return tree;
  return { ...tree, stops: tree.stops.map((s) => (s.text === text ? { ...s, state } : s)) };
}

/** The prompt went through after all, or the employee cleared the mark. */
export function dropStop(tree: Tree, text: string): Tree {
  if (!tree.stops?.some((s) => s.text === text)) return tree;
  return { ...tree, stops: tree.stops.filter((s) => s.text !== text) };
}

/** What the agent said a prompt is about, when it looked at it. */
export interface TopicHint {
  id: string;
  label: string;
}

export const TOPICS: { id: string; label: string; task: string; match: RegExp }[] = [
  { id: 'sheet', label: 'Comparison spreadsheet', task: 't3', match: /\b(spreadsheet|excel|sheet|matrix|columns?|table)\b/i },
  { id: 'deck', label: 'Presentation', task: 't4', match: /\b(presentation|deck|slides?|outline|executive summary|talking points)\b/i },
  { id: 'analysis', label: 'Analysis', task: 't2', match: /\b(analy[sz]e|analysis|findings|pricing|prices?|strengths?|weakness(es)?|gaps?|positioning)\b/i },
  { id: 'research', label: 'Competitor research', task: 't1', match: /\b(competitors?|research|shortlist|stocksmith|pantryline|crateworks|tallyhouse|larder)\b/i },
];

/** How many visits to an implicit line before Layers gives it a chat of its own. */
export const PROMOTE_AFTER = 2;

/**
 * Whether a noticed direction has earned a chat of its own. Coming back to it once is
 * enough when it is a real share of the conversation. A small aside has to grow to three
 * prompts, or be returned to twice, first.
 */
export function earnsChat(tree: Tree, line: Line): boolean {
  if (line.kind !== 'implicit' || line.settled || line.visits < PROMOTE_AFTER) return false;
  const chat = chatOf(tree, line.id);
  const mine = tree.nodes.filter((n) => n.line === line.id).length;
  const all = tree.nodes.filter((n) => chatOf(tree, n.line) === chat).length;
  return line.visits > PROMOTE_AFTER || mine >= 3 || mine * 3 >= all;
}

export const topicOf = (text: string): string | null => TOPICS.find((t) => t.match.test(text))?.id ?? null;
export const topicLabel = (id: string | null): string => TOPICS.find((t) => t.id === id)?.label ?? 'New direction';
export const lineLabel = (line: Line): string => line.label ?? topicLabel(line.topic);

export const seedTree = (firstPrompt: string): Tree => ({
  lines: [{ id: 'main', kind: 'main', parent: null, forkNode: null, topic: 'research', merged: false, visits: 1 }],
  nodes: [{ id: 'n0', line: 'main', text: firstPrompt, seq: 0, reopened: false, visit: 1 }],
  active: 'main',
});

const lineOf = (tree: Tree, id: string) => tree.lines.find((l) => l.id === id)!;
const swap = (lines: Line[], next: Line) => lines.map((l) => (l.id === next.id ? next : l));

/** The chat a line belongs to: implicit lines live inside their parent's chat. */
export function chatOf(tree: Tree, lineId: string): string {
  let line = lineOf(tree, lineId);
  while (line.kind === 'implicit' && line.parent) line = lineOf(tree, line.parent);
  return line.id;
}

export interface Added {
  tree: Tree;
  /** A new implicit line was created for this prompt. */
  branched: Line | null;
  /** The prompt came back to an implicit line that had been left. */
  returned: Line | null;
  /** The prompt was sent to a chat Layers made earlier for this direction. */
  routed: Line | null;
}

/**
 * Record a prompt that was sent, deciding which line it belongs on.
 * `hint` is the agent's reading of the prompt: a direction, or null for "this carries on".
 * Leave it out when nobody looked, and the keyword list decides.
 */
export function addPrompt(tree: Tree, text: string, seq: number, hint?: TopicHint | null): Added {
  const current = lineOf(tree, tree.active);
  const topic = hint === undefined ? topicOf(text) : (hint?.id ?? null);
  const label = hint && !TOPICS.some((t) => t.id === hint.id) ? hint.label : undefined;
  let lines = tree.lines;
  let target = current;
  let branched: Line | null = null;
  let routed: Line | null = null;

  if (topic && !current.topic) {
    target = { ...current, topic, label };
    lines = swap(lines, target);
  } else if (topic && topic !== current.topic) {
    const chat = chatOf(tree, current.id);
    // Going back to something already started re-opens that line instead of making a new one.
    const earlier = lines.find((l) => l.topic === topic && !l.merged && chatOf(tree, l.id) === chat);
    // A chat Layers already made for this direction is where it belongs.
    const home = lines.find((l) => l.promoted && l.topic === topic && !!l.parent && chatOf(tree, l.parent) === chat);
    if (earlier) {
      target = earlier;
    } else if (home) {
      target = home;
      routed = home;
    } else {
      // A noticed direction hangs off the chat itself, not off whichever direction came before
      // it. That way moving one direction into its own chat never drags another along.
      const last = [...tree.nodes].reverse().find((n) => chatOf(tree, n.line) === chat);
      branched = {
        id: `l${lines.length}`,
        kind: 'implicit',
        parent: chat,
        forkNode: last?.id ?? null,
        topic,
        label,
        merged: false,
        visits: 1,
        cut: seq,
      };
      lines = [...lines, branched];
      target = branched;
    }
  }

  const previous = tree.nodes[tree.nodes.length - 1];
  const reopened = !branched && !!previous && previous.line !== target.id && tree.nodes.some((n) => n.line === target.id);
  if (reopened) {
    target = { ...target, visits: target.visits + 1 };
    lines = swap(lines, target);
  }
  const node: PromptNode = { id: `n${tree.nodes.length}`, line: target.id, text, seq, reopened, visit: target.visits };
  return {
    tree: { ...tree, lines, nodes: [...tree.nodes, node], active: target.id },
    branched,
    returned: reopened && target.kind === 'implicit' ? target : null,
    routed,
  };
}

/** The employee pressed Branch: a new chat that starts after the given prompt. */
export function branchFrom(tree: Tree, nodeId: string): Tree {
  const node = tree.nodes.find((n) => n.id === nodeId);
  if (!node) return tree;
  const line: Line = {
    id: `l${tree.lines.length}`,
    kind: 'explicit',
    parent: node.line,
    forkNode: node.id,
    topic: null,
    merged: false,
    visits: 1,
  };
  return { ...tree, lines: [...tree.lines, line], active: line.id };
}

/** Fold an implicit line back into the line it came from. */
export function mergeBack(tree: Tree, lineId: string): Tree {
  const line = lineOf(tree, lineId);
  if (line.kind !== 'implicit' || !line.parent) return tree;
  return {
    ...tree,
    lines: swap(tree.lines, { ...line, merged: true }),
    active: tree.active === lineId ? line.parent : tree.active,
  };
}

/** The implicit lines of a chat that are still open. */
export const openLines = (tree: Tree, chat: string): Line[] =>
  tree.lines.filter((l) => l.kind === 'implicit' && !l.merged && chatOf(tree, l.id) === chat);

/** Fold every open implicit line of the active chat back in. */
export function mergeAll(tree: Tree): Tree {
  const chat = chatOf(tree, tree.active);
  const open = new Set(openLines(tree, chat).map((l) => l.id));
  if (open.size === 0) return tree;
  return {
    ...tree,
    lines: tree.lines.map((l) => (open.has(l.id) ? { ...l, merged: true } : l)),
    active: open.has(tree.active) ? chat : tree.active,
  };
}

/** Turn an implicit line into a chat of its own, and go there. `byLayers` when the agent did it. */
export function promote(tree: Tree, lineId: string, byLayers: boolean): Tree {
  const line = lineOf(tree, lineId);
  if (line.kind !== 'implicit') return tree;
  return { ...tree, lines: swap(tree.lines, { ...line, kind: 'explicit', promoted: byLayers }), active: lineId };
}

/** Put a chat that started as an implicit line back inside the chat it came from. */
export function fold(tree: Tree, lineId: string): Tree {
  const line = lineOf(tree, lineId);
  if (line.kind !== 'explicit' || line.cut === undefined) return tree;
  return { ...tree, lines: swap(tree.lines, { ...line, kind: 'implicit', promoted: false, settled: true }) };
}

/** The employee wants this line left alone. */
export function settle(tree: Tree, lineId: string): Tree {
  return { ...tree, lines: swap(tree.lines, { ...lineOf(tree, lineId), settled: true }) };
}

/** The position in the conversation where a chat stops sharing its parent's messages. */
function cutoff(tree: Tree, head: Line): number {
  if (head.cut !== undefined) return head.cut;
  const fork = tree.nodes.findIndex((n) => n.id === head.forkNode);
  return tree.nodes[fork + 1]?.seq ?? Infinity;
}

/**
 * Whether a message shows in the thread for the active line. A chat shows its own
 * messages, plus everything its parent chats said up to the point it split off.
 */
export function isVisible(tree: Tree, message: { line?: string; seq?: number }): boolean {
  const line = message.line ?? 'main';
  const seq = message.seq ?? 0;
  if (!tree.lines.some((l) => l.id === line)) return true;
  let chat = chatOf(tree, tree.active);
  const mine = chatOf(tree, line);
  if (mine === chat) return true;
  for (;;) {
    const head = lineOf(tree, chat);
    if (!head.parent || !head.forkNode) return false;
    const stop = cutoff(tree, head);
    chat = chatOf(tree, head.parent);
    if (seq >= stop) return false;
    if (mine === chat) return true;
  }
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** What a chat is called in the chat list. */
export function chatTitle(tree: Tree, lineId: string, rootTitle: string): string {
  const line = lineOf(tree, lineId);
  if (line.kind === 'main') return rootTitle;
  if (line.label || line.topic) return lineLabel(line);
  const first = tree.nodes.find((n) => n.line === lineId);
  return first ? clip(first.text, 26) : 'New branch';
}

export interface Chat {
  id: string;
  parent: string | null;
  /** How many chats deep this one is: 0 for the first chat. */
  depth: number;
  prompts: number;
  byLayers: boolean;
  /** Where this chat's own messages begin. */
  startsAt: number;
}

/** Every chat, each one followed by the chats that split off it. */
export function chatsOf(tree: Tree): Chat[] {
  const heads = tree.lines.filter((l) => l.kind !== 'implicit');
  const out: Chat[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const head of heads) {
      if ((head.parent ? chatOf(tree, head.parent) : null) !== parent) continue;
      out.push({
        id: head.id,
        parent,
        depth,
        prompts: tree.nodes.filter((n) => chatOf(tree, n.line) === head.id).length,
        byLayers: !!head.promoted,
        startsAt: head.parent ? cutoff(tree, head) : 0,
      });
      walk(head.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** The line to land on when a chat is opened: where the employee last was in it. */
export function lastLineIn(tree: Tree, chat: string): string {
  const last = [...tree.nodes].reverse().find((n) => chatOf(tree, n.line) === chat && !lineOf(tree, n.line).merged);
  return last?.line ?? chat;
}

/** The shape of a conversation with nothing that was typed in it. This is all a map needs. */
export interface MapShape {
  lines: {
    id: string;
    kind: Line['kind'];
    parent: string | null;
    /** Index of the prompt this line split off after. */
    fork: number | null;
    label: string;
    merged: boolean;
    promoted: boolean;
  }[];
  nodes: { line: string; reopened: boolean; visit: number }[];
  active: string;
  /** Prompts that were stopped: where, and how it ended. Never what they said. */
  stops?: { line: string; after: number; state: Stop['state'] }[];
}

const stopShapes = (tree: Tree) => (tree.stops ?? []).map((s) => ({ line: s.line, after: s.after, state: s.state }));

export function shapeOf(tree: Tree, rootTitle?: string): MapShape {
  return {
    lines: tree.lines.map((l) => ({
      id: l.id,
      kind: l.kind,
      parent: l.parent,
      fork: l.forkNode ? tree.nodes.findIndex((n) => n.id === l.forkNode) : null,
      label: l.kind === 'main' && rootTitle ? rootTitle : chatTitle(tree, l.id, lineLabel(l)),
      merged: l.merged,
      promoted: !!l.promoted,
    })),
    nodes: tree.nodes.map((n) => ({ line: n.line, reopened: n.reopened, visit: n.visit })),
    active: tree.active,
    stops: stopShapes(tree),
  };
}

/** What is sent to the server for the manager: the shape, with topic ids instead of labels. */
export function outlineOf(tree: Tree) {
  return {
    lines: tree.lines.map((l) => ({
      id: l.id,
      kind: l.kind,
      parent: l.parent,
      fork: l.forkNode ? tree.nodes.findIndex((n) => n.id === l.forkNode) : null,
      // Only the four project areas are named. Anything else is sent as "other".
      topic: TOPICS.some((t) => t.id === l.topic) ? l.topic : l.topic ? 'other' : null,
      merged: l.merged,
      promoted: !!l.promoted,
    })),
    nodes: tree.nodes.map((n) => ({ line: n.line, reopened: n.reopened, visit: n.visit })),
    active: tree.active,
    stops: stopShapes(tree),
  };
}

/** How many prompts went to each direction, biggest first. */
export function effort(tree: Tree): { topic: string | null; label: string; prompts: number }[] {
  const by = new Map<string, { topic: string | null; label: string; prompts: number }>();
  for (const node of tree.nodes) {
    const line = lineOf(tree, node.line);
    const key = line.label ?? line.topic ?? 'none';
    const row = by.get(key) ?? { topic: line.topic, label: line.topic || line.label ? lineLabel(line) : 'Unsorted', prompts: 0 };
    row.prompts += 1;
    by.set(key, row);
  }
  return [...by.values()].sort((a, b) => b.prompts - a.prompts);
}
