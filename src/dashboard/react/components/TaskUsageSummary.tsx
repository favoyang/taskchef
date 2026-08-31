import { Text } from "@mantine/core";
import type { Task } from "../types";
import { listUsageView } from "../presentation";
import { ShimmerText } from "./ShimmerText";

export function TaskUsageSummary({ task }: { task: Task }) {
  const usage = listUsageView(task);
  const content = usage.kind === "pending" || usage.kind === "calculating"
    ? <ShimmerText>{usage.label}</ShimmerText>
    : usage.label;
  return (
    <Text
      aria-label={usage.accessibleLabel}
      aria-live="polite"
      c="dimmed"
      className="taskchef-task-usage"
      data-usage-state={usage.kind}
      size="xs"
      title={usage.title}
    >
      {content}
    </Text>
  );
}
