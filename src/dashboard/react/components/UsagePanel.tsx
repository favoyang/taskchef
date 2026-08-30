import { Box, Group, Paper, Text } from "@mantine/core";
import { IconCoins } from "@tabler/icons-react";
import type { Task } from "../types";
import { usageView } from "../presentation";
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
  const values = [
    [usage.knownSoFar ? "Tokens · known so far" : "Tokens", new Intl.NumberFormat().format(usage.usage.totalTokens)],
    ["Estimated cost", usage.usage.estimatedCostUsd == null ? "—" : `$${usage.usage.estimatedCostUsd.toFixed(4)}`],
    ["Model", Object.keys(usage.usage.models ?? {}).join(", ") || "—"],
    ["Cache ratio", cacheRatio],
  ] as const;
  return (
    <Box aria-live="polite" className="taskchef-metrics">
      {values.map(([label, value]) => (
        <Paper className="taskchef-metric" key={label} p="sm" radius="md" withBorder>
          <Text c="dimmed" size="xs">{label}</Text>
          <Text className="taskchef-metric-value" fw={650} size="sm">{value}</Text>
        </Paper>
      ))}
    </Box>
  );
}
