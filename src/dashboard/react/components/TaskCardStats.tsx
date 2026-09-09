import { Box, Text, Tooltip } from "@mantine/core";
import {
  IconCurrencyDollar,
  IconHistory,
  IconHourglass,
  IconStack2,
} from "@tabler/icons-react";
import type { ReactNode } from "react";
import type { Task } from "../types";
import { listUsageMetricsView, taskReportedWorkView } from "../presentation";
import { RelativeTime } from "./RelativeTime";
import { ShimmerText } from "./ShimmerText";

function StaticStat({
  accessibleLabel,
  animated = false,
  icon,
  title,
  value,
}: {
  accessibleLabel: string;
  animated?: boolean;
  icon: ReactNode;
  title: string;
  value: string;
}) {
  return (
    <Tooltip events={{ focus: true, hover: true, touch: false }} label={title} multiline>
      <Text
        aria-label={accessibleLabel}
        className="taskchef-card-stat-content"
        component="span"
        size="xs"
        tabIndex={0}
      >
        {icon}
        <bdi>{animated ? <ShimmerText>{value}</ShimmerText> : value}</bdi>
      </Text>
    </Tooltip>
  );
}

export function TaskCardStats({ task }: { task: Task }) {
  const reportedWork = taskReportedWorkView(task);
  const usage = listUsageMetricsView(task);
  return (
    <Box className="taskchef-card-stats" component="div">
      <Box className="taskchef-card-stat">
        <RelativeTime
          icon={<IconHistory aria-hidden size={14} />}
          label={`Updated time for ${task.title}`}
          value={task.meaningfulUpdatedAt ?? task.updatedAt}
        />
      </Box>
      <Box className="taskchef-card-stat">
        <StaticStat
          accessibleLabel={reportedWork.accessibleLabel}
          icon={<IconHourglass aria-hidden size={14} />}
          title={reportedWork.title}
          value={reportedWork.value}
        />
      </Box>
      <Box className="taskchef-card-stat" data-usage-state={usage.kind}>
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
      </Box>
      <Box className="taskchef-card-stat" data-usage-state={usage.kind}>
        <StaticStat
          accessibleLabel={usage.cost.accessibleLabel}
          animated={usage.animated}
          icon={<IconCurrencyDollar aria-hidden size={14} />}
          title={usage.cost.title}
          value={usage.cost.value}
        />
      </Box>
    </Box>
  );
}
