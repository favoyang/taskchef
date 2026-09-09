import { Box, Text, Tooltip } from "@mantine/core";
import type { ReactNode } from "react";
import { ShimmerText } from "./ShimmerText";

export function StatsGrid({
  children,
  variant,
}: {
  children: ReactNode;
  variant: "card" | "turn";
}) {
  return (
    <Box className={`taskchef-stats taskchef-${variant}-stats`} component="div">
      {children}
    </Box>
  );
}

export function StatCell({
  children,
  usageState,
}: {
  children: ReactNode;
  usageState?: string;
}) {
  return (
    <Box className="taskchef-stat" data-usage-state={usageState}>
      {children}
    </Box>
  );
}

export function StaticStat({
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
        className="taskchef-stat-content"
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
