import { Text } from "@mantine/core";
import {
  IconCurrencyDollar,
  IconHistory,
  IconHourglass,
  IconStack2,
} from "@tabler/icons-react";
import type { Task } from "../types";
import { listUsageMetricsView, taskReportedWorkView } from "../presentation";
import { RelativeTime } from "./RelativeTime";
import { StatCell, StaticStat, StatsGrid } from "./StatsGrid";

export function TaskCardStats({ task }: { task: Task }) {
  const reportedWork = taskReportedWorkView(task);
  const usage = listUsageMetricsView(task);
  return (
    <StatsGrid variant="card">
      <StatCell>
        <RelativeTime
          icon={<IconHistory aria-hidden size={14} />}
          label={`Updated time for ${task.title}`}
          value={task.meaningfulUpdatedAt ?? task.updatedAt}
        />
      </StatCell>
      <StatCell>
        <StaticStat
          accessibleLabel={reportedWork.accessibleLabel}
          icon={<IconHourglass aria-hidden size={14} />}
          title={reportedWork.title}
          value={reportedWork.value}
        />
      </StatCell>
      <StatCell usageState={usage.kind}>
        <StaticStat
          accessibleLabel={usage.tokens.accessibleLabel}
          animated={usage.animated}
          icon={<IconStack2 aria-hidden size={14} />}
          title={usage.tokens.title}
          value={usage.tokens.value}
        />
        <Text className="taskchef-visually-hidden" component="span" role="status">
          {usage.tokens.accessibleLabel}; {usage.cost.accessibleLabel}
        </Text>
      </StatCell>
      <StatCell usageState={usage.kind}>
        <StaticStat
          accessibleLabel={usage.cost.accessibleLabel}
          animated={usage.animated}
          icon={<IconCurrencyDollar aria-hidden size={14} />}
          title={usage.cost.title}
          value={usage.cost.value}
        />
      </StatCell>
    </StatsGrid>
  );
}
