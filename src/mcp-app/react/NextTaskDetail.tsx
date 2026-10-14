import { Alert, Anchor, Badge, Box, Drawer, Group, Modal, ScrollArea, Stack, Text, Title, Tooltip } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconArrowUpRight, IconClock, IconFolder, IconHelpCircle, IconHourglass, IconRobot } from "@tabler/icons-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Task, SavedUsage } from "../../ui/types";
import { PullRequestInfo, nextRunLabel } from "../../ui/components/CardStatusIcons";
import { ApprovalPanel } from "../../ui/components/ApprovalNotice";
import { OpenChatButton } from "../../ui/components/OpenChatButton";
import { QueuedPrompts } from "../../ui/components/QueuedPrompts";
import { TurnContent } from "../../ui/components/TurnContent";
import { compactTokens, TokenBreakdown, useAnimatedUsage } from "../../ui/components/SavedUsageFormat";
import { GitHubLinks } from "../../ui/components/GitHubLinks";
import { formatWorkedDuration } from "../../ui/time.js";

export function NextTaskDetail({ task, opened, busy, usageLoading = false, error, onClose, onOpenCodex, extraActions, loadImage }: {
  task: Task | null; opened: boolean; busy: boolean; usageLoading?: boolean; error: string | null;
  onClose: () => void; onOpenCodex: () => void; extraActions?: ReactNode; loadImage?: (task: Task, url?: string) => Promise<string | null>;
}) {
  const mobile = useMediaQuery("(max-width: 48em)");
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [annotationPopups, setAnnotationPopups] = useState<Set<string>>(() => new Set());
  const annotationChange = useCallback((id: string, opened: boolean) => {
    setAnnotationPopups(current => {
      if (current.has(id) === opened) return current;
      const next = new Set(current);
      if (opened) next.add(id); else next.delete(id);
      return next;
    });
  }, []);
  const overlayOpen = lightboxOpen || annotationPopups.size > 0;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!opened || task?.observed?.lastTurnEvent !== "inProgress") return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [opened, task?.turnId, task?.observed?.lastTurnEvent]);
  const latestUsage = useAnimatedUsage(task?.sessionUsage?.latest, task?.status === "working", task?.turnId);
  const totalUsage = useAnimatedUsage(task?.sessionUsage?.total, task?.status === "working", task?.id);
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
  const label = task.needsApproval ? "Needs approval" : task.status === "needs_input" || task.status === "interrupted" ? "Waiting for review" : task.status === "working" ? "Running" : task.status === "completed" ? "Done" : task.statusLabel;
  const tokenIncomplete = !!task.sessionUsage && [task.sessionUsage.latest, task.sessionUsage.total].some(value => value.partial);
  const costIncomplete = !!task.sessionUsage && [task.sessionUsage.latest, task.sessionUsage.total].some(value => value.costPartial);
  const content = <Stack gap="md">
    <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs" pr={8}>
      <Group gap="xs" mt={0} className="taskchef-detail-meta">
        <Tooltip label={task.project?.path || "No project"}><Text size="sm" c="dimmed" className="taskchef-detail-project"><IconFolder size={14} /><span>{task.project?.name || "No project"}</span></Text></Tooltip>
        {label && <Badge variant="light" color={task.needsApproval ? "orange" : "gray"}>{label}</Badge>}
        {task.needsAnswer && <Badge variant="light" color="blue">Needs answer</Badge>}
        {task.status === "interrupted" && <Badge variant="light" color="orange">Interrupted</Badge>}
      </Group>
      <Group gap="xs" wrap="nowrap" className="taskchef-detail-actions">
        {extraActions}
        <OpenChatButton loading={busy} onClick={onOpenCodex} taskTitle={task.title} />
      </Group>
    </Group>
    {error && <Alert color="red">{error}</Alert>}
    {mobile && task.needsApproval && <ApprovalPanel task={task} busy={busy} onOpen={onOpenCodex} />}
    <Box className="taskchef-detail-layout">
      <Box className="taskchef-detail-reply">
        {!mobile && task.needsApproval && <ApprovalPanel task={task} busy={busy} onOpen={onOpenCodex} />}
        <TurnContent task={task} loadImage={loadImage} workedDurationMs={duration} onLightboxChange={setLightboxOpen} onAnnotationChange={annotationChange} />
        {task.needsAnswer && <section aria-label="Pending questions" className="taskchef-pending-questions">
          <div className="taskchef-question-header"><IconHelpCircle size={14} aria-hidden /><span>{task.pendingQuestions?.length === 1 ? "Question" : "Questions"}</span></div>
          {(task.pendingQuestions ?? []).map(question => <Box key={question.id} mb="sm">
            <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>{question.title}</Text>
            {question.options.length > 0 && <ol role="list">{question.options.map((option, index) => <li key={index}><span className="taskchef-question-number" aria-hidden>{index + 1}</span><span>{option}</span></li>)}</ol>}
          </Box>)}
          <div className="taskchef-question-footer"><Anchor component="button" type="button" size="sm" disabled={busy} onClick={onOpenCodex}><IconArrowUpRight size={14} aria-hidden />Open chat to answer</Anchor></div>
        </section>}
        <QueuedPrompts task={task} loadImage={loadImage} onLightboxChange={setLightboxOpen} />
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
        <section aria-label="Usage">
          <Title order={5} mb="sm">Usage</Title>
          {task.sessionUsage && (task.sessionUsage.latest.samples > 0 || task.sessionUsage.total.samples > 0) ? <>
          <table className="taskchef-detail-usage"><thead><tr><th /><th scope="col">Tokens{tokenIncomplete && <sup>2</sup>}</th><th scope="col">API-equivalent cost<sup>1{costIncomplete && ",2"}</sup></th></tr></thead><tbody>
            {(["Latest turn", "Total chat"] as const).map((label, i) => {
              const value = i === 0 ? latestUsage! : totalUsage!;
              const raw = i === 0 ? task.sessionUsage!.latest : task.sessionUsage!.total;
              return <tr key={label}><th scope="row">{label}</th>
                <td><Tooltip multiline w={280} label={<TokenBreakdown value={raw} />}><span>{value.samples ? `${value.partial ? "≥" : ""}${compactTokens(value.tokens.total_tokens)}` : "—"}</span></Tooltip></td>
                <td><Tooltip multiline w={280} label={value.costPartial ? "Some usage records or model prices are missing. This is the subtotal for the calls TaskChef can price." : "Estimated from saved calls at standard API prices."}><span>{usageCost(value)}</span></Tooltip></td>
              </tr>;
            })}
          </tbody></table>
          <Text size="xs" c="dimmed" mt={8}><sup>1</sup> Estimates use <Anchor size="xs" href="https://developers.openai.com/api/docs/pricing" target="_blank" rel="noopener noreferrer">OpenAI API pricing</Anchor>. Subscription users are not billed this amount.</Text>
          {[task.sessionUsage.latest, task.sessionUsage.total].some(value => value.partial || value.costPartial) && <Text size="xs" c="dimmed" mt={4}><sup>2</sup> Incomplete estimate: some usage records, turn links, or model prices are missing. Only known usage and prices are included.</Text>}
          </> : <Text size="sm" c="dimmed" role="status">{usageLoading ? "Loading…" : "Usage unavailable."}</Text>}
        </section>
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
    ? <Drawer opened={opened} onClose={onClose} closeOnEscape={!overlayOpen} trapFocus={!overlayOpen} position="bottom" size="92%" title={task.title} classNames={{ content: "taskchef-detail-dialog" }} zIndex={300} scrollAreaComponent={ScrollArea.Autosize}>{content}</Drawer>
    : <Modal opened={opened} onClose={onClose} closeOnEscape={!overlayOpen} trapFocus={!overlayOpen} title={task.title} size={960} centered classNames={{ content: "taskchef-detail-dialog" }} zIndex={300} scrollAreaComponent={ScrollArea.Autosize}>{content}</Modal>;
}

function usageCost(value: SavedUsage) {
  if (!value.samples || (value.costPartial && value.costUsd === 0)) return "—";
  return `${value.costPartial ? "≥" : ""}$${value.costUsd.toFixed(2)}`;
}

function ActivityRow({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <Text size="sm" className="taskchef-detail-activity-row"><span aria-hidden>{icon}</span><span>{children}</span></Text>;
}
function TechnicalField({ label, value }: { label: string; value: string }) {
  return <Box className="taskchef-detail-field"><Text size="xs" c="dimmed">{label}</Text><Text size="sm" className="taskchef-detail-id">{value}</Text></Box>;
}
