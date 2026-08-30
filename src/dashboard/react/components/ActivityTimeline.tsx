import { Box, Paper, Stack, Text } from "@mantine/core";
import { mergeProjectedTurns, turnPresentation } from "../../state.js";
import { turnUsageView } from "../presentation";
import type { Task } from "../types";
import { RelativeTime } from "./RelativeTime";
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
        const usage = turnUsageView(task, turn);
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
                <Text className="taskchef-preserve-lines" size="sm">{turn.requestSummary ?? "Request not recorded."}</Text>
              </Box>
              <Box>
                <Text c="dimmed" className="taskchef-field-label" size="xs">Result</Text>
                <Text className="taskchef-preserve-lines" size="sm">
                  {presentation.status === "working"
                    ? <ShimmerText>{presentation.summary}</ShimmerText>
                    : presentation.summary}
                </Text>
              </Box>
              <Text
                c="dimmed"
                className={usage.kind === "calculating" || usage.kind === "pending" ? "taskchef-turn-usage" : undefined}
                size="xs"
              >
                {usage.kind === "calculating" || usage.kind === "pending"
                  ? <ShimmerText>{usage.label}</ShimmerText>
                  : usage.label}
              </Text>
              <Text c="dimmed" className="taskchef-mono" size="xs">Turn ref: {identity ?? "—"}</Text>
            </Stack>
          </Paper>
        );
      })}
    </Stack>
  );
}
