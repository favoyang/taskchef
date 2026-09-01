import { Box, Paper, Stack, Text } from "@mantine/core";
import { mergeProjectedTurns, turnPresentation } from "../../state.js";
import { turnReportedWorkView, turnUsageMetricsView } from "../presentation";
import type { Task, TaskTurn } from "../types";
import { useEffect, useState } from "react";
import { RelativeTime } from "./RelativeTime";
import { LinkedText } from "./LinkedText";
import { ShimmerText } from "./ShimmerText";
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
                <StatusBadge status={presentation.status} />
                <RelativeTime label="Turn update time" value={presentation.updatedAt} />
              </Box>
              {presentation.sourceLabel && <Text c="dimmed" size="xs">{presentation.sourceLabel}</Text>}
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
              <Box className="taskchef-turn-metrics">
                <TurnMetric
                  accessibleLabel={usage.tokens.accessibleLabel}
                  animated={usage.animated}
                  label="Tokens"
                  title={usage.title}
                  value={usage.tokens.value}
                />
                <TurnMetric
                  accessibleLabel={usage.cost.accessibleLabel}
                  animated={usage.animated}
                  label="Estimated cost"
                  title={usage.title}
                  value={usage.cost.value}
                />
                <TurnReportedWorkMetric turn={turn} />
              </Box>
              {usage.note && <Text c="dimmed" size="xs">{usage.note}</Text>}
              <Text c="dimmed" className="taskchef-mono" size="xs">Turn ref: {identity ?? "—"}</Text>
            </Stack>
          </Paper>
        );
      })}
    </Stack>
  );
}

function TurnReportedWorkMetric({ turn }: { turn: TaskTurn }) {
  const now = useLiveNow(turn.result === null);
  const elapsed = turnReportedWorkView(turn, now);
  return (
    <TurnMetric
      accessibleLabel={elapsed.accessibleLabel}
      label={elapsed.label}
      title={elapsed.title}
      value={elapsed.value}
    />
  );
}

function TurnMetric({
  accessibleLabel,
  animated = false,
  label,
  title,
  value,
}: {
  accessibleLabel?: string;
  animated?: boolean;
  label: string;
  title?: string;
  value: string;
}) {
  return (
    <Box className="taskchef-turn-metric" title={title}>
      <Text c="dimmed" className="taskchef-field-label" size="xs">{label}</Text>
      <Text aria-label={accessibleLabel} c="dimmed" size="xs">
        {animated ? <ShimmerText>{value}</ShimmerText> : value}
      </Text>
    </Box>
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
