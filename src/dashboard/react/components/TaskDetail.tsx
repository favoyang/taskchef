import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Divider,
  Drawer,
  Group,
  Menu,
  Modal,
  Paper,
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
  }, [confirmStatus, task]);

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
      <ExecutionPanel task={task} />
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
          <dt>Execution mode</dt><dd>{task.executionMode ?? "legacy"}</dd>
          <dt>Execution revision</dt><dd>{task.executionRevision ?? 0}</dd>
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

export function manualTransitionTargets(task: Task): TerminalStatus[] {
  if (task.latestTurn?.phases?.some((phase) => ["reserved", "running"].includes(phase.state))) {
    return [];
  }
  return task.status === "completed"
    ? ["failed"]
    : task.status === "failed"
      ? ["completed"]
      : task.status === "working" || task.status === "needs_input"
        ? ["completed", "failed"]
        : [];
}

function readable(value: string) {
  return value.replaceAll("_", " ");
}

export function ExecutionPanel({ task }: { task: Task }) {
  const turn = task.latestTurn;
  const phases = turn?.phases ?? [];
  const current = phases.find((phase) => ["reserved", "running"].includes(phase.state)) ?? null;
  return (
    <section aria-labelledby="execution-heading">
      <Group align="center" justify="space-between" mb="xs">
        <Title id="execution-heading" order={3} size="h5">Execution</Title>
        <Badge color={task.executionMode === "orchestrated" ? "teal" : "gray"}>
          {task.executionMode ?? "legacy"}
        </Badge>
      </Group>
      {task.executionMode !== "orchestrated" ? (
        <Text c="dimmed" size="sm">Legacy single-executor task. No role phase telemetry is available.</Text>
      ) : (
        <Stack gap="sm">
          <Box>
            <Text size="sm"><strong>Intent:</strong> {turn?.intent ? readable(turn.intent) : "Not classified"}</Text>
            <Text size="sm"><strong>Accepted scope:</strong> {turn?.acceptedScope ?? "Not recorded"}</Text>
            {turn?.planRef && (
              <Text size="sm" style={{ overflowWrap: "anywhere" }}>
                <strong>Plan:</strong> {turn.planRef.repository} · {turn.planRef.path} @ {turn.planRef.revision}
              </Text>
            )}
            <Text c="dimmed" size="xs">
              {current ? `Current phase: ${current.kind} attempt ${current.attempt}` : "No active phase"}
            </Text>
          </Box>
          {phases.length === 0 ? (
            <Text c="dimmed" size="sm">No phases reported yet.</Text>
          ) : phases.map((phase) => {
            const preference = [phase.resolution.model, phase.resolution.effort].filter(Boolean).join(" · ") || "native fallback";
            const effective = [phase.resolution.effectiveModel, phase.resolution.effectiveEffort].filter(Boolean).join(" · ") || "not reported";
            return (
              <Paper key={phase.phaseId} p="sm" radius="md" withBorder>
                <Group align="flex-start" justify="space-between" wrap="nowrap">
                  <Box>
                    <Text fw={650} size="sm">{readable(phase.kind)} · attempt {phase.attempt}</Text>
                    <Text c="dimmed" size="xs">{phase.role} · preference {preference} · runtime effective {effective}</Text>
                  </Box>
                  <Badge color={phase.state === "completed" ? "teal" : phase.state === "failed" ? "red" : phase.state === "awaiting_input" ? "yellow" : "blue"}>
                    {readable(phase.state)}
                  </Badge>
                </Group>
                {phase.result && <Text mt="xs" size="sm">{phase.result.summary}</Text>}
                {phase.threadBinding && (
                  <Text c="dimmed" mt="xs" size="xs">Child identity: {phase.threadBinding.threadId} ({readable(phase.threadBinding.provenance)})</Text>
                )}
              </Paper>
            );
          })}
        </Stack>
      )}
    </section>
  );
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
