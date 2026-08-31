import type { Task, UsageNumbers, UsageProjection } from "./types";

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
  const qualifier = view.knownSoFar ? " · known so far" : "";
  const freshness = view.usage.sourceUpdatedAt ?? view.usage.sampledAt ?? task.usage?.updatedAt ?? null;
  const freshnessLabel = freshness && !Number.isNaN(Date.parse(freshness))
    ? ` Cached usage updated ${new Date(freshness).toLocaleString()}.`
    : "";
  return {
    accessibleLabel: `${fullTokens} tokens; ${view.usage.estimatedCostUsd == null
      ? "estimated cost unavailable"
      : `estimated cost ${formatEstimatedCost(view.usage.estimatedCostUsd)}`}${view.knownSoFar ? "; known so far" : ""}.${freshnessLabel}`,
    kind: "ready",
    label: `${compactTokens} tokens · ${cost}${qualifier}`,
    title: `${fullTokens} tokens · ${view.usage.estimatedCostUsd == null
      ? "estimated cost unavailable"
      : `unrounded estimate $${view.usage.estimatedCostUsd}`}${view.knownSoFar ? " · known so far" : ""}.${freshnessLabel}`,
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
