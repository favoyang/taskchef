import { Alert, Anchor, Badge, Box, Drawer, Group, Modal, ScrollArea, Stack, Text, Title, Tooltip } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconClock, IconFolder, IconHourglass, IconRobot } from "@tabler/icons-react";
import { useEffect, useState, type ReactNode } from "react";
import type { Task, SavedUsage } from "../../dashboard/react/types";
import { PullRequestInfo, nextRunLabel } from "../../dashboard/react/components/CardStatusIcons";
import { OpenChatButton } from "../../dashboard/react/components/OpenChatButton";
import { ReplyMarkdown } from "../../dashboard/react/components/ReplyMarkdown";
import { compactTokens, TokenBreakdown } from "../../dashboard/react/components/SavedUsageFormat";
import { GitHubLinks } from "../../dashboard/react/components/GitHubLinks";
import { formatWorkedDuration } from "../../dashboard/time.js";

export function NextTaskDetail({ task, opened, busy, error, onClose, onOpenCodex, extraActions }: {
  task: Task | null; opened: boolean; busy: boolean; error: string | null;
  onClose: () => void; onOpenCodex: () => void; extraActions?: ReactNode;
}) {
  const mobile = useMediaQuery("(max-width: 48em)");
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!opened || task?.observed?.lastTurnEvent !== "inProgress") return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [opened, task?.turnId, task?.observed?.lastTurnEvent]);
  if (!task) return null;
  const start = Date.parse(task.observed?.lastTurnEventAt ?? "");
  const duration = task.observed?.lastTurnEvent === "inProgress" && Number.isFinite(start)
    ? Math.max(0, now - start) : task.observed?.latestTurnDurationMs;
  const prs = task.detailPullRequests ?? task.pullRequests ?? [];
  const firstRepo = new Set<string>();
  const warnedRepo = new Set<string>();
  const deniedRepos = new Set(prs.filter(pr => pr.accessIssue === "denied").map(pr => pr.url.split("/pull/")[0]));
  const nextRun = task.scheduled && task.nextRunAt && Number.isFinite(Date.parse(task.nextRunAt)) ? nextRunLabel(task.nextRunAt) : null;
  const count = task.observed?.directChildCount;
  const source = task.observed?.source === "vscode" ? "Desktop" : task.observed?.source === "cli" ? "CLI" : task.observed?.source === "exec" ? "Exec" : null;
  const input = task.inputSource === "ordinary" ? "Human" : task.inputSource === "scheduled" ? "Scheduled" : task.inputSource === "unverified" ? "Unknown" : null;
  const label = task.status === "needs_input" || task.status === "interrupted" ? "Waiting for review" : task.status === "working" ? "Running" : task.status === "completed" ? "Done" : task.statusLabel;
  const content = <Stack gap="md">
    <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs" pr={8}>
      <Group gap="xs" mt={0} className="taskchef-detail-meta">
        <Tooltip label={task.project?.path || "No project"}><Text size="sm" c="dimmed" className="taskchef-detail-project"><IconFolder size={14} /><span>{task.project?.name || "No project"}</span></Text></Tooltip>
        {label && <Badge variant="light" color="gray">{label}</Badge>}
        {task.status === "interrupted" && <Badge variant="light" color="yellow">Interrupted</Badge>}
      </Group>
      <Group gap="xs" wrap="nowrap" className="taskchef-detail-actions">
        {extraActions}
        <OpenChatButton loading={busy} onClick={onOpenCodex} taskTitle={task.title} />
      </Group>
    </Group>
    {error && <Alert color="red">{error}</Alert>}
    <Box className="taskchef-detail-layout">
      <Box className="taskchef-detail-reply">
        {task.replyExcerpt && <ReplyMarkdown text={task.replyExcerpt} />}
        <details className="taskchef-detail-technical">
          <summary>Technical details</summary>
          <Stack gap={8} mt="sm">
            <TechnicalField label="Chat ID" value={task.id} />
            {task.turnId && <TechnicalField label="Turn ID" value={task.turnId} />}
            {source && <TechnicalField label="Source" value={source} />}
            {input && <TechnicalField label="Last input" value={input} />}
          </Stack>
        </details>
      </Box>
      <Stack gap="lg" className="taskchef-detail-sidebar">
        {(duration != null || nextRun || count != null) && <section aria-label="Activity">
          <Title order={5} mb="sm">Activity</Title>
          <Stack gap={10}>
            {duration != null && <ActivityRow icon={<IconHourglass size={15} />}>{task.observed?.lastTurnEvent === "inProgress" ? "Worked for" : "Latest turn worked for"} {formatWorkedDuration(duration)}</ActivityRow>}
            {task.observed?.recordedChatDurationMs != null && <Tooltip multiline w={280} label={`Sum of saved turn durations across this chat’s rollout files, plus the current running turn. Excludes idle time and subagents.${task.observed.historicalTimePartial ? " Some historical records are missing or unreadable." : ""}${task.observed.missingTurnDurations ? ` ${task.observed.missingTurnDurations} finished turns have no saved duration.` : ""}`}><Box><ActivityRow icon={<IconHourglass size={15} />}>Total chat worked for {formatWorkedDuration(task.observed.recordedChatDurationMs + (task.observed.lastTurnEvent === "inProgress" ? duration ?? 0 : 0))}{task.observed.historicalTimePartial && " · Partial"}</ActivityRow></Box></Tooltip>}
            {nextRun && <ActivityRow icon={<IconClock size={15} className="taskchef-schedule-clock" />}>{nextRun}</ActivityRow>}
            {count != null && <ActivityRow icon={<IconRobot size={15} />}>{count} {count === 1 ? "subagent" : "subagents"}</ActivityRow>}
          </Stack>
        </section>}
        {task.sessionUsage && <section aria-label="Usage">
          <Title order={5} mb="sm">Usage</Title>
          <table className="taskchef-detail-usage"><thead><tr><th /><th>Latest turn</th><th>Total chat</th></tr></thead><tbody>
            <tr><th>Tokens</th>{[task.sessionUsage.latest, task.sessionUsage.total].map((value, i) => <td key={i}><Tooltip multiline w={280} label={<TokenBreakdown value={value} />}><span>{value.samples ? compactTokens(value.tokens.total_tokens) : "—"}{value.partial && " · Partial"}</span></Tooltip></td>)}</tr>
            <tr><th>API-equivalent cost</th>{[task.sessionUsage.latest, task.sessionUsage.total].map((value, i) => <td key={i}><Tooltip multiline w={280} label={value.costPartial ? "Some usage records or model prices are missing. This is the subtotal for the calls TaskChef can price." : "Estimated from saved calls at standard API prices."}><span>{usageCost(value)}</span></Tooltip></td>)}</tr>
          </tbody></table>
          <Text size="xs" c="dimmed" mt={8}>Estimates use <Anchor size="xs" href="https://developers.openai.com/api/docs/pricing" target="_blank" rel="noopener noreferrer">OpenAI API pricing</Anchor>. Subscription users are not billed this amount.</Text>
        </section>}
        {(prs.length > 0 || task.relatedGitHubLinks?.length) && <section aria-label="Pull requests">
          <Title order={5} mb="sm">Pull requests</Title>
          <Stack gap="md">{prs.map(pr => {
            const repo = pr.url.split("/pull/")[0];
            const first = !firstRepo.has(repo);
            firstRepo.add(repo);
            // A missing PR does not prove the whole repository is inaccessible.
            const showAccess = !warnedRepo.has(repo) && (deniedRepos.has(repo) ? first : Boolean(pr.accessIssue));
            if (showAccess) warnedRepo.add(repo);
            return <PullRequestInfo key={pr.url} pr={first && deniedRepos.has(repo) ? { ...pr, accessIssue: "denied" } : pr} showAccess={showAccess} showChecks={false} />;
          })}<GitHubLinks task={task} /></Stack>
        </section>}
      </Stack>
    </Box>
  </Stack>;
  return mobile
    ? <Drawer opened={opened} onClose={onClose} position="bottom" size="92%" title={task.title} classNames={{ content: "taskchef-detail-dialog" }} zIndex={300} scrollAreaComponent={ScrollArea.Autosize}>{content}</Drawer>
    : <Modal opened={opened} onClose={onClose} title={task.title} size={960} centered classNames={{ content: "taskchef-detail-dialog" }} zIndex={300} scrollAreaComponent={ScrollArea.Autosize}>{content}</Modal>;
}

function usageCost(value: SavedUsage) {
  if (!value.samples || (value.costPartial && value.costUsd === 0)) return "—";
  return `${value.costPartial ? "At least " : ""}$${value.costUsd.toFixed(2)}`;
}

function ActivityRow({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <Text size="sm" className="taskchef-detail-activity-row"><span aria-hidden>{icon}</span><span>{children}</span></Text>;
}
function TechnicalField({ label, value }: { label: string; value: string }) {
  return <Box className="taskchef-detail-field"><Text size="xs" c="dimmed">{label}</Text><Text size="sm" className="taskchef-detail-id">{value}</Text></Box>;
}
