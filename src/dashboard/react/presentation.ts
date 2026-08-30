import type { Task, UsageNumbers, UsageProjection } from "./types";

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
  const tokens = new Intl.NumberFormat().format(usage.totalTokens);
  const cost = usage.estimatedCostUsd == null
    ? "Estimated cost unavailable"
    : `Estimated cost $${usage.estimatedCostUsd.toFixed(4)}`;
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
    const tokens = new Intl.NumberFormat().format(usage.totalTokens);
    const cost = usage.estimatedCostUsd == null
      ? "Estimated cost unavailable"
      : `Estimated cost $${usage.estimatedCostUsd.toFixed(4)}`;
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
