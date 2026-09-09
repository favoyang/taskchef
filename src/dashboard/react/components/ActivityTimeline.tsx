import { Box, Paper, Stack, Text } from "@mantine/core";
import {
  IconCurrencyDollar,
  IconHistory,
  IconHourglass,
  IconStack2,
} from "@tabler/icons-react";
import { mergeProjectedTurns, turnPresentation } from "../../state.js";
import { turnReportedWorkView, turnUsageMetricsView } from "../presentation";
import type { Task, TaskTurn } from "../types";
import { useEffect, useState } from "react";
import { RelativeTime } from "./RelativeTime";
import { LinkedText } from "./LinkedText";
import { ShimmerText } from "./ShimmerText";
import { StatCell, StaticStat, StatsGrid } from "./StatsGrid";
import { StatusBadge } from "./StatusBadge";

export function ActivityTimeline({ highlightTurnRef, task }: { highlightTurnRef: string | null; task: Task }) {
  const turns = mergeProjectedTurns(task, []) as Task["turns"];
  if (!turns?.length) return <Text c="dimmed" size="sm">No turn history has been recorded.</Text>;
  return (
    <Stack gap="sm">
      {[...turns].reverse().map((turn, index) => {
        const presentation = turnPresentation(turn);
        const identity = turn.turnRef ?? turn.turnId ?? `turn-${index}`;
        const highlighted = identity === highlightTurnRef;
        const usage = turnUsageMetricsView(task, turn);
        return (
          <Paper
            className={`taskchef-turn${highlighted ? " taskchef-turn-highlighted" : ""}`}
            data-turn-ref={identity}
            key={identity}
            p="sm"
            radius="md"
            tabIndex={highlighted ? -1 : undefined}
            withBorder
          >
            <Stack gap={7}>
              <Box className="taskchef-turn-heading">
                <Text c="dimmed" size="xs">{presentation.sourceLabel}</Text>
                <StatusBadge status={presentation.status} />
              </Box>
              <Box>
                <Text c="dimmed" className="taskchef-field-label" size="xs">Request</Text>
                <Text className="taskchef-preserve-lines" size="sm">
                  <LinkedText task={task} text={turn.requestSummary ?? "Request not recorded."} />
                </Text>
              </Box>
              <Box>
                <Text c="dimmed" className="taskchef-field-label" size="xs">Result</Text>
                <Text className="taskchef-preserve-lines" size="sm">
                  {presentation.status === "working"
                    ? <ShimmerText>{presentation.summary}</ShimmerText>
                    : <LinkedText task={task} text={presentation.summary} />}
                </Text>
              </Box>
              <StatsGrid variant="turn">
                <StatCell>
                  <RelativeTime
                    icon={<IconHistory aria-hidden size={14} />}
                    label="Turn update time"
                    tooltipLabel="Updated at"
                    value={presentation.updatedAt}
                  />
                </StatCell>
                <StatCell>
                  <TurnReportedWork turn={turn} />
                </StatCell>
                <StatCell usageState={usage.kind}>
                  <StaticStat
                    accessibleLabel={usage.tokens.accessibleLabel}
                    animated={usage.animated}
                    icon={<IconStack2 aria-hidden size={14} />}
                    title="Tokens"
                    value={usage.tokens.value}
                  />
                </StatCell>
                <StatCell usageState={usage.kind}>
                  <StaticStat
                    accessibleLabel={usage.cost.accessibleLabel}
                    animated={usage.animated}
                    icon={<IconCurrencyDollar aria-hidden size={14} />}
                    title="Estimated cost"
                    value={usage.cost.value}
                  />
                </StatCell>
              </StatsGrid>
              {usage.note && <Text c="dimmed" size="xs">{usage.note}</Text>}
            </Stack>
          </Paper>
        );
      })}
    </Stack>
  );
}

function TurnReportedWork({ turn }: { turn: TaskTurn }) {
  const now = useLiveNow(turn.result === null);
  const elapsed = turnReportedWorkView(turn, now);
  return (
    <StaticStat
      accessibleLabel={elapsed.accessibleLabel}
      icon={<IconHourglass aria-hidden size={14} />}
      title="Duration"
      value={elapsed.value}
    />
  );
}

function useLiveNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [active]);
  return now;
}
