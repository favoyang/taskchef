import { Badge, Group } from "@mantine/core";
import { IconGitMerge, IconGitPullRequest, IconGitPullRequestDraft } from "@tabler/icons-react";
import type { PullRequestStatus } from "../types";

export function PullRequestBadges({ pullRequests = [] }: { pullRequests?: PullRequestStatus[] }) {
  if (!pullRequests.length) return null;
  return <Group gap={4} wrap="wrap" aria-label="Attached pull requests">
    {pullRequests.map((pr) => {
      const merged = pr.state === "merged";
      const draft = pr.state === "draft";
      const label = merged ? "Merged" : draft ? "Draft" : pr.state === "closed" ? "Closed, not merged" : pr.state === "unknown" ? "Status unavailable" : pr.checks === "passed" ? "Checks passed" : pr.checks === "none" ? "No checks" : pr.checks === "pending" ? "Checks pending" : pr.checks === "failed" ? "Checks failed" : "Checks unavailable";
      const Icon = merged ? IconGitMerge : draft ? IconGitPullRequestDraft : IconGitPullRequest;
      const color = merged ? "violet" : draft || pr.state === "unknown" ? "gray" : pr.state === "closed" || pr.checks === "failed" ? "red" : pr.checks === "passed" ? "green" : "yellow";
      const safeLink = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*\/?$/.test(pr.url);
      return <Badge key={pr.url} component="a" href={safeLink ? pr.url : undefined} target="_blank" rel="noopener noreferrer" variant="light" color={color} size="xs" leftSection={<Icon size={12} aria-hidden />} title={`${pr.url}\n${label}${pr.error ? `: ${pr.error}` : ""}${pr.checkedAt ? `\nChecked ${new Date(pr.checkedAt).toLocaleString()}` : ""}`} style={{ cursor: "pointer", textTransform: "none", maxWidth: "100%" }}>#{pr.url.match(/\/pull\/(\d+)/)?.[1] ?? "PR"} · {label}</Badge>;
    })}
  </Group>;
}
