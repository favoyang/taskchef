import { Box, Group, Paper, Stack, Text, Title } from "@mantine/core";
import { latestTurnPresentation } from "../../state.js";
import type { Task } from "../types";
import { GitHubLinks } from "./GitHubLinks";
import { LinkedText } from "./LinkedText";
import { OpenChatButton } from "./OpenChatButton";
import { RelativeTime } from "./RelativeTime";
import { ShimmerText } from "./ShimmerText";
import { StatusBadge } from "./StatusBadge";
import { TaskUsageSummary } from "./TaskUsageSummary";

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
    <Paper className="taskchef-task-row" component="article" p="md" radius="md" withBorder>
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
                <TaskUsageSummary task={task} />
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
          <Group className="taskchef-card-footer" gap="md" justify="space-between">
            <RelativeTime label={`Updated time for ${task.title}`} value={task.meaningfulUpdatedAt ?? task.updatedAt} />
            <OpenChatButton onClick={() => onOpenCodex(task)} taskTitle={task.title} />
          </Group>
      </Stack>
    </Paper>
  );
}
