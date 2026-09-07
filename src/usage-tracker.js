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
const ADMINISTRATIVE_USAGE_REASON = "Administrative action; no Codex usage boundary.";

function isAdministrativeTurn(turn) {
  return turn?.provenance?.kind === "dashboard_manual";
}

function isInterruptedTurn(turn) {
  return turn?.result?.status === "interrupted";
}

function hasTerminalLatestTurn(task) {
  return task.latestTurn !== null
    && task.latestTurn !== undefined
    && !isAdministrativeTurn(task.latestTurn)
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
    if (isAdministrativeTurn(turn)) {
      turns[turn.turnRef] = {
        status: "unavailable",
        reason: ADMINISTRATIVE_USAGE_REASON,
        updatedAt: now,
      };
    } else if (turn.result === null) {
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
    && hasTerminalLatestTurn(task)
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

function administrativeTask(task, existing = null, now = new Date().toISOString()) {
  const usage = calculatingTask(task, existing, now);
  const hasTaskProjection = existing?.task !== null && existing?.task !== undefined;
  return {
    ...usage,
    status: hasTaskProjection ? "available" : "unavailable",
    ...(hasTaskProjection ? {} : { reason: ADMINISTRATIVE_USAGE_REASON }),
    updatedAt: now,
    retryAfter: null,
    task: existing?.task ?? null,
  };
}

function interruptedTask(task, existing = null, now = new Date().toISOString()) {
  const usage = calculatingTask(task, existing, now);
  const hasTaskProjection = existing?.task !== null && existing?.task !== undefined;
  return {
    ...usage,
    status: hasTaskProjection ? "available" : "unavailable",
    ...(hasTaskProjection ? {} : { reason: "The turn ended without a terminal usage boundary." }),
    updatedAt: now,
    retryAfter: null,
    task: existing?.task ?? null,
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

function snapshotCorrects(current, incoming) {
  if (!current) return false;
  const currentSampledAt = Date.parse(current.sampledAt ?? 0);
  const incomingSampledAt = Date.parse(incoming.sampledAt ?? 0);
  return Number.isFinite(incomingSampledAt)
    && incomingSampledAt >= currentSampledAt
    && [
      "inputTokens",
      "cachedInputTokens",
      "outputTokens",
      "reasoningOutputTokens",
      "totalTokens",
    ].some((field) => incoming[field] < current[field]);
}

function correctedRecord(task, snapshot) {
  const now = snapshot.sampledAt;
  const version = snapshot.provenance.version ? ` ${snapshot.provenance.version}` : "";
  const reason = `ccusage${version} corrected an older cumulative total; reliable per-turn usage is unavailable.`;
  const turns = Object.fromEntries(task.turns.slice(-MAX_TRACKED_TURNS).map((turn) => [
    turn.turnRef,
    isAdministrativeTurn(turn)
      ? { status: "unavailable", reason: ADMINISTRATIVE_USAGE_REASON, updatedAt: now }
      : { status: "unavailable", reason, updatedAt: now },
  ]));
  const generation = lifecycleGeneration(task);
  return {
    threadId: task.threadId,
    generationTurnRef: task.latestTurn?.turnRef ?? null,
    generationTurnCount: generation.turnCount,
    generationTerminal: generation.terminal,
    zeroBaselineTurnRef: null,
    status: "available",
    updatedAt: now,
    retryAfter: null,
    task: snapshot,
    turns,
    boundaries: { [task.latestTurn.turnRef]: snapshot },
  };
}

function candidateHasAdvanced(task, existing, snapshot) {
  const latestIndex = task.turns.findIndex((turn) => turn.turnRef === task.latestTurn?.turnRef);
  if (latestIndex <= 0) return true;
  const previousTurn = task.turns
    .slice(0, latestIndex)
    .reverse()
    .find((turn) => !isAdministrativeTurn(turn));
  const previousBoundary = previousTurn
    ? existing.boundaries[previousTurn.turnRef] ?? null
    : null;
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
    !isAdministrativeTurn(turn)
    && turn.result !== null
    && TERMINAL_STATUSES.has(turn.result.status)
  ));
  const generation = lifecycleGeneration(task);
  for (const turn of recentTurns.filter(isAdministrativeTurn)) {
    turns[turn.turnRef] = {
      status: "unavailable",
      reason: ADMINISTRATIVE_USAGE_REASON,
      updatedAt: now,
    };
  }
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
    const previousTurn = index > 0
      ? task.turns.slice(0, index).reverse().find((turn) => !isAdministrativeTurn(turn)) ?? null
      : null;
    const previousBoundary = previousTurn ? boundaries[previousTurn.turnRef] ?? null : null;
    const delta = index === 0
      ? (existing?.zeroBaselineTurnRef === latest.turnRef ? usageDelta(snapshot, null) : null)
      : (previousBoundary !== null ? usageDelta(snapshot, previousBoundary) : null);
    const advanced = index === 0 || (delta !== null && delta.totalTokens > 0);
    if (advanced) boundaries[latest.turnRef] = snapshot;
    turns[latest.turnRef] = delta === null || !advanced
      ? {
        status: "unavailable",
        reason: delta === null
          ? (previousTurn === null
            ? "No live zero-token boundary was recorded for this historical turn."
            : "The preceding turn has no reliable cumulative boundary.")
          : "Cumulative usage did not advance beyond the preceding turn.",
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
  maxConcurrentJobs = 2,
  readThreadUsage = readCcusageThreadUsage,
  retryDelaysMs = [2_000, 3_000, 4_000, 1_000],
  retryCooldownMs = 60_000,
  setTimer = setTimeout,
} = {}) {
  if (!Number.isSafeInteger(maxConcurrentJobs) || maxConcurrentJobs < 1 || maxConcurrentJobs > 8) {
    throw new Error("usage tracker concurrency must be an integer from 1 to 8");
  }
  const jobs = new Map();
  const observationChains = new Map();
  const readyJobs = [];
  let activeJobs = 0;
  let canonicalWorkspace = null;
  let closed = false;
  let preloadChain = Promise.resolve();

  const root = async () => {
    canonicalWorkspace ??= await realpath(path.resolve(workspace));
    return canonicalWorkspace;
  };

  const markCalculating = async (task) => updateStore(await root(), task.id, (existing) => (
    generationIsOlder(task, existing) ? existing : calculatingTask(task, existing)
  ));
  const markAdministrative = async (task) => updateStore(await root(), task.id, (existing) => (
    generationIsOlder(task, existing) ? existing : administrativeTask(task, existing)
  ));
  const markInterrupted = async (task) => updateStore(await root(), task.id, (existing) => (
    generationIsOlder(task, existing) ? existing : interruptedTask(task, existing)
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
      if (stable && snapshotCorrects(existing?.task, snapshot)) {
        return correctedRecord(task, snapshot);
      }
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

  const drainReadyJobs = () => {
    while (!closed && activeJobs < maxConcurrentJobs && readyJobs.length > 0) {
      const job = readyJobs.shift();
      job.queued = false;
      if (job.cancelled || jobs.get(job.task.id) !== job) {
        for (const resolve of job.waiters.splice(0)) resolve();
        continue;
      }
      const waiters = job.waiters.splice(0);
      activeJobs += 1;
      void job.run().finally(() => {
        activeJobs -= 1;
        for (const resolve of waiters) resolve();
        drainReadyJobs();
      });
    }
  };

  const queueJob = (job) => {
    if (closed || job.cancelled || jobs.get(job.task.id) !== job) return Promise.resolve();
    return new Promise((resolve) => {
      job.waiters.push(resolve);
      if (!job.queued) {
        job.queued = true;
        readyJobs.push(job);
        drainReadyJobs();
      }
    });
  };

  const schedule = (task, { immediate = false } = {}) => {
    if (closed || !task.threadId || jobs.has(task.id)) return;
    const job = {
      cancelled: false,
      previousFingerprint: null,
      queued: false,
      run: null,
      task,
      turnRef: task.latestTurn?.turnRef ?? null,
      waiters: [],
    };
    let attempt = 0;
    job.run = async () => {
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
      const timer = setTimer(() => queueJob(job), delay);
      timer?.unref?.();
    };
    jobs.set(task.id, job);
    const timer = setTimer(() => queueJob(job), immediate ? 0 : retryDelaysMs[attempt++]);
    timer?.unref?.();
  };

  const observe = (task) => {
    if (closed) return Promise.resolve(null);
    const previous = observationChains.get(task.id) ?? Promise.resolve();
    const observation = previous.catch(() => {}).then(async () => {
      if (closed || !task.threadId) return null;
      const active = jobs.get(task.id);
      const latestTurnRef = task.latestTurn?.turnRef ?? null;
      if (active && active.turnRef !== latestTurnRef) {
        active.cancelled = true;
        jobs.delete(task.id);
      }
      const usage = isAdministrativeTurn(task.latestTurn)
        ? await markAdministrative(task)
        : isInterruptedTurn(task.latestTurn)
          ? await markInterrupted(task)
          : await markCalculating(task);
      if (hasTerminalLatestTurn(task)) schedule(task);
      return usage;
    });
    observationChains.set(task.id, observation);
    void observation.finally(() => {
      if (observationChains.get(task.id) === observation) observationChains.delete(task.id);
    }).catch(() => {});
    return observation;
  };

  const needsPreload = (task, usage, now = Date.now()) => {
    if (!task.threadId || !task.latestTurn) return false;
    const latestTurnRef = task.latestTurn.turnRef ?? null;
    if (isAdministrativeTurn(task.latestTurn)) {
      return !usage
        || usage.threadId !== task.threadId
        || usage.generationTurnRef !== latestTurnRef;
    }
    if (isInterruptedTurn(task.latestTurn)) {
      const latestUsage = usage?.turns?.[latestTurnRef];
      const expectedStatus = usage?.task ? "available" : "unavailable";
      return !usage
        || usage.threadId !== task.threadId
        || usage.generationTurnRef !== latestTurnRef
        || usage.status !== expectedStatus
        || latestUsage?.status !== "unavailable";
    }
    if (!usage || usage.threadId !== task.threadId || usage.generationTurnRef !== latestTurnRef) {
      return true;
    }
    if (!hasTerminalLatestTurn(task)) return false;
    if (usage.status === "available") return false;
    if (usage.status === "calculating") return true;
    if (usage.status === "unavailable") {
      return !usage.retryAfter || Date.parse(usage.retryAfter) <= now;
    }
    return false;
  };

  return {
    close() {
      closed = true;
      readyJobs.length = 0;
      for (const job of jobs.values()) {
        job.cancelled = true;
        for (const resolve of job.waiters.splice(0)) resolve();
      }
      jobs.clear();
    },
    observe,
    preload(tasks) {
      preloadChain = preloadChain.catch(() => {}).then(async () => {
        if (closed) return;
        const store = await readUsageStore(await root());
        for (const task of tasks) {
          if (needsPreload(task, store.tasks[task.id] ?? null)) await observe(task);
        }
      });
      return preloadChain;
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
      if (isAdministrativeTurn(task.latestTurn)) {
        const latestUsage = usage?.turns?.[task.latestTurn.turnRef];
        if (usage?.generationTurnRef === task.latestTurn.turnRef
          && latestUsage?.status === "unavailable"
          && latestUsage.reason === ADMINISTRATIVE_USAGE_REASON) return usage;
        const administrative = administrativeTask(task, usage);
        void markAdministrative(task).catch(() => {});
        return administrative;
      }
      if (isInterruptedTurn(task.latestTurn)) {
        const latestUsage = usage?.turns?.[task.latestTurn.turnRef];
        const expectedStatus = usage?.task ? "available" : "unavailable";
        if (usage?.generationTurnRef === task.latestTurn.turnRef
          && usage.status === expectedStatus
          && latestUsage?.status === "unavailable") return usage;
        const interrupted = interruptedTask(task, usage);
        void markInterrupted(task).catch(() => {});
        return interrupted;
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
