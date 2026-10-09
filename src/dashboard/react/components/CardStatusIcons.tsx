import { Anchor, Box, Popover, Stack, Text, Tooltip } from "@mantine/core";
import { IconClock, IconGitMerge, IconGitPullRequest, IconGitPullRequestClosed, IconGitPullRequestDraft } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import type { PullRequestStatus } from "../types";

export function nextRunLabel(value?: string | null, now = new Date()) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return "Next run time unavailable";
  const date = new Date(value);
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  const day = date.toDateString() === now.toDateString() ? "Today" : date.toDateString() === tomorrow.toDateString() ? "Tomorrow"
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
  return `Next run: ${day} at ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

export function ScheduleIcon({ nextRunAt }: { nextRunAt?: string | null }) {
  const label = nextRunLabel(nextRunAt);
  return <Tooltip label={label} classNames={{ tooltip: "taskchef-status-tooltip" }} events={{ hover: true, focus: true, touch: false }} withArrow>
    <span className="taskchef-card-status-icon" tabIndex={0} aria-label={label}><IconClock size={15} stroke={1.5} aria-hidden /></span>
  </Tooltip>;
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

function PullRequestIcon({ pr }: { pr: PullRequestStatus }) {
  const { Icon, color, dot, label } = prPresentation(pr);
  const [opened, setOpened] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const target = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const title = prTitle(pr);
  function show() { if (timer.current) clearTimeout(timer.current); setOpened(true); }
  function leave() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!target.current?.contains(document.activeElement) && !popup.current?.contains(document.activeElement)) setOpened(false);
    }, 180);
  }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return <Popover opened={opened} onChange={setOpened} position="top" withArrow withinPortal width={290} zIndex={400}>
    <Popover.Target>
      <button ref={target} type="button" className="taskchef-card-status-icon" aria-label={`${title}: ${label}`} onMouseEnter={show} onMouseLeave={leave} onFocus={show} onBlur={leave} onClick={show} onKeyDown={event => { if (event.key === "Tab" && !event.shiftKey && opened && popup.current?.querySelector("a")) { event.preventDefault(); popup.current.querySelector("a")?.focus(); } }} style={{ color }}>
        <Icon size={15} stroke={1.5} aria-hidden />
        {dot && <span className="taskchef-pr-dot" style={{ background: dot }} />}
      </button>
    </Popover.Target>
    <Popover.Dropdown ref={popup} onMouseEnter={show} onMouseLeave={leave} onFocus={show} onBlur={leave}>
      <PullRequestInfo pr={pr} />
    </Popover.Dropdown>
  </Popover>;
}

export function PullRequestIcons({ pullRequests = [] }: { pullRequests?: PullRequestStatus[] }) {
  return <Box className="taskchef-card-pr-icons">{pullRequests.map(pr => <PullRequestIcon key={pr.url} pr={pr} />)}</Box>;
}

function prTitle(pr: PullRequestStatus) {
  return pr.title || `${pr.url.match(/github\.com\/(.+)\/pull\/(\d+)/)?.[1] ?? "Pull request"} #${pr.url.match(/\/pull\/(\d+)/)?.[1] ?? ""}`;
}

export function PullRequestInfo({ pr }: { pr: PullRequestStatus }) {
  const { label } = prPresentation(pr);
  const title = prTitle(pr);
  const safeLink = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*\/?$/.test(pr.url);
  return <Stack gap={5}>
        {safeLink ? <Anchor href={pr.url} target="_blank" rel="noopener noreferrer" size="sm">{title}</Anchor> : <Text size="sm">{title}</Text>}
        <Text size="xs" c="dimmed">{label}{` · ${pr.checks === "passed" ? "CI passed" : pr.checks === "failed" ? "CI failed" : pr.checks === "pending" ? "CI pending" : pr.checks === "none" ? "No CI checks" : "CI status unknown"}`}</Text>
        {pr.error && <Text size="xs" c="dimmed">{pr.error}</Text>}
        {pr.checkedAt && <Text size="xs" c="dimmed">Checked {new Date(pr.checkedAt).toLocaleString()}</Text>}
      </Stack>;
}
