import { Box, Group, Paper, Text } from "@mantine/core";
import { IconCoins } from "@tabler/icons-react";
import type { Task } from "../types";
import {
  formatCompactTokens,
  formatEstimatedCost,
  formatFullTokens,
  usageView,
} from "../presentation";
import { ShimmerText } from "./ShimmerText";

export function UsagePanel({ task }: { task: Task }) {
  const usage = usageView(task);
  if (usage.kind === "pending" || usage.kind === "calculating") {
    return (
      <Paper aria-live="polite" className="taskchef-subtle-panel" p="sm" radius="md">
        <Group gap="xs">
          <IconCoins aria-hidden size={16} />
          <Text size="sm"><ShimmerText>{usage.label}</ShimmerText></Text>
        </Group>
      </Paper>
    );
  }
  if (usage.kind === "unavailable") {
    return <Text aria-live="polite" c="dimmed" size="sm">{usage.label}</Text>;
  }
  const cached = usage.usage.cachedInputTokens ?? 0;
  const input = usage.usage.inputTokens ?? 0;
  const cacheRatio = input + cached > 0 ? `${Math.round((cached / (input + cached)) * 100)}%` : "—";
  const values: Array<{
    accessibleValue?: string;
    label: string;
    title?: string;
    value: string;
  }> = [
    {
      accessibleValue: `${formatFullTokens(usage.usage.totalTokens)} tokens`,
      label: usage.knownSoFar ? "Tokens · known so far" : "Tokens",
      title: `${formatFullTokens(usage.usage.totalTokens)} tokens`,
      value: formatCompactTokens(usage.usage.totalTokens),
    },
    {
      accessibleValue: usage.usage.estimatedCostUsd == null
        ? "Estimated cost unavailable"
        : `Estimated cost ${formatEstimatedCost(usage.usage.estimatedCostUsd)}`,
      label: "Estimated cost",
      title: usage.usage.estimatedCostUsd == null
        ? undefined
        : `Unrounded estimate: $${usage.usage.estimatedCostUsd}`,
      value: formatEstimatedCost(usage.usage.estimatedCostUsd),
    },
    { label: "Model", value: Object.keys(usage.usage.models ?? {}).join(", ") || "—" },
    { label: "Cache ratio", value: cacheRatio },
  ];
  return (
    <Box aria-live="polite" className="taskchef-metrics">
      {values.map(({ accessibleValue, label, title, value }) => (
        <Paper className="taskchef-metric" key={label} p="sm" radius="md" withBorder>
          <Text c="dimmed" size="xs">{label}</Text>
          <Text
            aria-label={accessibleValue}
            className="taskchef-metric-value"
            fw={650}
            size="sm"
            title={title}
          >
            {value}
          </Text>
        </Paper>
      ))}
    </Box>
  );
}
