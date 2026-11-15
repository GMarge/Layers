import type { AgentEvent, AskAnswer, CheckProgress, LayersService, Verdict } from './types';

/**
 * The real Layers backend (FastAPI + DeepAgents), reached through the dev server's
 * /api proxy so the browser only ever talks to one origin.
 */

export interface BackendStatus {
  agent: boolean;
  model: string | null;
  error: string | null;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} failed with ${res.status}`);
  return (await res.json()) as T;
}

/** Reads a server-sent event stream and hands over each event as it arrives. */
async function stream(path: string, body: unknown, onEvent: (e: Record<string, unknown>) => void, signal?: AbortSignal) {
  const res = await fetch(`/api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`${path} failed with ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split: number;
    while ((split = buffer.indexOf('\n\n')) >= 0) {
      const line = buffer.slice(0, split).trim();
      buffer = buffer.slice(split + 2);
      if (line.startsWith('data:')) onEvent(JSON.parse(line.slice(5)) as Record<string, unknown>);
    }
  }
}

const service: LayersService = {
  async preflight(prompt, onProgress, where) {
    let verdict: Verdict | null = null;
    await stream('preflight', { prompt, ...where }, (e) => {
      if (e.type === 'progress') onProgress(e as unknown as CheckProgress);
      else if (e.type === 'verdict') verdict = e.verdict as Verdict;
      else if (e.type === 'error') throw new Error(String(e.message));
    });
    if (!verdict) throw new Error('Layers did not return a decision.');
    return verdict;
  },

  async applyWorkflow(itemId, prompt, onEvent, signal) {
    await stream(
      'apply',
      { workflow_id: itemId, prompt },
      (e) => {
        if (e.type === 'step' || e.type === 'result' || e.type === 'plan') onEvent(e as unknown as AgentEvent);
        else if (e.type === 'error') throw new Error(String(e.message));
      },
      signal,
    );
  },

  ask: (question) => post<AskAnswer>('ask', { prompt: question }),
  requestApproval: (prompt, note) => post('approvals', { prompt, note: note ?? '' }),

  async recordFeedback(kind, prompt, note) {
    await post('feedback', { kind, prompt, note: note ?? '' });
  },

  async reply(prompt, context) {
    try {
      return await post<{ text: string; placeholder: boolean }>('chat', { prompt, context });
    } catch {
      return { text: 'Layers did not clear this prompt, so it was not sent to the workspace model.', placeholder: true };
    }
  },

  async undo(artifactId, taskId) {
    await post('undo', { artifact_id: artifactId, task_id: taskId });
  },

  async decide(requestId, approved) {
    await post(`approvals/${requestId}/decide`, { approved });
  },

  async sync(settings) {
    await post('settings', { policy_mode: settings.policyMode, unsure_mode: settings.unsureMode });
  },

  async settings() {
    const res = await fetch('/api/settings');
    if (!res.ok) throw new Error('settings unavailable');
    const s = (await res.json()) as { policy_mode: 'warn' | 'approval'; unsure_mode: 'ask' | 'allow' | 'defer' };
    return { policyMode: s.policy_mode, unsureMode: s.unsure_mode };
  },

  async approvalStatus(requestId) {
    const res = await fetch(`/api/approvals/${requestId}`);
    if (!res.ok) return 'pending';
    return ((await res.json()) as { status: 'pending' | 'approved' | 'declined' }).status;
  },

  async reset() {
    await post('reset', {});
  },

  async branches(outline) {
    await post('branches', outline);
  },

  async draftUpdate(onEvent) {
    let draft: { text: string; thread: string | null; by: 'agent' | 'code' } | null = null;
    await stream('update/draft', {}, (e) => {
      if (e.type === 'step' || e.type === 'plan') onEvent(e as unknown as AgentEvent);
      else if (e.type === 'draft') draft = { text: String(e.text), thread: (e.thread as string | null) ?? null, by: e.by === 'agent' ? 'agent' : 'code' };
      else if (e.type === 'error') throw new Error(String(e.message));
    });
    if (!draft) throw new Error('No draft came back.');
    return draft;
  },

  async sendUpdate(thread, text, approved, onEvent) {
    await stream('update/send', { thread, text, approved }, (e) => {
      if (e.type === 'step' || e.type === 'plan') onEvent(e as unknown as AgentEvent);
      else if (e.type === 'error') throw new Error(String(e.message));
    });
  },
};

/** Returns the backend service if the Layers server is running, otherwise null. */
export async function connect(): Promise<{ service: LayersService; status: BackendStatus } | null> {
  try {
    const res = await fetch('/api/health', { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const status = (await res.json()) as BackendStatus & { ok?: boolean };
    return status.ok ? { service, status } : null;
  } catch {
    return null;
  }
}
