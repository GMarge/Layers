import {
  assignedWorkRule,
  competitorMatrix,
  competitors,
  manager,
  outlineSections,
  project,
  readoutOutline,
} from '../workspace/data';
import type { AskAnswer, KnowledgeItem, LayersService, Step, Verdict } from './types';

/**
 * Scripted stand-in for the Layers API. Nothing here calls a model.
 *
 * It follows the same contract the FastAPI + DeepAgents backend will
 * implement, so replacing it only changes the line in App.tsx that creates
 * the service. The tool names below are the ones the real agent will expose.
 */

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const OFF_TOPIC =
  /\b(vacation|holiday|ski|skiing|snowboard|trip|flights?|hotel|airbnb|itinerary|recipe|dinner|movie|netflix|dating|birthday|gift|workout|gym|fantasy football|horoscope|wedding|apartment|crypto|lottery|video games?|playlist|concert)\b/i;
const ON_PROJECT =
  /\b(competitors?|competitive|comparison|compares?|pricing|market|analysis|project x|stocksmith|pantryline|crateworks|tallyhouse|larder|presentation|deck|slides|findings|grocers?|inventory)\b/i;
const REBUILD =
  /\b(build|create|make|generate|write|set up|automate)\b[\s\S]*\b(spreadsheet|excel|sheet|matrix|table|template|workflow|automation|outline)\b/i;
const ABOUT_DECK = /\b(outline|presentation|deck|slides|readout)\b/i;

/** The approved team workflow that fits a request. */
const workflowFor = (text: string): KnowledgeItem => (ABOUT_DECK.test(text) ? readoutOutline : competitorMatrix);

const VAGUE = /\b(budget|offsite|email|schedule)\b/i;

/** Every distinct word in the prompt that matches a pattern. */
const hits = (re: RegExp, text: string) => [
  ...new Set((text.match(new RegExp(re.source, 'gi')) ?? []).map((w) => w.toLowerCase())),
];

const list = (words: string[]) => words.map((w) => `"${w}"`).join(', ');

function classify(prompt: string): Verdict {
  const fits = hits(ON_PROJECT, prompt);
  const against = hits(OFF_TOPIC, prompt);

  // Evidence on both sides, or none either way: say so instead of guessing.
  if (fits.length > 0 && against.length > 0) {
    return {
      kind: 'unsure',
      rule: assignedWorkRule,
      reason: `It mentions ${list(fits)} from the ${project.name} brief, and also ${list(against)}, which the brief does not cover.`,
      signals: { fits, against },
    };
  }
  if (fits.length === 0 && against.length === 0 && VAGUE.test(prompt)) {
    return {
      kind: 'unsure',
      rule: assignedWorkRule,
      reason: `Nothing here names ${project.name} or anything in its brief, but it could still be work.`,
      signals: { fits, against: hits(VAGUE, prompt) },
    };
  }
  if (REBUILD.test(prompt) && ON_PROJECT.test(prompt)) {
    const item = workflowFor(prompt);
    return { kind: 'reuse', item, reason: `${item.author} already built a workflow for this.` };
  }
  if (OFF_TOPIC.test(prompt) && !ON_PROJECT.test(prompt)) {
    return {
      kind: 'policy',
      rule: assignedWorkRule,
      reason: `Nothing in the prompt connects to the ${project.title.toLowerCase()}.`,
      signals: { fits, against },
    };
  }
  return { kind: 'pass' };
}

const ASKS_LIMITS = /\b(limits?|allowed|rules?|policy|policies|what can i)\b/i;
const ASKS_EXISTING = /\b(built|already|existing|template|workflow|matrix|spreadsheet|reuse|anyone)\b/i;
const PERSONAL = /\b(personal|travel|side project|my own|homework|weekend)\b/i;

function answer(question: string): AskAnswer {
  if (ASKS_LIMITS.test(question)) {
    return {
      text: `Two rules apply to you in this workspace. Anything tied to ${project.name} goes straight through.`,
      showLimits: true,
    };
  }
  if (ASKS_EXISTING.test(question)) {
    const item = workflowFor(question);
    return { text: `Yes. ${item.author} built one, it is approved, and you have access.`, item };
  }
  if (OFF_TOPIC.test(question) || PERSONAL.test(question)) {
    return {
      text: `Not in this workspace. It is kept for assigned project work, and that falls outside ${project.name}. I can ask ${manager.first} for an exception.`,
      rule: assignedWorkRule,
      canRequest: true,
    };
  }
  if (ON_PROJECT.test(question)) {
    return { text: `Yes. That is part of ${project.name}, so it will go straight through.` };
  }
  return {
    text: 'I can answer questions about your project, the workspace rules and what your team has already built. Anything else needs the live agent, which is not connected in this preview.',
  };
}

const planFor = (item: KnowledgeItem, rows: number) => [
  {
    id: 's1',
    tool: 'search_org_memory',
    label: "Finding your team's approved workflow",
    detail: item.name,
    ms: 900,
  },
  {
    id: 's2',
    tool: 'check_access',
    label: 'Confirming you are allowed to use it',
    detail: 'shared with Strategy',
    ms: 700,
  },
  {
    id: 's3',
    tool: 'create_project_artifact',
    label: `Building it in ${project.name}`,
    detail: `${rows} rows, ${item.columns.length} columns`,
    ms: 1100,
  },
  {
    id: 's4',
    tool: 'update_task_status',
    label: `Updating your ${project.name} tasks`,
    detail: 'task in progress',
    ms: 700,
  },
];

const PLAN = planFor(competitorMatrix, competitors.length);

const stepOf = (p: (typeof PLAN)[number], status: Step['status']): Step => ({
  id: p.id,
  tool: p.tool,
  label: p.label,
  status,
  detail: status === 'done' ? p.detail : undefined,
});

/** A frozen mid-run snapshot, used by the design lab to hold the working state still. */
export const previewSteps: Step[] = [stepOf(PLAN[0]!, 'done'), stepOf(PLAN[1]!, 'done'), stepOf(PLAN[2]!, 'running')];

let requestSeq = 41;

export function createMockService(speed: () => number = () => 1): LayersService {
  return {
    async preflight(prompt, onProgress) {
      const verdict = classify(prompt);
      if (verdict.kind === 'pass') {
        onProgress({ engaged: false });
        await wait(260 * speed());
        return verdict;
      }
      onProgress({ engaged: true, note: `Reading the ${project.name} brief` });
      await wait(620 * speed());
      onProgress({
        engaged: true,
        note: verdict.kind === 'reuse' ? 'Searching approved team workflows' : 'Checking the workspace rules',
      });
      await wait(640 * speed());
      return verdict;
    },

    async applyWorkflow(itemId, _prompt, onEvent, signal) {
      const outline = itemId === readoutOutline.id;
      const item = outline ? readoutOutline : competitorMatrix;
      const first = outline ? outlineSections : competitors.map(([name]) => name);
      for (const p of planFor(item, first.length)) {
        if (signal.aborted) return;
        onEvent({ type: 'step', step: stepOf(p, 'running') });
        await wait(p.ms * speed());
        if (signal.aborted) return;
        onEvent({ type: 'step', step: stepOf(p, 'done') });
      }
      onEvent({
        type: 'result',
        summary: `${outline ? 'Presentation outline' : 'Comparison sheet'} added to ${project.name}.`,
        detail: outline
          ? `Its ${first.length} sections are laid out and ready to fill in. "Draft presentation" is now in progress.`
          : `The ${first.length} competitors from this project are filled in. "Build comparison spreadsheet" is now in progress.`,
        taskId: outline ? 't4' : 't3',
        artifact: {
          id: `sheet-${Date.now().toString(36)}`,
          title: `${project.name} ${outline ? 'readout outline' : 'competitor matrix'}`,
          source: item.name,
          author: item.author,
          columns: item.columns,
          rows: first.map((name) => [name, ...item.columns.slice(1).map(() => '')]),
        },
      });
    },

    async ask(question) {
      await wait(700 * speed());
      return answer(question);
    },

    async requestApproval() {
      await wait(320 * speed());
      requestSeq += 1;
      return { id: `EX-${String(requestSeq).padStart(4, '0')}`, approver: manager.name };
    },

    async recordFeedback() {
      await wait(60);
    },

    async draftUpdate(onEvent) {
      onEvent({
        type: 'plan',
        todos: [
          { content: "Read the project and today's activity", status: 'in_progress' },
          { content: 'Write the update', status: 'pending' },
          { content: 'Send it once approved', status: 'pending' },
        ],
      });
      const reads: [string, string, string][] = [
        ['get_project_context', `Reading the ${project.name} brief`, `${project.name}, 4 tasks`],
        ['get_todays_activity', 'Reading what got done today', '1 done, 1 in progress'],
      ];
      for (const [tool, label, detail] of reads) {
        onEvent({ type: 'step', step: { id: tool, tool, label, status: 'running' } });
        await wait(700 * speed());
        onEvent({ type: 'step', step: { id: tool, tool, label, status: 'done', detail } });
      }
      return {
        text: `Here is where ${project.name} stands. Done: research five competitors. In progress: analyze findings. Still to start: build comparison spreadsheet, draft presentation.`,
        thread: null,
        by: 'code',
      };
    },

    async sendUpdate(_thread, _text, approved, onEvent) {
      await wait(300 * speed());
      if (!approved) return;
      onEvent({
        type: 'step',
        step: {
          id: 'send_status_update',
          tool: 'send_status_update',
          label: `Sending the update to ${manager.name}`,
          status: 'done',
          detail: 'preview only, nothing was sent',
        },
      });
    },
  };
}
