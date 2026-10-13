import type { SavedUsage, Task, TaskStatus } from '../src/ui/types';

// Synthetic fixtures only. The video never reads local chats or calls MCP/GitHub.
export const HERO_ID = '00000000-0000-7000-8000-000000000001';
export const DEMO_NOW = Date.parse('2026-01-01T12:00:00Z');
export const PROJECTS = [
  { value: '', label: 'All projects' },
  { value: 'atlas', label: 'Atlas' },
  { value: 'beacon', label: 'Beacon' },
  { value: 'studio', label: 'Studio' },
];
export const LANES: { status: TaskStatus; label: string; emptyMessage: string }[] = [
  { status: 'working', label: 'Running', emptyMessage: 'No chats running' },
  { status: 'needs_input', label: 'Waiting for review', emptyMessage: 'No chats waiting for review' },
  { status: 'completed', label: 'Done', emptyMessage: 'No completed chats' },
];
export function usage(total: number, cost: number): SavedUsage {
  const output = Math.round(total * .08);
  return { tokens: { input_tokens: total - output, cached_input_tokens: Math.round(total * .6), cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: Math.round(output * .5), total_tokens: total }, costUsd: cost, samples: 8, partial: false, costPartial: false };
}
function chat(id: number, title: string, project: string, status: TaskStatus, prompt: string, response: string): Task {
  const uuid = `00000000-0000-7000-8000-${String(id).padStart(12, '0')}`;
  const updatedAt = new Date(DEMO_NOW - id * 60_000).toISOString();
  const latest = usage(320_000 + id * 80_000, .28 + id * .09);
  return {
    id: uuid, threadId: uuid, turnId: `demo-turn-${id}`, turnRef: `demo-turn-${id}`,
    title, instruction: prompt, project: { id: project, name: PROJECTS.find(p => p.value === project)!.label, path: `/demo/${project}`, githubRepos: [] },
    createdAt: updatedAt, updatedAt, status, summary: response,
    lastResult: null, latestTurn: null,
    promptText: prompt, promptExcerpt: prompt, replyText: response, replyExcerpt: response,
    inputSource: 'ordinary',
    observed: { archive: false, source: 'vscode', lastTurnEvent: status === 'working' ? 'inProgress' : 'completed', lastTurnEventAt: updatedAt, latestTurnDurationMs: 4 * 60_000, recordedChatDurationMs: 28 * 60_000, recentFileActivity: status === 'working' },
    turnUsage: latest, sessionUsage: { latest, total: usage(latest.tokens.total_tokens * 4, latest.costUsd * 4), subagents: 0, pricingDate: '2026-01-01' },
  };
}
export type Phase = 'running' | 'review' | 'merged';
export function demoTasks(phase: Phase, project = ''): Task[] {
  const hero = chat(1, 'Build project search', 'atlas', phase === 'running' ? 'working' : phase === 'review' ? 'needs_input' : 'completed',
    'Add fast project search. Keep keyboard navigation and cover the empty state.',
    'Project search is ready. Keyboard navigation and the empty state are covered. Tests passed.');
  hero.turnUsage = usage(1_240_000, .86);
  hero.sessionUsage = { latest: hero.turnUsage, total: usage(5_320_000, 3.72), subagents: 0, pricingDate: '2026-01-01' };
  hero.pullRequests = phase === 'running' ? [] : [{ url: 'https://github.com/example/atlas/pull/42', title: 'Add project search', state: phase === 'merged' ? 'merged' : 'open', checks: 'passed' }];
  hero.detailPullRequests = hero.pullRequests;
  const tasks = [hero,
    chat(2, 'Improve checkout validation', 'beacon', 'working', 'Check the payment form and add clear validation for incomplete addresses.', 'Checkout validation is ready for review.'),
    chat(5, 'Update onboarding', 'studio', 'needs_input', 'Simplify the first project setup.', 'The new onboarding flow is ready. Preview and tests passed.'),
    chat(6, 'Fix notification layout', 'atlas', 'completed', 'Fix the notification layout on small screens.', 'Notification layout fixed. PR merged.'),
  ];
  return project ? tasks.filter(task => task.project.id === project) : tasks;
}
