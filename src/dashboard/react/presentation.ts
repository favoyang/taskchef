import type { Task, TaskTurn, UsageNumbers, UsageProjection } from "./types";
import {
  durationBetween,
  reportedWorkSummary,
  terminalTurnDuration,
} from "../../reported-work.js";

export { durationBetween };

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const NOT_AVAILABLE = "n/a";

export function formatReportedDuration(milliseconds: number) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
  if (milliseconds > 0 && milliseconds < SECOND_MS) return "<1s";
  const seconds = Math.floor(milliseconds / SECOND_MS);
  if (milliseconds < MINUTE_MS) return `${seconds}s`;
  if (milliseconds < HOUR_MS) {
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }
  const minutes = Math.floor(milliseconds / MINUTE_MS);
  if (milliseconds < DAY_MS) {
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }
  const hours = Math.floor(milliseconds / HOUR_MS);
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export type ReportedWorkView = {
  accessibleLabel: string;
  kind: "available" | "not-reported" | "unavailable";
  title: string;
  value: string;
};

export function taskReportedWorkView(task: Task): ReportedWorkView {
  const summary = task.turns === undefined
    ? task.reportedWork
    : reportedWorkSummary(task.turns ?? []);
  if (summary === undefined) {
    return {
      accessibleLabel: "Reported work unavailable because terminal turn history is not available.",
      kind: "unavailable",
      title: "Reported wall-clock elapsed time requires the terminal turn history from the task detail projection.",
      value: NOT_AVAILABLE,
    };
  }
  if (summary.terminalTurns === 0) {
    return {
      accessibleLabel: "Reported work not yet reported. Unfinished turns are excluded.",
      kind: "not-reported",
      title: "Reported wall-clock elapsed time is added only after a turn reaches a terminal state.",
      value: NOT_AVAILABLE,
    };
  }
  if (summary.validTurns === 0) {
    return {
      accessibleLabel: "Reported work unavailable because completed turn timestamps are missing or invalid.",
      kind: "unavailable",
      title: "Reported wall-clock elapsed time is unavailable because no terminal turn has a valid start and end timestamp.",
      value: NOT_AVAILABLE,
    };
  }
  const value = summary.totalMilliseconds === null
    ? null
    : formatReportedDuration(summary.totalMilliseconds);
  if (value === null) {
    return {
      accessibleLabel: "Reported work unavailable because the duration total is outside the supported range.",
      kind: "unavailable",
      title: "Reported wall-clock elapsed time is unavailable because the duration total is outside the supported range.",
      value: NOT_AVAILABLE,
    };
  }
  const excluded = summary.terminalTurns - summary.validTurns;
  const exclusion = excluded > 0
    ? ` ${excluded} terminal ${excluded === 1 ? "turn was" : "turns were"} unavailable and excluded.`
    : "";
  return {
    accessibleLabel: `Reported work ${value}. This is reported wall-clock elapsed time.${exclusion}`,
    kind: "available",
    title: `Sum of valid terminal-turn wall-clock elapsed times; unfinished turns and idle gaps are excluded.${exclusion}`,
    value,
  };
}

export function turnReportedWorkView(turn: TaskTurn, now = Date.now()) {
  const active = turn.result === null;
  const duration = active
    ? durationBetween(turn.startedAt, new Date(now).toISOString())
    : terminalTurnDuration(turn);
  const label = active ? "Elapsed so far" : "Elapsed";
  const value = duration === null ? NOT_AVAILABLE : formatReportedDuration(duration) ?? NOT_AVAILABLE;
  return {
    accessibleLabel: `${label} ${duration === null ? "unavailable" : value}. ${active ? "Current" : "Completed"} turn reported wall-clock elapsed time.`,
    kind: duration === null ? "unavailable" as const : "available" as const,
    label,
    title: duration === null
      ? "Reported wall-clock elapsed time is unavailable because the turn timestamps are missing, invalid, or reversed."
      : `Reported wall-clock elapsed time from startedAt ${active ? "to the current time" : "to result.updatedAt"}.`,
    value,
  };
}

export function formatCompactTokens(value: number, locales?: Intl.LocalesArgument) {
  return new Intl.NumberFormat(locales, {
    maximumFractionDigits: 2,
    notation: "compact",
  }).format(value);
}

export function formatFullTokens(value: number, locales?: Intl.LocalesArgument) {
  return new Intl.NumberFormat(locales, { maximumFractionDigits: 2 }).format(value);
}

export function formatEstimatedCost(value: number | null | undefined, locales?: Intl.LocalesArgument) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(locales, {
    currency: "USD",
    currencyDisplay: "narrowSymbol",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(value);
}

export type UsageView =
  | { kind: "pending"; label: "Token usage pending" }
  | { kind: "calculating"; label: "Calculating token usage" }
  | { kind: "ready"; knownSoFar: boolean; label: string; usage: UsageNumbers }
  | { kind: "unavailable"; label: string };

export function usageView(task: Task): UsageView {
  const usage: UsageProjection | null | undefined = task.usage;
  const currentTurnRef = task.turnRef ?? task.latestTurn?.turnRef ?? null;
  const priorGeneration = usage?.generationTurnRef != null
    && currentTurnRef != null
    && usage.generationTurnRef !== currentTurnRef;
  if (task.status === "working") {
    if (usage?.task) return readyUsageView(usage.task, true);
    return { kind: "pending", label: "Token usage pending" };
  }
  if (usage?.status === "calculating" || priorGeneration) {
    return { kind: "calculating", label: "Calculating token usage" };
  }
  if (usage?.status === "available" && usage.task) {
    return readyUsageView(usage.task, false);
  }
  if (!usage && task.threadId && ["completed", "failed", "needs_input"].includes(task.status ?? "")) {
    return { kind: "calculating", label: "Calculating token usage" };
  }
  return { kind: "unavailable", label: usage?.reason ?? "Token usage unavailable" };
}

function readyUsageView(usage: UsageNumbers, knownSoFar: boolean): UsageView {
  const tokens = formatCompactTokens(usage.totalTokens);
  const cost = usage.estimatedCostUsd == null
    ? "Estimated cost n/a"
    : `Estimated cost ${formatEstimatedCost(usage.estimatedCostUsd)}`;
  return {
    kind: "ready",
    knownSoFar,
    label: `${tokens} tokens · ${cost}${knownSoFar ? " · known so far" : ""}`,
    usage,
  };
}

export function turnUsageView(task: Task, turn: NonNullable<Task["turns"]>[number]) {
  if (turn.result === null) return { kind: "pending" as const, label: "Turn usage pending" };
  const identity = turn.turnRef ?? turn.turnId;
  const usage = identity ? task.usage?.turns?.[identity] : null;
  if (usage?.status === "calculating") {
    return { kind: "calculating" as const, label: "Calculating turn usage" };
  }
  if (usage?.status === "available" && typeof usage.totalTokens === "number") {
    const tokens = formatFullTokens(usage.totalTokens);
    const cost = usage.estimatedCostUsd == null
      ? "Estimated cost n/a"
      : `Estimated cost ${formatEstimatedCost(usage.estimatedCostUsd)}`;
    return { kind: "ready" as const, label: `${tokens} tokens · ${cost}` };
  }
  return {
    kind: "unavailable" as const,
    label: usage?.reason ?? "Turn usage unavailable",
  };
}

export function turnUsageMetricsView(task: Task, turn: NonNullable<Task["turns"]>[number]) {
  const view = turnUsageView(task, turn);
  if (view.kind === "ready") {
    const identity = turn.turnRef ?? turn.turnId;
    const usage = identity ? task.usage?.turns?.[identity] : null;
    const tokens = typeof usage?.totalTokens === "number" ? formatFullTokens(usage.totalTokens) : NOT_AVAILABLE;
    const cost = usage?.estimatedCostUsd == null
      ? NOT_AVAILABLE
      : formatEstimatedCost(usage.estimatedCostUsd);
    return {
      animated: false,
      cost: {
        accessibleLabel: `Estimated cost ${usage?.estimatedCostUsd == null ? "unavailable" : cost.toLowerCase()}`,
        value: cost,
      },
      kind: view.kind,
      note: null,
      title: view.label,
      tokens: { accessibleLabel: `${tokens} tokens`, value: tokens },
    };
  }
  const value = view.kind === "pending"
    ? "Pending"
    : view.kind === "calculating"
      ? "Calculating"
      : NOT_AVAILABLE;
  const accessibleValue = view.kind === "unavailable" ? "unavailable" : value.toLowerCase();
  return {
    animated: view.kind === "pending" || view.kind === "calculating",
    cost: {
      accessibleLabel: `Estimated cost ${accessibleValue}${view.kind === "unavailable" ? `: ${view.label}` : ""}`,
      value,
    },
    kind: view.kind,
    note: view.kind === "unavailable" && view.label !== "Turn usage unavailable" ? view.label : null,
    title: view.label,
    tokens: {
      accessibleLabel: `Tokens ${accessibleValue}${view.kind === "unavailable" ? `: ${view.label}` : ""}`,
      value,
    },
  };
}

export function usageStillCalculating(task: Task) {
  return task.status !== "working"
    && (task.usage?.status === "calculating"
      || Object.values(task.usage?.turns ?? {}).some((turn) => turn.status === "calculating"));
}

export type ListUsageMetric = {
  accessibleLabel: string;
  title: string;
  value: string;
};

export type ListUsageMetricsView = {
  animated: boolean;
  cost: ListUsageMetric;
  kind: "pending" | "calculating" | "ready" | "unavailable";
  tokens: ListUsageMetric;
};

export function listUsageMetricsView(task: Task): ListUsageMetricsView {
  const view = usageView(task);
  if (view.kind === "pending" || view.kind === "calculating") {
    const value = view.kind === "pending" ? "Pending" : "Calculating";
    return {
      animated: true,
      cost: {
        accessibleLabel: `Estimated cost ${value.toLowerCase()}`,
        title: view.label,
        value,
      },
      kind: view.kind,
      tokens: {
        accessibleLabel: `Tokens ${value.toLowerCase()}`,
        title: view.label,
        value,
      },
    };
  }
  if (view.kind === "unavailable") {
    const reason = view.label === "Token usage unavailable" ? "" : `: ${view.label}`;
    return {
      animated: false,
      cost: {
        accessibleLabel: `Estimated cost unavailable${reason}`,
        title: view.label,
        value: "est. n/a",
      },
      kind: "unavailable",
      tokens: {
        accessibleLabel: `Token usage unavailable${reason}`,
        title: view.label,
        value: `${NOT_AVAILABLE} tokens`,
      },
    };
  }
  const compactTokens = formatCompactTokens(view.usage.totalTokens);
  const fullTokens = formatFullTokens(view.usage.totalTokens);
  const hasCost = typeof view.usage.estimatedCostUsd === "number"
    && Number.isFinite(view.usage.estimatedCostUsd);
  const formattedCost = hasCost ? formatEstimatedCost(view.usage.estimatedCostUsd) : null;
  const qualifier = view.knownSoFar ? " · Updating…" : "";
  const accessibleQualifier = view.knownSoFar ? "; updating" : "";
  const freshness = view.usage.sourceUpdatedAt ?? view.usage.sampledAt ?? task.usage?.updatedAt ?? null;
  const freshnessLabel = freshness && !Number.isNaN(Date.parse(freshness))
    ? ` Cached usage updated ${new Date(freshness).toLocaleString()}.`
    : "";
  return {
    animated: false,
    cost: {
      accessibleLabel: `Estimated cost ${formattedCost ?? "unavailable"}${accessibleQualifier}.${freshnessLabel}`,
      title: `${formattedCost === null
        ? "Estimated cost unavailable"
        : `Unrounded estimate: $${view.usage.estimatedCostUsd}`}${qualifier}.${freshnessLabel}`,
      value: `${formattedCost === null ? "est. n/a" : `est. ${formattedCost}`}${qualifier}`,
    },
    kind: "ready",
    tokens: {
      accessibleLabel: `${fullTokens} tokens${accessibleQualifier}.${freshnessLabel}`,
      title: `${fullTokens} tokens${qualifier}.${freshnessLabel}`,
      value: `${compactTokens} tokens${qualifier}`,
    },
  };
}

export function statusColor(status: Task["status"] | "interrupted") {
  if (status === "completed") return "teal";
  if (status === "needs_input") return "yellow";
  if (status === "failed") return "red";
  if (status === "working") return "blue";
  return "gray";
}

export function statusLabel(status: Task["status"] | "interrupted") {
  return status === null ? "Unresolved" : status.replaceAll("_", " ");
}
