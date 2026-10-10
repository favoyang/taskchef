import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { fixtureTask } from "../../dashboard/react/fixtures";
import { NextTaskDetail } from "./NextTaskDetail";

afterEach(cleanup);
test("details show ordered PRs, one access alert per repo, and useful collapsed fields", () => {
  const copy = vi.fn();
  const task = { ...fixtureTask(), replyExcerpt: "The **update** is ready.", relatedGitHubLinks: [], inputSource: "ordinary" as const,
    observed: { archive: false, source: "vscode", lastTurnEvent: "completed", lastTurnEventAt: null, recentFileActivity: false, latestTurnDurationMs: 480000, recordedChatDurationMs: 1200000, directChildCount: 155 },
    detailPullRequests: [
      { url: "https://github.com/example/repo/pull/3", title: "Latest change", state: "open" as const, checks: "passed" as const },
      { url: "https://github.com/example/repo/pull/2", title: "Older change", state: "unknown" as const, checks: "unknown" as const, accessIssue: "denied" as const },
      { url: "https://github.com/example/other/pull/1", title: "Other repo", state: "unknown" as const, checks: "unknown" as const, accessIssue: "denied" as const },
    ] };
  render(<MantineProvider><NextTaskDetail task={task} opened busy={false} error={null} onClose={() => {}} onCopy={copy} onOpenCodex={() => {}} onArchive={() => {}} /></MantineProvider>);
  const prs = screen.getByRole("region", { name: "Pull requests" });
  expect(within(prs).getAllByRole("link").map(link => link.textContent)).toEqual(["#3 Latest change", "Grant access", "#2 Older change", "#1 Other repo", "Grant access"]);
  expect(screen.getByRole("region", { name: "Activity" }).compareDocumentPosition(prs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByText("Latest turn worked for 8m")).toBeVisible();
  expect(screen.getByText("Total chat worked for 20m")).toBeVisible();
  expect(within(prs).queryByText("CI passed")).toBeNull();
  expect(screen.getByRole("dialog", { name: task.title })).toBeVisible();
  expect(screen.getAllByText(task.title)).toHaveLength(1);
  expect(screen.getByText("155 subagents")).toBeVisible();
  expect(screen.queryByText("Latest saved reply (excerpt)")).toBeNull();
  const details = screen.getByText("Technical details").closest("details")!;
  expect(details.open).toBe(false);
  fireEvent.click(screen.getByText("Technical details"));
  expect(within(details).getByText("Desktop")).toBeVisible();
  expect(within(details).getByText("Human")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Copy Chat ID" }));
  expect(copy).toHaveBeenCalledWith(task.id);
});


test("a missing older PR keeps its warning after that PR rather than the accessible latest PR", () => {
  const task = { ...fixtureTask(), relatedGitHubLinks: [], detailPullRequests: [
    { url: "https://github.com/example/repo/pull/3", title: "Accessible latest", state: "open" as const, checks: "passed" as const },
    { url: "https://github.com/example/repo/pull/2", title: "Missing older", state: "unknown" as const, checks: "unknown" as const, accessIssue: "not_found" as const },
  ] };
  render(<MantineProvider><NextTaskDetail task={task} opened busy={false} error={null} onClose={() => {}} onCopy={() => {}} onOpenCodex={() => {}} onArchive={() => {}} /></MantineProvider>);
  expect(within(screen.getByRole("region", { name: "Pull requests" })).getAllByRole("link").map(link => link.textContent)).toEqual(["#3 Accessible latest", "#2 Missing older", "Check access"]);
});


test("running details use Worked for rather than the finished-turn label", () => {
  const task = { ...fixtureTask(), observed: { archive: false, lastTurnEvent: "inProgress", lastTurnEventAt: new Date(Date.now()-120000).toISOString(), recentFileActivity: true, recordedChatDurationMs: 180000 } };
  render(<MantineProvider><NextTaskDetail task={task} opened busy={false} error={null} onClose={()=>{}} onCopy={()=>{}} onOpenCodex={()=>{}} onArchive={()=>{}} /></MantineProvider>);
  expect(screen.getByText("Worked for 2m")).toBeVisible();
  expect(screen.getByText("Total chat worked for 5m")).toBeVisible();
  expect(screen.queryByText(/Latest turn worked for/)).toBeNull();
});
