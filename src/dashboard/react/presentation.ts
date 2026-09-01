import type { Task, TaskTurn, UsageNumbers, UsageProjection } from "./types";

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function durationBetween(startedAt: unknown, endedAt: unknown) {
  const start = parseLifecycleTimestamp(startedAt);
  const end = parseLifecycleTimestamp(endedAt);
  if (start === null || end === null) return null;
  const duration = end - start;
  return duration >= 0 ? duration : null;
}

function parseLifecycleTimestamp(value: unknown) {
  if (typeof value !== "string") return null;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const zoneHour = zone === "Z" ? 0 : Number(zone.slice(1, 3));
  const zoneMinute = zone === "Z" ? 0 : Number(zone.slice(4, 6));
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1
    || month > 12
    || day < 1
    || day > daysInMonth[month - 1]
    || hour > 23
    || minute > 59
    || second > 59
    || zoneHour > 23
    || zoneMinute > 59
  ) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

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
  if (task.turns === undefined) {
    return {
      accessibleLabel: "Total reported work unavailable because terminal turn history is not available.",
      kind: "unavailable",
      title: "Reported wall-clock elapsed time requires the terminal turn history from the task detail projection.",
      value: "Unavailable",
    };
  }
  const terminalTurns = (task.turns ?? []).filter((turn) => turn.result !== null);
  if (terminalTurns.length === 0) {
    return {
      accessibleLabel: "Total reported work not yet reported. Unfinished turns are excluded.",
      kind: "not-reported",
      title: "Reported wall-clock elapsed time is added only after a turn reaches a terminal state.",
      value: "Not yet reported",
    };
  }
  const durations = terminalTurns.map((turn) => durationBetween(turn.startedAt, turn.result?.updatedAt));
  const validDurations = durations.filter((duration): duration is number => duration !== null);
  if (validDurations.length === 0) {
    return {
      accessibleLabel: "Total reported work unavailable because completed turn timestamps are missing or invalid.",
      kind: "unavailable",
      title: "Reported wall-clock elapsed time is unavailable because no terminal turn has a valid start and end timestamp.",
      value: "Unavailable",
    };
  }
  const total = validDurations.reduce((sum, duration) => sum + duration, 0);
  const value = Number.isSafeInteger(total) ? formatReportedDuration(total) : null;
  if (value === null) {
    return {
      accessibleLabel: "Total reported work unavailable because the duration total is outside the supported range.",
      kind: "unavailable",
      title: "Reported wall-clock elapsed time is unavailable because the duration total is outside the supported range.",
      value: "Unavailable",
    };
  }
  const excluded = terminalTurns.length - validDurations.length;
  const exclusion = excluded > 0
    ? ` ${excluded} terminal ${excluded === 1 ? "turn was" : "turns were"} unavailable and excluded.`
    : "";
  return {
    accessibleLabel: `Total reported work ${value}. This is reported wall-clock elapsed time.${exclusion}`,
    kind: "available",
    title: `Sum of valid terminal-turn wall-clock elapsed times; unfinished turns and idle gaps are excluded.${exclusion}`,
    value,
  };
}

export function turnReportedWorkView(turn: TaskTurn, now = Date.now()) {
  const active = turn.result === null;
  const duration = durationBetween(turn.startedAt, active ? new Date(now).toISOString() : turn.result?.updatedAt);
  const label = active ? "Elapsed so far" : "Elapsed";
  const value = duration === null ? "Unavailable" : formatReportedDuration(duration) ?? "Unavailable";
  return {
    accessibleLabel: `${label} ${value}. ${active ? "Current" : "Completed"} turn reported wall-clock elapsed time.`,
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
    ? "Estimated cost unavailable"
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
      ? "Estimated cost unavailable"
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
    const tokens = typeof usage?.totalTokens === "number" ? formatFullTokens(usage.totalTokens) : "Unavailable";
    const cost = usage?.estimatedCostUsd == null
      ? "Unavailable"
      : formatEstimatedCost(usage.estimatedCostUsd);
    return {
      animated: false,
      cost: { accessibleLabel: `Estimated cost ${cost.toLowerCase()}`, value: cost },
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
      : "Unavailable";
  return {
    animated: view.kind === "pending" || view.kind === "calculating",
    cost: {
      accessibleLabel: `Estimated cost ${value.toLowerCase()}${view.kind === "unavailable" ? `: ${view.label}` : ""}`,
      value,
    },
    kind: view.kind,
    note: view.kind === "unavailable" ? view.label : null,
    title: view.label,
    tokens: {
      accessibleLabel: `Tokens ${value.toLowerCase()}${view.kind === "unavailable" ? `: ${view.label}` : ""}`,
      value,
    },
  };
}

export function usageStillCalculating(task: Task) {
  return task.status !== "working"
    && (task.usage?.status === "calculating"
      || Object.values(task.usage?.turns ?? {}).some((turn) => turn.status === "calculating"));
}

export type ListUsageView = {
  accessibleLabel: string;
  kind: "pending" | "calculating" | "ready" | "unavailable";
  label: string;
  title: string;
};

export function listUsageView(task: Task): ListUsageView {
  const view = usageView(task);
  if (view.kind === "pending" || view.kind === "calculating") {
    return {
      accessibleLabel: view.label,
      kind: view.kind,
      label: view.label,
      title: view.label,
    };
  }
  if (view.kind === "unavailable") {
    return {
      accessibleLabel: `Token usage unavailable${view.label === "Token usage unavailable" ? "" : `: ${view.label}`}`,
      kind: "unavailable",
      label: "Token usage unavailable",
      title: view.label,
    };
  }
  const compactTokens = formatCompactTokens(view.usage.totalTokens);
  const fullTokens = formatFullTokens(view.usage.totalTokens);
  const cost = view.usage.estimatedCostUsd == null
    ? "cost unavailable"
    : `est. ${formatEstimatedCost(view.usage.estimatedCostUsd)}`;
  const qualifier = view.knownSoFar ? " · Updating…" : "";
  const accessibleQualifier = view.knownSoFar ? "; updating" : "";
  const freshness = view.usage.sourceUpdatedAt ?? view.usage.sampledAt ?? task.usage?.updatedAt ?? null;
  const freshnessLabel = freshness && !Number.isNaN(Date.parse(freshness))
    ? ` Cached usage updated ${new Date(freshness).toLocaleString()}.`
    : "";
  return {
    accessibleLabel: `${fullTokens} tokens; ${view.usage.estimatedCostUsd == null
      ? "estimated cost unavailable"
      : `estimated cost ${formatEstimatedCost(view.usage.estimatedCostUsd)}`}${accessibleQualifier}.${freshnessLabel}`,
    kind: "ready",
    label: `${compactTokens} tokens · ${cost}${qualifier}`,
    title: `${fullTokens} tokens · ${view.usage.estimatedCostUsd == null
      ? "estimated cost unavailable"
      : `unrounded estimate $${view.usage.estimatedCostUsd}`}${qualifier}.${freshnessLabel}`,
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
