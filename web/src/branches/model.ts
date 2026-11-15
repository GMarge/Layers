/**
 * How a chat splits into branches.
 *
 * - explicit: the employee pressed Branch. It is a new chat that starts from that point.
 * - implicit: nobody pressed anything, but the conversation moved to a different part of
 *   the project. Layers notices and gives the new direction its own line.
 *
 * Direction is judged by which project task a prompt is about. It is plain keyword
 * matching, not a model, so it is cheap and predictable.
 */

export interface Line {
  id: string;
  kind: 'main' | 'implicit' | 'explicit';
  parent: string | null;
  /** The prompt this line split off after. */
  forkNode: string | null;
  topic: string | null;
  /** An implicit line that was folded back into its parent. */
  merged: boolean;
}

export interface PromptNode {
  id: string;
  line: string;
  text: string;
  /** Position of this prompt among all messages. */
  seq: number;
  /** First prompt after coming back to a line that had been left. */
  reopened: boolean;
}

export interface Tree {
  lines: Line[];
  nodes: PromptNode[];
  active: string;
}

export const TOPICS: { id: string; label: string; match: RegExp }[] = [
  { id: 'sheet', label: 'Comparison spreadsheet', match: /\b(spreadsheet|excel|sheet|matrix|columns?|table)\b/i },
  { id: 'deck', label: 'Presentation', match: /\b(presentation|deck|slides?|outline|executive summary|talking points)\b/i },
  { id: 'analysis', label: 'Analysis', match: /\b(analy[sz]e|analysis|findings|pricing|prices?|strengths?|weakness(es)?|gaps?|positioning)\b/i },
  { id: 'research', label: 'Competitor research', match: /\b(competitors?|research|shortlist|stocksmith|pantryline|crateworks|tallyhouse|larder)\b/i },
];

export const topicOf = (text: string): string | null => TOPICS.find((t) => t.match.test(text))?.id ?? null;
export const topicLabel = (id: string | null): string => TOPICS.find((t) => t.id === id)?.label ?? 'New direction';

export const seedTree = (firstPrompt: string): Tree => ({
  lines: [{ id: 'main', kind: 'main', parent: null, forkNode: null, topic: 'research', merged: false }],
  nodes: [{ id: 'n0', line: 'main', text: firstPrompt, seq: 0, reopened: false }],
  active: 'main',
});

const lineOf = (tree: Tree, id: string) => tree.lines.find((l) => l.id === id)!;

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
}

/** Record a prompt that was sent, deciding which line it belongs on. */
export function addPrompt(tree: Tree, text: string, seq: number): Added {
  const current = lineOf(tree, tree.active);
  const topic = topicOf(text);
  let lines = tree.lines;
  let target = current;
  let branched: Line | null = null;

  if (topic && !current.topic) {
    target = { ...current, topic };
    lines = lines.map((l) => (l.id === current.id ? target : l));
  } else if (topic && topic !== current.topic) {
    // Going back to something already started re-opens that line instead of making a new one.
    const chat = chatOf(tree, current.id);
    const earlier = lines.find((l) => l.topic === topic && !l.merged && chatOf(tree, l.id) === chat);
    if (earlier) {
      target = earlier;
    } else {
      const last = [...tree.nodes].reverse().find((n) => n.line === current.id);
      branched = {
        id: `l${lines.length}`,
        kind: 'implicit',
        parent: current.id,
        forkNode: last?.id ?? null,
        topic,
        merged: false,
      };
      lines = [...lines, branched];
      target = branched;
    }
  }

  const previous = tree.nodes[tree.nodes.length - 1];
  const node: PromptNode = {
    id: `n${tree.nodes.length}`,
    line: target.id,
    text,
    seq,
    reopened: !branched && !!previous && previous.line !== target.id && tree.nodes.some((n) => n.line === target.id),
  };
  return { tree: { lines, nodes: [...tree.nodes, node], active: target.id }, branched };
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
  };
  return { ...tree, lines: [...tree.lines, line], active: line.id };
}

/** Fold an implicit line back into the line it came from. */
export function mergeBack(tree: Tree, lineId: string): Tree {
  const line = lineOf(tree, lineId);
  if (line.kind !== 'implicit' || !line.parent) return tree;
  return {
    ...tree,
    lines: tree.lines.map((l) => (l.id === lineId ? { ...l, merged: true } : l)),
    active: tree.active === lineId ? line.parent : tree.active,
  };
}

/** Turn an implicit line into a chat of its own. */
export function detach(tree: Tree, lineId: string): Tree {
  return { ...tree, lines: tree.lines.map((l) => (l.id === lineId ? { ...l, kind: 'explicit' } : l)) };
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
    const fork = tree.nodes.findIndex((n) => n.id === head.forkNode);
    const cutoff = tree.nodes[fork + 1]?.seq ?? Infinity;
    chat = chatOf(tree, head.parent);
    if (seq >= cutoff) return false;
    if (mine === chat) return true;
  }
}
