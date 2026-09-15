import { Box, Paper, Stack, Text, Title } from "@mantine/core";
import { IconArrowUpRight } from "@tabler/icons-react";
import { latestTurnPresentation } from "../../state.js";
import type { Task } from "../types";
import { GitHubLinks } from "./GitHubLinks";
import { LinkedText } from "./LinkedText";
import { ShimmerText } from "./ShimmerText";
import { StatusBadge } from "./StatusBadge";
import { TaskCardStats } from "./TaskCardStats";

export function TaskCard({
  onOpenCodex,
  onOpenDetail,
  task,
}: {
  onOpenCodex: (task: Task) => void;
  onOpenDetail: (task: Task) => void;
  task: Task;
}) {
  const latest = latestTurnPresentation(task);
  return (
    <Paper className="taskchef-task-row" component="article" px="sm" py="md" radius="md" withBorder>
      <Stack className="taskchef-task-main" gap="sm">
          <Box>
            <Box className="taskchef-card-heading">
              <Title order={3} size="h5">
                <button className="taskchef-title-button" onClick={() => onOpenDetail(task)} type="button">
                  {task.title}
                </button>
              </Title>
              <Stack align="flex-end" className="taskchef-card-metadata" gap={4}>
                <StatusBadge status={task.status} />
              </Stack>
            </Box>
            <Text c="dimmed" mt={2} size="xs">{task.project.name}</Text>
          </Box>

          <Box className="taskchef-summary-grid">
            <Text c="dimmed" className="taskchef-field-label" size="xs">Request</Text>
            <Text className="taskchef-preserve-lines" lineClamp={3} size="sm">
              <LinkedText task={task} text={latest.requestSummary} />
            </Text>
            <Text c="dimmed" className="taskchef-field-label" size="xs">Result</Text>
            <Text className="taskchef-preserve-lines" lineClamp={3} size="sm">
              {latest.resultStatus === "working"
                ? <ShimmerText>{latest.resultSummary}</ShimmerText>
                : <LinkedText task={task} text={latest.resultSummary} />}
            </Text>
          </Box>

          <GitHubLinks task={task} />
          <Box className="taskchef-list-card-footer">
            <TaskCardStats task={task} />
            <button aria-label={`Open chat for ${task.title}`} className="taskchef-board-chat" onClick={() => onOpenCodex(task)} title="Open chat" type="button">
              <IconArrowUpRight aria-hidden size={19} stroke={1.6} />
            </button>
          </Box>
      </Stack>
    </Paper>
  );
}
