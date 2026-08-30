import { ActionIcon, Box, Button, Group, Paper, Portal, ScrollArea, Stack, Text, Tooltip } from "@mantine/core";
import { IconBell, IconX } from "@tabler/icons-react";
import { notificationDismissLabel, notificationOpenLabel, notificationTitle } from "../../state.js";
import { formatRelativeTime } from "../../time.js";
import type { NotificationSnapshot, Task } from "../types";
import { StatusBadge } from "./StatusBadge";

export function NotificationCenter({
  notifications,
  announcements = notifications,
  onClear,
  onDismiss,
  onOpen,
  tasks,
  withinPortal = true,
}: {
  announcements?: NotificationSnapshot[];
  notifications: NotificationSnapshot[];
  onClear: () => void;
  onDismiss: (notification: NotificationSnapshot) => void;
  onOpen: (notification: NotificationSnapshot) => void;
  tasks: Task[];
  withinPortal?: boolean;
}) {
  if (notifications.length === 0) return null;
  const content = (
    <>
      <Paper
        aria-label="Task notifications"
        className="taskchef-notifications"
        p="sm"
        radius="md"
        role="region"
        shadow="xl"
        withBorder
      >
        <Group justify="space-between" mb="xs">
          <Group gap={6}>
            <IconBell aria-hidden size={16} />
            <Text fw={700} size="sm">Updates</Text>
          </Group>
          <Button onClick={onClear} size="compact-xs" variant="subtle">Clear all</Button>
        </Group>
        <ScrollArea.Autosize className="taskchef-notification-scroll" mah="min(55vh, 520px)" type="auto">
          <Stack className="taskchef-notification-list" gap={6}>
            {notifications.map((notification) => {
              const available = tasks.some((task) => task.id === notification.taskId);
              const descriptionId = `notification-${Math.abs(hash(notification.id))}`;
              const summaryId = `${descriptionId}-summary`;
              const metadataId = `${descriptionId}-metadata`;
              return (
                <Paper className="taskchef-notification" key={notification.id} p="xs" radius="sm">
                  <Group align="flex-start" gap="xs" wrap="nowrap">
                    <button
                      aria-describedby={[notification.summary ? summaryId : null, metadataId].filter(Boolean).join(" ")}
                      aria-label={notificationOpenLabel(notification, available)}
                      className="taskchef-notification-open"
                      onClick={() => onOpen(notification)}
                      type="button"
                    >
                      <Group gap="xs" justify="space-between" wrap="nowrap">
                        <Text fw={700} size="sm">{notificationTitle(notification)}</Text>
                        <StatusBadge status={notification.status} />
                      </Group>
                      <Text lineClamp={1} size="sm">{notification.title}</Text>
                      {notification.summary && <Text className="taskchef-preserve-lines" id={summaryId} lineClamp={3} size="xs">{notification.summary}</Text>}
                      <Text c="dimmed" id={metadataId} size="xs">
                        {formatRelativeTime(notification.timestamp)}{available ? "" : " · Task no longer available"}
                      </Text>
                    </button>
                    <Tooltip label="Dismiss notification">
                      <ActionIcon
                        aria-label={notificationDismissLabel(notification)}
                        color="gray"
                        onClick={() => onDismiss(notification)}
                        size="compact-sm"
                        variant="subtle"
                      >
                        <IconX aria-hidden size={14} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                </Paper>
              );
            })}
          </Stack>
        </ScrollArea.Autosize>
      </Paper>
      <Box aria-atomic="true" aria-live="polite" className="taskchef-visually-hidden" role="status">
        {announcements.map(notificationAnnouncement).join(" ")}
      </Box>
    </>
  );
  return withinPortal ? <Portal>{content}</Portal> : content;
}

function notificationAnnouncement(notification: NotificationSnapshot) {
  return [
    notificationTitle(notification),
    notification.title,
    notification.summary,
    notification.turnRef ? `Turn ref ${notification.turnRef}` : null,
    formatRelativeTime(notification.timestamp),
  ].filter(Boolean).map((part) => String(part).replace(/[.\s]+$/, "")).join(". ") + ".";
}

function hash(value: string) {
  let result = 0;
  for (const character of value) result = ((result << 5) - result + character.charCodeAt(0)) | 0;
  return result;
}
