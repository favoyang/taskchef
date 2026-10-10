import { PrOpenIcon, PrStatusIcon, PrDraftIcon, PrMergedIcon, PrClosedIcon } from "./PrGlyph";
import { Anchor, Box, Popover, Stack, Text, VisuallyHidden } from "@mantine/core";
import { IconAlertTriangle, IconHourglass, IconRobot, IconCircleCheck, IconCircleX, IconLoader, IconMinus, IconClock, IconChartBar } from "@tabler/icons-react";
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { formatWorkedDuration } from "../../time.js";
import { turnUsageLabel } from "./SavedUsageFormat";
import type { SavedUsage, PullRequestStatus } from "../types";

export function nextRunLabel(value?: string | null, now = new Date()) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return "Next run time unavailable";
  const date = new Date(value);
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  const day = date.toDateString() === now.toDateString() ? "Today" : date.toDateString() === tomorrow.toDateString() ? "Tomorrow"
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
  return `Next run: ${day} at ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

export function prPresentation(pr: PullRequestStatus) {
  if (pr.state === "merged") return { Icon: PrMergedIcon, color: "#b28bdf", dot: null, label: "Merged" };
  if (pr.state === "closed") return { Icon: PrClosedIcon, color: "#f0787e", dot: null, label: "Closed, not merged" };
  if (pr.state === "draft") return { Icon: PrDraftIcon, color: "var(--taskchef-muted)", dot: null, label: "Draft" };
  if (pr.accessIssue && pr.state === "unknown") return { Icon: IconAlertTriangle, color: "#eac54f", dot: null, label: "Repository access needed" };
  if (pr.state === "unknown") return { Icon: PrOpenIcon, color: "var(--taskchef-muted)", dot: null, label: "PR status not checked or unavailable" };
  if (pr.hasMergeConflicts || pr.checks === "failed") return { Icon: PrStatusIcon, color: "var(--taskchef-muted)", dot: "#e56b6f", label: pr.hasMergeConflicts ? "Merge conflicts" : "Checks failed" };
  if (pr.canMerge || pr.checks === "passed") return { Icon: PrStatusIcon, color: "var(--taskchef-muted)", dot: "#39c681", label: pr.canMerge ? "Ready to merge" : "Checks passed" };
  return { Icon: PrStatusIcon, color: "var(--taskchef-muted)", dot: "#eac54f", label: pr.checks === "none" ? "No checks" : pr.checks === "pending" ? "Checks pending" : "Open PR" };
}

export function PullRequestIcons({ pullRequests = [] }: { pullRequests?: PullRequestStatus[] }) {
  return <Box className="taskchef-card-pr-icons">{pullRequests.map(pr => {
    const { Icon, color, dot, label } = prPresentation(pr);
    return <span key={pr.url} className="taskchef-card-status-icon" aria-label={`${prTitle(pr)}: ${label}`} style={{ color, "--taskchef-pr-dot-color": dot ?? "currentColor" } as CSSProperties}>
      <Icon size={15} stroke={1.5} aria-hidden />
      {pr.accessIssue && pr.state !== "unknown" && <IconAlertTriangle className="taskchef-pr-access-warning" size={10} aria-hidden />}
    </span>;
  })}</Box>;
}

export function CardStatusLine({ children, pullRequests = [], scheduled, nextRunAt, durationMs, startedAt, subagentCount, turnUsage }: {
  subagentCount?: number;
  turnUsage?: SavedUsage;
  children: ReactNode;
  pullRequests?: PullRequestStatus[];
  scheduled?: boolean;
  nextRunAt?: string | null;
  durationMs?: number | null;
  startedAt?: string | null;
}) {
  const descriptionId = useId();
  const [opened, setOpened] = useState(false);
  const [now, setNow] = useState(Date.now);
  const start = startedAt ? Date.parse(startedAt) : NaN;
  const running = Number.isFinite(start);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const tick = window.setInterval(() => setNow(Date.now()), 60000);
    return () => window.clearInterval(tick);
  }, [running, startedAt]);
  const duration = formatWorkedDuration(running ? Math.max(0, now - start) : durationMs);
  const hasNextRun = scheduled && !!nextRunAt && Number.isFinite(Date.parse(nextRunAt));
  const hasSubagents = Number.isInteger(subagentCount) && (subagentCount ?? 0) > 0;
  const hasUsage = !!turnUsage?.samples;
  const hasInfo = hasUsage || duration !== "—" || pullRequests.length > 0 || hasNextRun || hasSubagents;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const target = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  function show() { if (timer.current) clearTimeout(timer.current); if (hasInfo) { setNow(Date.now()); setOpened(true); } }
  function leave() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!target.current?.contains(document.activeElement) && !popup.current?.contains(document.activeElement)) setOpened(false);
    }, 180);
  }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => { if (!hasInfo) setOpened(false); }, [hasInfo]);
  return <Popover opened={opened && hasInfo} onChange={setOpened} position="top" withArrow withinPortal width={300} zIndex={400}>
    <Popover.Target>
      <Box ref={target} className="taskchef-card-stats" tabIndex={hasInfo ? 0 : undefined} aria-label="Turn status details" aria-describedby={pullRequests.length ? descriptionId : undefined}
        onMouseEnter={show} onMouseLeave={leave} onFocus={show} onBlur={leave} onClick={show}
        onKeyDown={event => {
          if (event.key === "Escape") { setOpened(false); event.stopPropagation(); }
          if (event.key === "Tab" && !event.shiftKey && opened && popup.current?.querySelector("a")
            && (event.target !== target.current || !target.current?.querySelector('button:not(:disabled), [tabindex="0"]'))) {
            event.preventDefault(); popup.current.querySelector("a")?.focus();
          }
        }}>
        {children}
        {hasUsage && <span className="taskchef-card-turn-usage">{turnUsageLabel(turnUsage!)}</span>}
        {scheduled && <span className="taskchef-card-status-icon" aria-label="Active schedule"><IconClock className="taskchef-schedule-clock" size={15} stroke={1.5} aria-hidden /></span>}
        <PullRequestIcons pullRequests={pullRequests} />
        {pullRequests.length > 0 && <VisuallyHidden id={descriptionId}>{pullRequests.map(pr => `${prTitle(pr)}: ${pr.state === "merged" ? "Merged" : pr.state === "closed" ? "Closed, not merged" : pr.state === "draft" ? "Draft" : pr.state === "unknown" ? "PR status not checked or unavailable" : pr.hasMergeConflicts ? "Open, merge conflicts" : "Open"}`).join(". ")}</VisuallyHidden>}
      </Box>
    </Popover.Target>
    <Popover.Dropdown className="taskchef-status-tooltip" p={9} ref={popup} onMouseEnter={show} onMouseLeave={leave} onFocus={show} onBlur={leave}
      onKeyDown={event => { if (event.key === "Escape") { setOpened(false); target.current?.focus(); setOpened(false); event.stopPropagation(); } }}>
      <Stack gap={5}>
        {duration !== "—" && <StatusRow icon={<IconHourglass size={15} stroke={1.5} />}>Worked for {duration}</StatusRow>}
        {hasUsage && <StatusRow icon={<IconChartBar size={15} stroke={1.5} />}>Turn usage: {turnUsageLabel(turnUsage!)}</StatusRow>}
        {pullRequests.map(pr => <PullRequestInfo key={pr.url} pr={pr} showChecks={false} />)}
        {hasNextRun && <StatusRow icon={<IconClock className="taskchef-schedule-clock" size={15} stroke={1.5} />}>{nextRunLabel(nextRunAt)}</StatusRow>}
        {hasSubagents && <StatusRow icon={<IconRobot size={15} stroke={1.5} />}>{subagentCount} {subagentCount === 1 ? "subagent" : "subagents"}</StatusRow>}
      </Stack>
    </Popover.Dropdown>
  </Popover>;
}

function prTitle(pr: PullRequestStatus) {
  const number = pr.url.match(/\/pull\/(\d+)/)?.[1];
  const title = pr.title || pr.url.match(/github\.com\/(.+)\/pull\/\d+/)?.[1] || "Pull request";
  return `${number ? `#${number} ` : ""}${title}`;
}

function StatusRow({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <Box className="taskchef-status-row"><span className="taskchef-status-row-icon" aria-hidden>{icon}</span><Box className="taskchef-status-row-content">{children}</Box></Box>;
}

export function PullRequestInfo({ pr, showAccess = true, showChecks = true }: { pr: PullRequestStatus; showAccess?: boolean; showChecks?: boolean }) {
  const title = prTitle(pr);
  const safeLink = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*\/?$/.test(pr.url);
  const { Icon, color, dot } = prPresentation(pr);
  const CiIcon = pr.checks === "passed" ? IconCircleCheck : pr.checks === "failed" ? IconCircleX : pr.checks === "pending" ? IconLoader : IconMinus;
  const repo = safeLink ? pr.url.match(/github\.com\/(.+)\/pull\//)?.[1] : null;
  return <Stack gap={5}>
    <StatusRow icon={<span className="taskchef-popup-pr-icon" style={{ color, "--taskchef-pr-dot-color": dot ?? "currentColor" } as CSSProperties}><Icon size={15} stroke={1.5} /></span>}>
      {safeLink ? <Anchor className="taskchef-status-pr-title" href={pr.url} target="_blank" rel="noopener noreferrer" title={title}>{title}</Anchor> : <Text className="taskchef-status-pr-title">{title}</Text>}
    </StatusRow>
    {showChecks && pr.checks !== "unknown" && <StatusRow icon={<CiIcon size={15} stroke={1.5} />}>{pr.checks === "passed" ? "CI passed" : pr.checks === "failed" ? "CI failed" : pr.checks === "pending" ? "CI pending" : "No CI checks"}</StatusRow>}
    {showAccess && pr.accessIssue && safeLink && <Box className="taskchef-pr-access-alert">
      <StatusRow icon={null}><Text size="xs">{pr.accessIssue === "denied" ? `Access denied to ${repo}.` : `PR #${pr.url.match(/\/pull\/(\d+)/)?.[1]} is unavailable. It may be private or removed.`} <Anchor size="xs" href="https://github.com/apps/taskchef/installations/new" target="_blank" rel="noopener noreferrer">{pr.accessIssue === "denied" ? "Grant access" : "Check access"}</Anchor></Text></StatusRow>
    </Box>}
  </Stack>;
}
