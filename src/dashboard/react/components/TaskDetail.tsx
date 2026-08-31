import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Divider,
  Drawer,
  Group,
  Menu,
  Modal,
  ScrollArea,
  Stack,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
  IconCheck,
  IconClipboard,
  IconDots,
  IconX,
} from "@tabler/icons-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Task } from "../types";
import { ActivityTimeline } from "./ActivityTimeline";
import { GitHubLinks } from "./GitHubLinks";
import { OpenChatButton } from "./OpenChatButton";
import { RelativeTime } from "./RelativeTime";
import { StatusBadge } from "./StatusBadge";
import { UsagePanel } from "./UsagePanel";

export type TerminalStatus = "completed" | "failed";
export interface ManualTransitionResult {
  ok: boolean;
  rotateActionId?: boolean;
}

export function TaskDetail({
  busy,
  error,
  highlightTurnRef,
  onClose,
  onCopy,
  onOpenCodex,
  onTransition,
  opened,
  task,
  notifications,
  notice,
}: {
  busy: boolean;
  error: string | null;
  highlightTurnRef: string | null;
  onClose: () => void;
  onCopy: () => void;
  onOpenCodex: () => void;
  onTransition: (status: TerminalStatus, actionId: string) => Promise<ManualTransitionResult>;
  opened: boolean;
  task: Task | null;
  notifications?: ReactNode;
  notice?: string | null;
}) {
  const mobile = useMediaQuery("(max-width: 48em)");
  const [confirmStatus, setConfirmStatus] = useState<TerminalStatus | null>(null);
  useEffect(() => {
    if (!opened) setConfirmStatus(null);
  }, [opened]);
  useEffect(() => {
    if (opened && highlightTurnRef) {
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(`[data-turn-ref="${CSS.escape(highlightTurnRef)}"]`)?.focus();
      });
    }
  }, [highlightTurnRef, opened, task?.turns?.length, task?.updatedAt]);
  useEffect(() => {
    if (confirmStatus && (!task || !manualTransitionTargets(task).includes(confirmStatus))) {
      setConfirmStatus(null);
    }
  }, [confirmStatus, task?.status]);

  if (!task) return null;
  const transitionTargets = manualTransitionTargets(task);
  const content = (
    <Stack gap="lg">
      {notifications}
      <Box>
        <Group align="flex-start" gap="sm" justify="space-between" wrap="nowrap">
          <Box>
            <Text c="teal" fw={700} size="xs" tt="uppercase">{task.project.name}</Text>
            <Title id="task-detail-title" order={2} size="h3" tabIndex={-1}>{task.title}</Title>
          </Box>
          <StatusBadge status={task.status} />
        </Group>
        <Group gap="xs" mt="md">
          <OpenChatButton loading={busy} onClick={onOpenCodex} taskTitle={task.title} />
          <Menu position="bottom-start" shadow="md" withinPortal zIndex={360}>
            <Menu.Target>
              <Tooltip label="More task actions">
                <ActionIcon aria-label="More task actions" disabled={busy} variant="default">
                  <IconDots aria-hidden size={17} />
                </ActionIcon>
              </Tooltip>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<IconClipboard size={14} />} onClick={onCopy}>Copy Task ID</Menu.Item>
              {transitionTargets.includes("completed") && (
                <Menu.Item leftSection={<IconCheck size={14} />} onClick={() => setConfirmStatus("completed")}>Mark completed</Menu.Item>
              )}
              {transitionTargets.includes("failed") && (
                <Menu.Item color="red" leftSection={<IconX size={14} />} onClick={() => setConfirmStatus("failed")}>Mark failed</Menu.Item>
              )}
            </Menu.Dropdown>
          </Menu>
        </Group>
        <Box mt="sm">
          <GitHubLinks task={task} />
        </Box>
      </Box>

      {confirmStatus && (
        <ManualTransitionConfirmation
          key={confirmStatus}
          busy={busy}
          onCancel={() => setConfirmStatus(null)}
          onTransition={onTransition}
          status={confirmStatus}
        />
      )}
      {notice && <Alert color="teal" role="status">{notice}</Alert>}
      {error && <Alert color="red" role="alert">{error}</Alert>}

      <section aria-labelledby="usage-heading">
        <Title id="usage-heading" mb="xs" order={3} size="h5">Usage</Title>
        <UsagePanel task={task} />
      </section>
      <Divider />
      <section aria-labelledby="activity-heading">
        <Title id="activity-heading" mb="sm" order={3} size="h5">Activity timeline</Title>
        <ActivityTimeline highlightTurnRef={highlightTurnRef} task={task} />
      </section>
      <section aria-labelledby="instruction-heading">
        <Title id="instruction-heading" mb="xs" order={3} size="h5">Original instruction</Title>
        <Box className="taskchef-code-panel" component="pre">{task.instruction}</Box>
      </section>
      <section aria-labelledby="metadata-heading">
        <Title id="metadata-heading" mb="xs" order={3} size="h5">Metadata</Title>
        <dl className="taskchef-metadata">
          <dt>Task ID</dt><dd>{task.id}</dd>
          <dt>Thread ID</dt><dd>{task.threadId ?? "—"}</dd>
          <dt>Current turn ref</dt><dd>{task.turnRef ?? "—"}</dd>
          <dt>Project path</dt><dd>{task.project.path}</dd>
          <dt>Created</dt><dd><RelativeTime label="Created time" value={task.createdAt} /></dd>
          <dt>Updated</dt><dd><RelativeTime label="Updated time" value={task.meaningfulUpdatedAt ?? task.updatedAt} /></dd>
          <dt>Updated by</dt><dd>{task.updatedBy ?? "—"}</dd>
        </dl>
      </section>
    </Stack>
  );

  if (mobile) {
    return (
      <Drawer
        closeOnClickOutside={!busy}
        closeOnEscape={!busy}
        onClose={onClose}
        opened={opened}
        overlayProps={{ backgroundOpacity: 0.55, blur: 2 }}
        position="bottom"
        scrollAreaComponent={ScrollArea.Autosize}
        size="92%"
        title={<span className="taskchef-visually-hidden">Task details</span>}
        trapFocus
        zIndex={300}
      >
        {content}
      </Drawer>
    );
  }
  return (
    <Modal
      aria-labelledby="task-detail-title"
      closeOnClickOutside={!busy}
      closeOnEscape={!busy}
      onClose={onClose}
      opened={opened}
      overlayProps={{ backgroundOpacity: 0.55, blur: 2 }}
      scrollAreaComponent={ScrollArea.Autosize}
      size="min(820px, calc(100vw - 32px))"
      title={<span className="taskchef-visually-hidden">Task details</span>}
      trapFocus
      zIndex={300}
    >
      {content}
    </Modal>
  );
}

function manualTransitionTargets(task: Task): TerminalStatus[] {
  return task.status === "completed"
    ? ["failed"]
    : task.status === "failed"
      ? ["completed"]
      : task.status === "working" || task.status === "needs_input"
        ? ["completed", "failed"]
        : [];
}

export function ManualTransitionConfirmation({
  busy,
  onCancel,
  onTransition,
  status,
}: {
  busy: boolean;
  onCancel: () => void;
  onTransition: (status: TerminalStatus, actionId: string) => Promise<ManualTransitionResult>;
  status: TerminalStatus;
}) {
  const actionId = useRef(crypto.randomUUID());
  return (
    <Alert color={status === "failed" ? "red" : "teal"} role="alert" title={`Mark task ${status}?`}>
      <Text mb="sm" size="sm">This interrupts active work and appends an audited manual dashboard turn.</Text>
      <Group gap="xs">
        <Button
          color={status === "failed" ? "red" : "teal"}
          loading={busy}
          onClick={async () => {
            const result = await onTransition(status, actionId.current);
            if (result.ok) {
              onCancel();
              requestAnimationFrame(() => document.getElementById("task-detail-title")?.focus());
            }
            else if (result.rotateActionId) actionId.current = crypto.randomUUID();
          }}
          size="compact-sm"
        >
          Confirm
        </Button>
        <Button disabled={busy} onClick={onCancel} size="compact-sm" variant="default">Cancel</Button>
      </Group>
    </Alert>
  );
}
