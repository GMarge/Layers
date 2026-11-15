import type { KnowledgeItem, Message, Rule, Task } from '../layers/types';

/** Everything in this file is fictional seed data for the demo workspace. */

export const company = { name: 'Fernhill', assistant: 'Fernhill AI' };
export const employee = { name: 'Jordan Lee', initials: 'JL', role: 'Intern, Strategy' };
export const manager = { name: 'Priya Nair', first: 'Priya' };

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
  text: 'Use Fernhill AI for work on your assigned projects.',
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
  author: 'Marcus Bell',
  team: 'Strategy',
  reviewedOn: 'Oct 28, 2026',
  approvedBy: manager.name,
  access: 'Shared with Strategy, interns included',
  columns: ['Company', 'Segment', 'Pricing model', 'Standout feature', 'Gap we can use'],
  inputs: 'A list of competitor names',
};

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
  unsure: 'Compare ski resort pricing for the team offsite',
  onTopic: 'Summarize how Stocksmith and Pantryline price their plans',
};
