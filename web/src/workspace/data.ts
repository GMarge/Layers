import type { KnowledgeItem, Message, Rule, Task, TeamProcess } from '../layers/types';

/** Everything in this file is fictional seed data for the demo workspace. */

export const company = { name: 'The Company Company', assistant: 'The Company Company' };
export const employee = { name: 'Gavin Margerum', initials: 'GM', role: 'Intern' };
export const manager = { name: 'Michael Scott', first: 'Michael' };

export const project = {
  name: 'Project X',
  title: 'Competitor analysis',
  due: 'Fri, Nov 20',
  assignedBy: manager.name,
};

export const competitors: [name: string, note: string][] = [
  ['Stocksmith', 'Shelf-level inventory for mid-size grocers, with the strongest reporting.'],
  ['Pantryline', 'Low-cost ordering app aimed at single-store owners.'],
  ['Crateworks', 'Supplier marketplace with built-in reordering.'],
  ['Tallyhouse', 'Point-of-sale suite where inventory is an add-on.'],
  ['Larder & Co', 'Newest entrant, with mobile-only stock counts.'],
];

export const seedTasks: Task[] = [
  { id: 't1', title: 'Research five competitors', status: 'done' },
  { id: 't2', title: 'Analyze findings', status: 'doing' },
  { id: 't3', title: 'Build comparison spreadsheet', status: 'todo' },
  { id: 't4', title: 'Draft presentation', status: 'todo' },
];

export const assignedWorkRule: Rule = {
  id: 'AI-01',
  name: 'Assigned work only',
  text: 'Use the company AI for work on your assigned projects.',
  owner: manager.name,
  scope: 'Applies to this workspace only',
};

export const reuseRule: Rule = {
  id: 'AI-02',
  name: 'Reuse before rebuild',
  text: 'Check for an approved team workflow before generating a new one.',
  owner: manager.name,
  scope: 'Applies to this workspace only',
};

export const rules: Rule[] = [assignedWorkRule, reuseRule];

export const competitorMatrix: KnowledgeItem = {
  id: 'wf-competitor-matrix-v2',
  name: 'CompetitorMatrix_v2',
  kind: 'Approved workflow',
  summary: 'Comparison sheet with scoring columns for up to ten competitors.',
  author: 'Dwight Schrute',
  team: 'Strategy',
  reviewedOn: 'Oct 28, 2026',
  approvedBy: manager.name,
  access: 'Shared with Strategy, interns included',
  columns: ['Company', 'Segment', 'Pricing model', 'Standout feature', 'Gap we can use'],
  inputs: 'A list of competitor names',
  usedBy: [
    { who: 'Pam Beesly', project: 'Project Z' },
    { who: 'Dwight Schrute', project: 'Vendor renewal' },
  ],
};

/** How teammates did similar work. The same sample records the server holds. */
export const teamProcesses: TeamProcess[] = [
  {
    who: 'Pam Beesly',
    project: 'Project Z',
    did: 'Laid competitor pricing pages side by side, tier by tier',
    path: ['Pricing pages', 'Plan tiers', 'Comparison spreadsheet'],
    workflow: 'CompetitorMatrix_v2',
    when: '2 days ago',
    sample: true,
  },
  {
    who: 'Dwight Schrute',
    project: 'Project Y',
    did: 'Turned twelve customer interviews into themes, then a synthesis draft',
    path: ['Interview notes', 'Theme tagging', 'Synthesis draft'],
    workflow: 'InterviewSynthesis_v1',
    when: '3 days ago',
    sample: true,
  },
  {
    who: 'Peter Gibbons',
    project: 'Loyalty study',
    did: 'Built the readout presentation for the loyalty study from the findings',
    path: ['Findings', 'Presentation outline', 'Readout'],
    workflow: 'ReadoutOutline_v3',
    when: '9 days ago',
    sample: true,
  },
];

export const readoutOutline: KnowledgeItem = {
  id: 'wf-readout-outline-v3',
  name: 'ReadoutOutline_v3',
  kind: 'Approved workflow',
  summary: 'Presentation outline for a project readout, with the key point, evidence and owner of each section.',
  author: 'Peter Gibbons',
  team: 'Strategy',
  reviewedOn: 'Nov 3, 2026',
  approvedBy: manager.name,
  access: 'Shared with Strategy, interns included',
  columns: ['Section', 'Key point', 'Evidence to show', 'Owner'],
  inputs: "The project's findings",
  usedBy: [{ who: 'Peter Gibbons', project: 'Loyalty study' }],
};

export const outlineSections = ['Why this matters', 'Who we compared', 'What we found', 'Gaps we can use', 'Recommendation'];

export const conversations = ['Competitor shortlist', 'Pricing page teardown', 'Customer interview notes'];

export const seedMessages: Message[] = [
  {
    id: 'seed-1',
    role: 'user',
    text: 'Which five competitors should the Project X analysis cover? One line on each.',
  },
  {
    id: 'seed-2',
    role: 'ai',
    text: 'These five cover the range, from the incumbent to the newest entrant:',
    list: competitors.map(([name, note]) => ({ name, note })),
  },
];

export const examplePrompts = {
  offTopic: 'Plan my ski vacation this weekend',
  rebuild: 'Build me an Excel automation that compares our five competitors',
  unsure: 'Draft an email to Michael with my status update',
  outline: 'Create a presentation outline for the Project X readout',
  onTopic: 'Summarize how Stocksmith and Pantryline price their plans',
};
