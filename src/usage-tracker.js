import { realpath } from "node:fs/promises";
import path from "node:path";

import { acquireWorkspaceLock } from "./workspace.js";
import {
  readCcusageThreadUsage,
  readUsageStore,
  usageDelta,
  writeUsageStore,
} from "./usage.js";

const TERMINAL_STATUSES = new Set(["needs_input", "completed", "failed"]);
const MAX_TRACKED_TURNS = 250;

function hasTerminalLatestTurn(task) {
  return task.latestTurn !== null
    && task.latestTurn !== undefined
    && task.latestTurn.result !== null
    && TERMINAL_STATUSES.has(task.latestTurn.result.status);
}

function lifecycleGeneration(task) {
  return {
    turnCount: task.turns.length,
    terminal: hasTerminalLatestTurn(task),
  };
}

function generationIsOlder(task, existing) {
  if (!existing) return false;
  const incoming = lifecycleGeneration(task);
  if (incoming.turnCount !== existing.generationTurnCount) {
    return incoming.turnCount < existing.generationTurnCount;
  }
  return !incoming.terminal && existing.generationTerminal;
}

function publicReason(error) {
  const message = String(error?.message ?? "");
  if (/not installed/i.test(message)) return "ccusage is not installed.";
  if (/could not resolve/i.test(message)) return "No matching Codex usage session was found.";
  if (/timed out/i.test(message)) return "ccusage did not finish in time.";
  return "Codex usage is unavailable from ccusage.";
}

function calculatingTask(task, existing = null, now = new Date().toISOString()) {
  const latestTurnRef = task.latestTurn?.turnRef ?? null;
  const preserveAvailable = existing?.generationTurnRef === latestTurnRef
    && existing?.status === "available"
    && existing?.turns?.[latestTurnRef]?.status === "available";
  const recentTurns = task.turns.slice(-MAX_TRACKED_TURNS);
  const turns = Object.fromEntries(recentTurns.flatMap((turn) => (
    existing?.turns?.[turn.turnRef]
      ? [[turn.turnRef, existing.turns[turn.turnRef]]]
      : []
  )));
  const generation = lifecycleGeneration(task);
  for (const turn of recentTurns) {
    if (turn.result === null) {
      turns[turn.turnRef] = { status: "calculating", updatedAt: now };
    } else if (turn.result.status === "interrupted") {
      turns[turn.turnRef] = {
        status: "unavailable",
        reason: "The turn ended without a terminal usage boundary.",
        updatedAt: now,
      };
    } else if (turns[turn.turnRef]?.status === "calculating"
      && turn.turnRef !== task.latestTurn?.turnRef) {
      turns[turn.turnRef] = {
        status: "unavailable",
        reason: "A newer turn started before a stable usage boundary was recorded.",
        updatedAt: now,
      };
    } else if (!turns[turn.turnRef]) {
      turns[turn.turnRef] = {
        status: "unavailable",
        reason: "No reliable cumulative boundary was recorded for this historical turn.",
        updatedAt: now,
      };
    }
  }
  if (task.latestTurn?.result
    && TERMINAL_STATUSES.has(task.latestTurn.result.status)
    && !preserveAvailable) {
    turns[task.latestTurn.turnRef] = { status: "calculating", updatedAt: now };
  }
  return {
    threadId: task.threadId,
    generationTurnRef: latestTurnRef,
    generationTurnCount: generation.turnCount,
    generationTerminal: generation.terminal,
    zeroBaselineTurnRef: existing?.zeroBaselineTurnRef ?? (
      task.turns.length === 1 && task.latestTurn?.result === null
        ? task.latestTurn.turnRef
        : null
    ),
    status: preserveAvailable ? "available" : "calculating",
    updatedAt: preserveAvailable ? existing.updatedAt : now,
    retryAfter: null,
    task: existing?.task ?? null,
    turns,
    boundaries: existing?.boundaries ?? {},
  };
}

async function updateStore(workspace, taskId, transform) {
  const release = await acquireWorkspaceLock(workspace);
  try {
    const store = await readUsageStore(workspace);
    const next = await transform(store.tasks[taskId] ?? null);
    store.tasks[taskId] = next;
    await writeUsageStore(workspace, store);
    return next;
  } finally {
    await release();
  }
}

function snapshotFingerprint(snapshot) {
  return JSON.stringify([
    snapshot.inputTokens,
    snapshot.cachedInputTokens,
    snapshot.outputTokens,
    snapshot.reasoningOutputTokens,
    snapshot.totalTokens,
    snapshot.estimatedCostUsd,
    snapshot.sourceUpdatedAt,
  ]);
}

function snapshotSupersedes(current, incoming) {
  if (!current) return true;
  const currentSampledAt = Date.parse(current.sampledAt ?? 0);
  const incomingSampledAt = Date.parse(incoming.sampledAt ?? 0);
  if (!Number.isFinite(incomingSampledAt) || incomingSampledAt < currentSampledAt) return false;
  return [
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "totalTokens",
  ].every((field) => incoming[field] >= current[field]);
}

function candidateHasAdvanced(task, existing, snapshot) {
  const latestIndex = task.turns.findIndex((turn) => turn.turnRef === task.latestTurn?.turnRef);
  if (latestIndex <= 0) return true;
  const previousTurn = task.turns[latestIndex - 1];
  const previousBoundary = existing?.boundaries?.[previousTurn.turnRef];
  if (!previousBoundary) return true;
  const delta = usageDelta(snapshot, previousBoundary);
  return delta !== null && delta.totalTokens > 0;
}

function reconcileRecord(task, existing, snapshot, { boundaryReliable = true } = {}) {
  const now = snapshot.sampledAt;
  const boundaries = { ...(existing?.boundaries ?? {}) };
  const recentTurns = task.turns.slice(-MAX_TRACKED_TURNS);
  const turns = Object.fromEntries(recentTurns.flatMap((turn) => (
    existing?.turns?.[turn.turnRef]
      ? [[turn.turnRef, existing.turns[turn.turnRef]]]
      : []
  )));
  const terminalTurns = recentTurns.filter((turn) => (
    turn.result !== null && TERMINAL_STATUSES.has(turn.result.status)
  ));
  const generation = lifecycleGeneration(task);
  for (const turn of terminalTurns) {
    if (!turns[turn.turnRef]) {
      turns[turn.turnRef] = {
        status: "unavailable",
        reason: "No reliable cumulative boundary was recorded for this historical turn.",
        updatedAt: now,
      };
    }
  }

  const latest = terminalTurns.at(-1);
  if (latest && latest.turnRef === task.latestTurn?.turnRef && boundaryReliable) {
    const index = task.turns.findIndex((turn) => turn.turnRef === latest.turnRef);
    const previousTurn = index > 0 ? task.turns[index - 1] : null;
    const previousBoundary = previousTurn ? boundaries[previousTurn.turnRef] ?? null : null;
    const delta = previousTurn === null
      ? (existing?.zeroBaselineTurnRef === latest.turnRef ? usageDelta(snapshot, null) : null)
      : (previousBoundary !== null ? usageDelta(snapshot, previousBoundary) : null);
    const advanced = previousTurn === null || previousBoundary === null || delta?.totalTokens > 0;
    if (advanced) boundaries[latest.turnRef] = snapshot;
    turns[latest.turnRef] = delta === null || !advanced
      ? {
        status: "unavailable",
        reason: !advanced
          ? "Cumulative usage did not advance beyond the preceding turn."
          : (previousTurn === null
            ? "No live zero-token boundary was recorded for this historical turn."
            : "The preceding turn has no reliable cumulative boundary."),
        updatedAt: now,
      }
      : {
        status: "available",
        ...delta,
        provenance: snapshot.provenance,
        sampledAt: snapshot.sampledAt,
        sourceUpdatedAt: snapshot.sourceUpdatedAt,
        updatedAt: now,
      };
  } else if (latest && latest.turnRef === task.latestTurn?.turnRef) {
    turns[latest.turnRef] = {
      status: "unavailable",
      reason: "Usage did not stabilize before reconciliation finished.",
      updatedAt: now,
    };
  }

  return {
    threadId: task.threadId,
    generationTurnRef: task.latestTurn?.turnRef ?? null,
    generationTurnCount: generation.turnCount,
    generationTerminal: generation.terminal,
    zeroBaselineTurnRef: existing?.zeroBaselineTurnRef ?? null,
    status: "available",
    updatedAt: now,
    retryAfter: null,
    task: snapshot,
    turns,
    boundaries,
  };
}

export function createUsageTracker({
  workspace,
  readThreadUsage = readCcusageThreadUsage,
  retryDelaysMs = [2_000, 3_000, 4_000, 1_000],
  retryCooldownMs = 60_000,
  setTimer = setTimeout,
} = {}) {
  const jobs = new Map();
  const observationChains = new Map();
  let canonicalWorkspace = null;

  const root = async () => {
    canonicalWorkspace ??= await realpath(path.resolve(workspace));
    return canonicalWorkspace;
  };

  const markCalculating = async (task) => updateStore(await root(), task.id, (existing) => (
    generationIsOlder(task, existing) ? existing : calculatingTask(task, existing)
  ));

  const reconcile = async (task, {
    finalAttempt = false,
    isCurrent = () => true,
    job,
  } = {}) => {
    let snapshot;
    try {
      snapshot = await readThreadUsage(task.threadId);
    } catch (error) {
      if (!finalAttempt) throw error;
      if (!isCurrent()) return null;
      return updateStore(await root(), task.id, (existing) => {
        if (existing?.generationTurnRef !== task.latestTurn?.turnRef) return existing;
        if (existing?.status === "available"
          && existing?.turns?.[task.latestTurn?.turnRef]?.status === "available") return existing;
        const calculating = calculatingTask(task, existing);
        return {
          ...calculating,
          status: "unavailable",
          reason: publicReason(error),
          updatedAt: new Date().toISOString(),
          retryAfter: new Date(Date.now() + retryCooldownMs).toISOString(),
          turns: Object.fromEntries(Object.entries(calculating.turns).map(
            ([turnRef, usage]) => [turnRef, usage.status === "calculating"
              ? { status: "unavailable", reason: publicReason(error), updatedAt: new Date().toISOString() }
              : usage],
          )),
        };
      });
    }
    if (!isCurrent()) return null;
    const fingerprint = snapshotFingerprint(snapshot);
    const stable = job.previousFingerprint === fingerprint;
    job.previousFingerprint = fingerprint;
    if (!stable && !finalAttempt) return null;
    if (stable && !finalAttempt) {
      const store = await readUsageStore(await root());
      if (!candidateHasAdvanced(task, store.tasks[task.id], snapshot)) return null;
    }
    return updateStore(await root(), task.id, (existing) => {
      const latestTurnRef = task.latestTurn?.turnRef;
      if (existing?.generationTurnRef !== latestTurnRef) return existing;
      const supersedes = snapshotSupersedes(existing?.task, snapshot);
      if (existing?.boundaries?.[latestTurnRef]
        || existing?.turns?.[latestTurnRef]?.status === "available") {
        return supersedes
          ? { ...existing, status: "available", updatedAt: snapshot.sampledAt, task: snapshot }
          : existing;
      }
      if (!supersedes) return existing;
      return reconcileRecord(task, existing, snapshot, { boundaryReliable: stable });
    });
  };

  const schedule = (task, { immediate = false } = {}) => {
    if (!task.threadId || jobs.has(task.id)) return;
    const job = {
      cancelled: false,
      previousFingerprint: null,
      turnRef: task.latestTurn?.turnRef ?? null,
    };
    let attempt = 0;
    const run = async () => {
      if (job.cancelled || jobs.get(task.id) !== job) return;
      let complete = false;
      try {
        const result = await reconcile(task, {
          finalAttempt: attempt >= retryDelaysMs.length,
          isCurrent: () => !job.cancelled && jobs.get(task.id) === job,
          job,
        });
        complete = result !== null;
      } catch {
        // Retry bounded transient analyzer failures.
      }
      if (job.cancelled || jobs.get(task.id) !== job) return;
      if (complete || attempt >= retryDelaysMs.length) {
        if (jobs.get(task.id) === job) jobs.delete(task.id);
        return;
      }
      const delay = retryDelaysMs[attempt] ?? 0;
      attempt += 1;
      const timer = setTimer(run, delay);
      timer?.unref?.();
    };
    jobs.set(task.id, job);
    const timer = setTimer(run, immediate ? 0 : retryDelaysMs[attempt++]);
    timer?.unref?.();
  };

  return {
    observe(task) {
      const previous = observationChains.get(task.id) ?? Promise.resolve();
      const observation = previous.catch(() => {}).then(async () => {
        if (!task.threadId) return null;
        const active = jobs.get(task.id);
        const latestTurnRef = task.latestTurn?.turnRef ?? null;
        if (active && active.turnRef !== latestTurnRef) {
          active.cancelled = true;
          jobs.delete(task.id);
        }
        const usage = await markCalculating(task);
        if (hasTerminalLatestTurn(task)) schedule(task);
        return usage;
      });
      observationChains.set(task.id, observation);
      void observation.finally(() => {
        if (observationChains.get(task.id) === observation) observationChains.delete(task.id);
      }).catch(() => {});
      return observation;
    },
    async get(task) {
      const store = await readUsageStore(await root());
      const usage = store.tasks[task.id] ?? null;
      if (!task.threadId) return {
        status: "unavailable",
        reason: "This task has no linked Codex thread.",
        task: null,
        turns: {},
      };
      if (!task.latestTurn) return {
        status: "unavailable",
        reason: "No TaskChef turn has started yet.",
        task: null,
        turns: {},
      };
      const active = jobs.get(task.id);
      const latestTurnRef = task.latestTurn?.turnRef ?? null;
      if (active && active.turnRef !== latestTurnRef) {
        active.cancelled = true;
        jobs.delete(task.id);
      }
      if (!usage || usage.threadId !== task.threadId) {
        const calculating = calculatingTask(task);
        void markCalculating(task)
          .then(() => {
            if (hasTerminalLatestTurn(task)) schedule(task, { immediate: true });
          })
          .catch(() => {});
        return calculating;
      }
      if (usage.generationTurnRef !== latestTurnRef) {
        const calculating = calculatingTask(task, usage);
        void markCalculating(task)
          .then(() => {
            if (hasTerminalLatestTurn(task)) schedule(task, { immediate: true });
          })
          .catch(() => {});
        return calculating;
      }
      const latestTurnUsage = task.latestTurn
        ? usage.turns?.[task.latestTurn.turnRef]
        : null;
      if (!latestTurnUsage) {
        const calculating = calculatingTask(task, usage);
        void markCalculating(task)
          .then(() => {
            if (hasTerminalLatestTurn(task)) schedule(task, { immediate: true });
          })
          .catch(() => {});
        return calculating;
      }
      if (hasTerminalLatestTurn(task) && usage.status !== "available") {
        if (usage.status === "unavailable"
          && usage.retryAfter
          && Date.parse(usage.retryAfter) > Date.now()) return usage;
        const calculating = calculatingTask(task, usage);
        void markCalculating(task)
          .then(() => schedule(task, { immediate: true }))
          .catch(() => {});
        return calculating;
      }
      return usage;
    },
    schedule,
  };
}
