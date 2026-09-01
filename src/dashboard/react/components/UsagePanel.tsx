import { Box, Paper, Text } from "@mantine/core";
import type { Task } from "../types";
import {
  formatCompactTokens,
  formatEstimatedCost,
  formatFullTokens,
  taskReportedWorkView,
  usageView,
} from "../presentation";
import { ShimmerText } from "./ShimmerText";

export function UsagePanel({ task }: { task: Task }) {
  const usage = usageView(task);
  const reportedWork = taskReportedWorkView(task);
  const ready = usage.kind === "ready" ? usage : null;
  const cached = ready?.usage.cachedInputTokens ?? 0;
  const input = ready?.usage.inputTokens ?? 0;
  const cacheRatio = ready && input + cached > 0
    ? `${Math.round((cached / (input + cached)) * 100)}%`
    : "—";
  const stateValue = usage.kind === "pending"
    ? "Pending"
    : usage.kind === "calculating"
      ? "Calculating"
      : "Unavailable";
  const values: Array<{
    accessibleValue?: string;
    animated?: boolean;
    label: string;
    title?: string;
    value: string;
  }> = [
    {
      accessibleValue: ready
        ? `${formatFullTokens(ready.usage.totalTokens)} tokens`
        : usage.label,
      animated: usage.kind === "pending" || usage.kind === "calculating",
      label: ready?.knownSoFar ? "Tokens · known so far" : "Tokens",
      title: ready ? `${formatFullTokens(ready.usage.totalTokens)} tokens` : usage.label,
      value: ready ? formatCompactTokens(ready.usage.totalTokens) : stateValue,
    },
    {
      accessibleValue: ready
        ? ready.usage.estimatedCostUsd == null
          ? "Estimated cost unavailable"
          : `Estimated cost ${formatEstimatedCost(ready.usage.estimatedCostUsd)}`
        : `Estimated cost ${stateValue.toLowerCase()}${
          usage.kind === "unavailable" ? `: ${usage.label}` : ""
        }`,
      animated: usage.kind === "pending" || usage.kind === "calculating",
      label: "Estimated cost",
      title: ready?.usage.estimatedCostUsd == null
        ? usage.label
        : `Unrounded estimate: $${ready.usage.estimatedCostUsd}`,
      value: ready ? formatEstimatedCost(ready.usage.estimatedCostUsd) : stateValue,
    },
    {
      accessibleValue: reportedWork.accessibleLabel,
      label: "Total reported work",
      title: reportedWork.title,
      value: reportedWork.value,
    },
    ...(ready ? [
      { label: "Model", value: Object.keys(ready.usage.models ?? {}).join(", ") || "—" },
      { label: "Cache ratio", value: cacheRatio },
    ] : []),
  ];
  return (
    <Box aria-live="polite">
      <Box className="taskchef-metrics">
        {values.map(({ accessibleValue, animated, label, title, value }) => (
          <Paper className="taskchef-metric" key={label} p="sm" radius="md" withBorder>
            <Text c="dimmed" size="xs">{label}</Text>
            <Text
              aria-label={accessibleValue}
              className="taskchef-metric-value"
              fw={650}
              size="sm"
              title={title}
            >
              {animated ? <ShimmerText>{value}</ShimmerText> : value}
            </Text>
          </Paper>
        ))}
      </Box>
      {usage.kind === "unavailable" && (
        <Text c="dimmed" mt="xs" size="xs">{usage.label}</Text>
      )}
    </Box>
  );
}
