import { CodexSessionScanner } from "./codex-session-scanner.js";
import { acquireWorkspaceLock } from "./workspace.js";
import { readUsageStore, writeUsageStore } from "./usage.js";
import { TASKCHEF_VERSION } from "./version.js";

function projection(value, provenance, now, sessionCount) {
  return {
    inputTokens: value.tokens.input_tokens, cachedInputTokens: value.tokens.cached_input_tokens,
    outputTokens: value.tokens.output_tokens, reasoningOutputTokens: value.tokens.reasoning_output_tokens,
    totalTokens: value.tokens.total_tokens, partial: value.partial, costPartial: value.costPartial,
    estimatedCostUsd: value.samples && (!value.costPartial || value.costUsd > 0) ? value.costUsd : null,
    costStatus: value.samples && (!value.costPartial || value.costUsd > 0) ? "estimated" : "unavailable",
    models: {}, provenance: { ...provenance, sessionCount }, sampledAt: now, sourceUpdatedAt: now,
  };
}

export function createRecordedUsageTracker({ workspace, maxConcurrentJobs = 2, scanner = new CodexSessionScanner() }) {
  const pending = new Map(), queue = [];
  let active = 0, closed = false;
  function drain() {
    while (!closed && active < maxConcurrentJobs && queue.length) {
      const job = queue.shift(); active++;
      job.run().then(job.resolve, job.reject).finally(() => { active--; drain(); });
    }
  }
  async function calculate(task) {
    const ref = task.latestTurn?.turnRef;
    const now = new Date().toISOString();
    let result, failure;
    try { result = await scanner.recordedUsage(task.threadId, task.latestTurn?.turnId ?? ref); }
    catch { failure = "Saved Codex usage is unavailable. Usage requires Node.js 22.18+ and readable Codex records."; }
    if (closed) return null;
    const release = await acquireWorkspaceLock(workspace);
    try {
      const store = await readUsageStore(workspace);
      const previous = store.tasks[task.id]?.threadId === task.threadId ? store.tasks[task.id] : null;
      if (previous?.generationTurnCount > task.turns.length) return previous;
      const provenance = { provider: "taskchef", version: TASKCHEF_VERSION, pricingMode: "standard" };
      let total = result?.total.samples ? projection(result.total, provenance, now, result.subagents + 1)
        : previous?.task ? { ...previous.task, partial: true, costPartial: true } : null;
      // A partial scan cannot erase usage already known from older rollouts.
      if (result?.total.partial && previous?.task && total.totalTokens < previous.task.totalTokens) {
        total = { ...previous.task, partial: true, costPartial: true };
      }
      if (result?.total.costPartial && previous?.task?.estimatedCostUsd != null
        && (total.estimatedCostUsd == null || total.estimatedCostUsd < previous.task.estimatedCostUsd)) {
        total = { ...total, estimatedCostUsd: previous.task.estimatedCostUsd, costStatus: "estimated", costPartial: true };
      }
      const priorTurn = previous?.turns[ref];
      let latest = result?.matchedTurn && result.latest.samples
        ? { status: "available", ...projection(result.latest, provenance, now, result.subagents + 1), updatedAt: now }
        : priorTurn?.status === "available" ? { ...priorTurn, partial: true, costPartial: true, updatedAt: now }
        : { status: "unavailable", reason: failure || (result?.matchedTurn ? "No saved usage for this native turn." : "This dispatcher turn has no matching native Codex turn ID."), updatedAt: now };
      if (latest.status === "available" && latest.partial && priorTurn?.status === "available" && latest.totalTokens < priorTurn.totalTokens) {
        latest = { ...priorTurn, partial: true, costPartial: true, updatedAt: now };
      }
      if (latest.status === "available" && latest.costPartial && priorTurn?.estimatedCostUsd != null
        && (latest.estimatedCostUsd == null || latest.estimatedCostUsd < priorTurn.estimatedCostUsd)) {
        latest = { ...latest, estimatedCostUsd: priorTurn.estimatedCostUsd, costStatus: "estimated", costPartial: true };
      }
      const record = {
        threadId: task.threadId, generationTurnRef: ref, generationTurnCount: task.turns.length,
        generationTerminal: !!task.latestTurn?.result, zeroBaselineTurnRef: null,
        status: total ? "available" : "unavailable", updatedAt: now, retryAfter: null,
        ...(total ? {} : { reason: failure || "No saved usage records were found." }),
        task: total, turns: { ...(previous?.turns ?? {}), [ref]: latest }, boundaries: {},
      };
      store.tasks[task.id] = record;
      await writeUsageStore(workspace, store);
      return record;
    } finally { await release(); }
  }
  function get(task) {
    if (closed) return Promise.resolve(null);
    if (!task.threadId || !task.latestTurn) return Promise.resolve({ status: "unavailable", reason: "No linked Codex turn.", task: null, turns: {} });
    if (task.latestTurn.provenance?.kind === "dashboard_manual") {
      return readUsageStore(workspace).then(store => ({ ...(store.tasks[task.id] ?? { status: "unavailable", task: null }), turns: { ...(store.tasks[task.id]?.turns ?? {}), [task.latestTurn.turnRef]: { status: "unavailable", reason: "Administrative action; no Codex usage boundary." } } }));
    }
    const key = `${task.id}:${task.latestTurn.turnRef}`;
    if (pending.has(key)) return pending.get(key);
    const promise = new Promise((resolve, reject) => { queue.push({ run: () => calculate(task), resolve, reject }); drain(); });
    pending.set(key, promise);
    promise.finally(() => pending.delete(key)).catch(() => {});
    return promise;
  }
  return {
    get, observe: get,
    // Historical tasks stay lazy; opening Details reads their saved logs.
    preload: async () => {},
    close() { closed = true; for (const job of queue.splice(0)) job.resolve(null); scanner.close(); },
  };
}
