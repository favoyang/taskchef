import { Anchor, Box, Popover, Stack, Text, VisuallyHidden } from "@mantine/core";
import { IconClock, IconGitMerge, IconGitPullRequest, IconGitPullRequestClosed, IconGitPullRequestDraft } from "@tabler/icons-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { formatWorkedDuration } from "../../time.js";
import type { PullRequestStatus } from "../types";

export function nextRunLabel(value?: string | null, now = new Date()) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return "Next run time unavailable";
  const date = new Date(value);
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  const day = date.toDateString() === now.toDateString() ? "Today" : date.toDateString() === tomorrow.toDateString() ? "Tomorrow"
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
  return `Next run: ${day} at ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

export function prPresentation(pr: PullRequestStatus) {
  if (pr.state === "merged") return { Icon: IconGitMerge, color: "#b28bdf", dot: null, label: "Merged" };
  if (pr.state === "closed") return { Icon: IconGitPullRequestClosed, color: "#f0787e", dot: null, label: "Closed, not merged" };
  if (pr.state === "draft") return { Icon: IconGitPullRequestDraft, color: "var(--taskchef-muted)", dot: null, label: "Draft" };
  if (pr.state === "unknown") return { Icon: IconGitPullRequest, color: "var(--taskchef-muted)", dot: null, label: "PR status not checked or unavailable" };
  if (pr.hasMergeConflicts || pr.checks === "failed") return { Icon: IconGitPullRequest, color: "var(--taskchef-muted)", dot: "#e56b6f", label: pr.hasMergeConflicts ? "Merge conflicts" : "Checks failed" };
  if (pr.canMerge || pr.checks === "passed") return { Icon: IconGitPullRequest, color: "var(--taskchef-muted)", dot: "#39c681", label: pr.canMerge ? "Ready to merge" : "Checks passed" };
  return { Icon: IconGitPullRequest, color: "var(--taskchef-muted)", dot: "#eac54f", label: pr.checks === "none" ? "No checks" : pr.checks === "pending" ? "Checks pending" : "Open PR" };
}

export function PullRequestIcons({ pullRequests = [] }: { pullRequests?: PullRequestStatus[] }) {
  return <Box className="taskchef-card-pr-icons">{pullRequests.map(pr => {
    const { Icon, color, dot, label } = prPresentation(pr);
    return <span key={pr.url} className="taskchef-card-status-icon" aria-label={`${prTitle(pr)}: ${label}`} style={{ color }}>
      <Icon size={15} stroke={1.5} aria-hidden />
      {dot && <span className="taskchef-pr-dot" style={{ background: dot }} />}
    </span>;
  })}</Box>;
}

export function CardStatusLine({ children, pullRequests = [], scheduled, nextRunAt, durationMs, startedAt }: {
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
  const hasInfo = duration !== "—" || pullRequests.length > 0 || hasNextRun;
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
        {scheduled && <span className="taskchef-card-status-icon" aria-label="Active schedule"><IconClock size={15} stroke={1.5} aria-hidden /></span>}
        <PullRequestIcons pullRequests={pullRequests} />
        {pullRequests.length > 0 && <VisuallyHidden id={descriptionId}>{pullRequests.map(pr => `${prTitle(pr)}: ${pr.state === "merged" ? "Merged" : pr.state === "closed" ? "Closed, not merged" : pr.state === "draft" ? "Draft" : pr.state === "unknown" ? "PR status not checked or unavailable" : pr.hasMergeConflicts ? "Open, merge conflicts" : "Open"}`).join(". ")}</VisuallyHidden>}
      </Box>
    </Popover.Target>
    <Popover.Dropdown ref={popup} onMouseEnter={show} onMouseLeave={leave} onFocus={show} onBlur={leave}
      onKeyDown={event => { if (event.key === "Escape") { setOpened(false); target.current?.focus(); setOpened(false); event.stopPropagation(); } }}>
      <Stack gap={5}>
        {duration !== "—" && <Text size="sm">Worked for {duration}</Text>}
        {pullRequests.map(pr => <PullRequestInfo key={pr.url} pr={pr} />)}
        {hasNextRun && <Text size="sm">{nextRunLabel(nextRunAt)}</Text>}
      </Stack>
    </Popover.Dropdown>
  </Popover>;
}

function prTitle(pr: PullRequestStatus) {
  return pr.title ? `${pr.title} #${pr.url.match(/\/pull\/(\d+)/)?.[1] ?? ""}`.trim() : `${pr.url.match(/github\.com\/(.+)\/pull\/(\d+)/)?.[1] ?? "Pull request"} #${pr.url.match(/\/pull\/(\d+)/)?.[1] ?? ""}`;
}

export function PullRequestInfo({ pr }: { pr: PullRequestStatus }) {
  const title = prTitle(pr);
  const safeLink = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*\/?$/.test(pr.url);
  return <Stack gap={5}>
        {safeLink ? <Anchor href={pr.url} target="_blank" rel="noopener noreferrer" size="sm">{title}</Anchor> : <Text size="sm">{title}</Text>}
        {pr.checks !== "unknown" && <Text size="xs" c="dimmed">{pr.checks === "passed" ? "CI passed" : pr.checks === "failed" ? "CI failed" : pr.checks === "pending" ? "CI pending" : "No CI checks"}</Text>}
      </Stack>;
}
