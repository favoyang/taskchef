import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { fixtureTask } from "../../ui/fixtures";
import { NextTaskDetail } from "./NextTaskDetail";

afterEach(cleanup);
test("details show ordered PRs, one access alert per repo, and useful collapsed fields", () => {
  const task = { ...fixtureTask(), replyExcerpt: "The **update** is ready.", relatedGitHubLinks: [], inputSource: "ordinary" as const,
    observed: { archive: false, source: "vscode", lastTurnEvent: "completed", lastTurnEventAt: null, recentFileActivity: false, latestTurnDurationMs: 480000, recordedChatDurationMs: 1200000, directChildCount: 155 },
    detailPullRequests: [
      { url: "https://github.com/example/repo/pull/3", title: "Latest change", state: "open" as const, checks: "passed" as const },
      { url: "https://github.com/example/repo/pull/2", title: "Older change", state: "unknown" as const, checks: "unknown" as const, accessIssue: "denied" as const },
      { url: "https://github.com/example/other/pull/1", title: "Other repo", state: "unknown" as const, checks: "unknown" as const, accessIssue: "denied" as const },
    ] };
  render(<MantineProvider><NextTaskDetail task={task} opened busy={false} error={null} onClose={() => {}} onOpenCodex={() => {}} /></MantineProvider>);
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
  expect(screen.queryByRole("button", {name: "Chat actions"})).toBeNull();
  expect(screen.queryByRole("button", {name: "Copy Chat ID"})).toBeNull();
});


test("a missing older PR keeps its warning after that PR rather than the accessible latest PR", () => {
  const task = { ...fixtureTask(), relatedGitHubLinks: [], detailPullRequests: [
    { url: "https://github.com/example/repo/pull/3", title: "Accessible latest", state: "open" as const, checks: "passed" as const },
    { url: "https://github.com/example/repo/pull/2", title: "Missing older", state: "unknown" as const, checks: "unknown" as const, accessIssue: "not_found" as const },
  ] };
  render(<MantineProvider><NextTaskDetail task={task} opened busy={false} error={null} onClose={() => {}} onOpenCodex={() => {}} /></MantineProvider>);
  expect(within(screen.getByRole("region", { name: "Pull requests" })).getAllByRole("link").map(link => link.textContent)).toEqual(["#3 Accessible latest", "#2 Missing older", "Check access"]);
});


test("running details use Worked for rather than the finished-turn label", () => {
  const task = { ...fixtureTask(), observed: { archive: false, lastTurnEvent: "inProgress", lastTurnEventAt: new Date(Date.now()-120000).toISOString(), recentFileActivity: true, recordedChatDurationMs: 180000 } };
  render(<MantineProvider><NextTaskDetail task={task} opened busy={false} error={null} onClose={()=>{}} onOpenCodex={()=>{}} /></MantineProvider>);
  expect(screen.getByText("Worked for 2m")).toBeVisible();
  expect(screen.getByText("Total chat worked for 5m")).toBeVisible();
  expect(screen.queryByText(/Latest turn worked for/)).toBeNull();
});

test("usage keeps later-turn tokens visible when historical cost is partial", () => {
  const latest = {tokens: {input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 5, total_tokens: 110}, costUsd: 0.2, samples: 1, partial: false, costPartial: false};
  const task = {...fixtureTask(), status: "needs_input" as const, sessionUsage: {latest, total: {...latest,tokens: {...latest.tokens,total_tokens: 10000},costUsd: 3.2, partial: true,costPartial: true}, subagents: 3, pricingDate: "2026-10-10"}};
  render(<MantineProvider><NextTaskDetail task={task} opened busy={false} error={null} onClose={()=>{}} onOpenCodex={()=>{}} /></MantineProvider>);
  const usage=screen.getByRole("region",{name:"Usage"});
  expect(within(usage).getByText("Total chat")).toBeVisible();
  expect(within(usage).getByRole("link", {name: "OpenAI API pricing"})).toHaveAttribute("href", "https://developers.openai.com/api/docs/pricing");
  expect(within(usage).queryByText(/Includes 3 subagents/)).toBeNull();
  expect(within(usage).getByText("110")).toBeVisible();
  expect(within(usage).getByText("≥10.00K")).toBeVisible();
  expect(within(usage).getByRole("columnheader", {name:"Tokens 2"})).toBeVisible();
  expect(within(usage).getByRole("columnheader", {name:"API-equivalent cost 1,2"})).toBeVisible();
  expect(within(usage).getByText("$0.20")).toBeVisible();
  expect(within(usage).getByText("≥$3.20")).toBeVisible();
  expect(within(usage).getByText(/Incomplete estimate:/)).toBeVisible();
});

test("detail header keeps Open chat and Done without the old action menu", () => {
  const open=vi.fn();
  render(<MantineProvider><NextTaskDetail task={fixtureTask()} opened busy={false} error={null} onClose={()=>{}} onOpenCodex={open} extraActions={<button>Mark Done</button>} /></MantineProvider>);
  fireEvent.click(screen.getByRole("button", {name: /^Open chat for/}));
  expect(open).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", {name: "Mark Done"})).toBeVisible();
  expect(screen.queryByRole("button", {name: "Chat actions"})).toBeNull();
});

test("unpriced usage marks the cost label with the incomplete footnote", () => {
  const value={tokens:{input_tokens:10,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:1,reasoning_output_tokens:0,total_tokens:11},samples:1,costUsd:0,costPartial:true,partial:false};
  const task={...fixtureTask(),sessionUsage:{latest:value,total:value,subagents:0,pricingDate:"2026-10-10"}};
  render(<MantineProvider><NextTaskDetail task={task} opened busy={false} error={null} onClose={()=>{}} onOpenCodex={()=>{}} /></MantineProvider>);
  expect(within(screen.getByRole("region",{name:"Usage"})).getAllByText("—")).toHaveLength(2);
});


test("Usage stays visible while loading and when data is unavailable", () => {
 const props={task:fixtureTask(),opened:true,busy:false,error:null,onClose:()=>{},onOpenCodex:()=>{}};
 const view=render(<MantineProvider><NextTaskDetail {...props} usageLoading /></MantineProvider>);
 const section=screen.getByRole("region",{name:"Usage"});
 expect(within(section).getByRole("heading",{name:"Usage"})).toBeVisible();
 expect(within(section).getByRole("status")).toHaveTextContent("Loading…");
 view.rerender(<MantineProvider><NextTaskDetail {...props} usageLoading={false} /></MantineProvider>);
 expect(screen.getByRole("region",{name:"Usage"})).toBe(section);
 expect(within(section).getByRole("status")).toHaveTextContent("Usage unavailable.");
 const value={tokens:{input_tokens:100,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:10,reasoning_output_tokens:0,total_tokens:110},samples:1,costUsd:0.1,costPartial:false,partial:false};
 view.rerender(<MantineProvider><NextTaskDetail {...props} task={{...props.task,sessionUsage:{latest:value,total:value,subagents:0,pricingDate:"2026-10-10"}}} /></MantineProvider>);
 expect(screen.getByRole("region",{name:"Usage"})).toBe(section);
 expect(within(section).getByRole("table")).toBeVisible();
 expect(within(section).queryByRole("status")).toBeNull();
});


test("a resolved usage read with zero samples is unavailable", () => {
 const empty={tokens:{input_tokens:0,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:0,reasoning_output_tokens:0,total_tokens:0},samples:0,costUsd:0,costPartial:true,partial:true};
 render(<MantineProvider><NextTaskDetail task={{...fixtureTask(),sessionUsage:{latest:empty,total:empty,subagents:0,pricingDate:"2026-10-10"}}} opened busy={false} error={null} onClose={()=>{}} onOpenCodex={()=>{}} /></MantineProvider>);
 const usage=screen.getByRole("region",{name:"Usage"});expect(within(usage).getByRole("status")).toHaveTextContent("Usage unavailable.");expect(within(usage).queryByRole("table")).toBeNull();
});

test('Needs answer adds an open-chat action without replacing the saved prompt or response', () => {
 const open=vi.fn();
 const task={...fixtureTask(),needsAnswer:true,pendingQuestions:[{id:'question',title:'May I retry the scan?',options:['Retry once','Stop']}],promptText:'Run the scan.',replyText:'The connection failed. Approval requested.'};
 render(<MantineProvider><NextTaskDetail task={task} opened busy={false} error={null} onClose={()=>{}} onOpenCodex={open}/></MantineProvider>);
 expect(screen.getByText('Needs answer')).toBeInTheDocument();
 const questions=screen.getByRole('region',{name:'Pending questions'});
 expect(within(questions).getByText('May I retry the scan?')).toBeVisible();
 expect(within(questions).getAllByRole('listitem').map(item=>item.textContent)).toEqual(['1Retry once','2Stop']);
 expect(within(questions).getByRole('button',{name:'Open chat to answer'})).toBeVisible();
 expect(screen.getByText('Run the scan.')).toBeInTheDocument();
 expect(screen.getByText('The connection failed. Approval requested.')).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Open chat to answer'}));expect(open).toHaveBeenCalledTimes(1);
});

test("interrupted details show the recorded error after the response and clear it on recovery", () => {
  const task = { ...fixtureTask(), status: "interrupted" as const, turnError: "Selected model is at capacity. Please try a different model.", replyText: "Progress before the error." };
  const props = { opened: true, busy: false, error: null, onClose: () => {}, onOpenCodex: () => {} };
  const { rerender } = render(<MantineProvider><NextTaskDetail {...props} task={task} /></MantineProvider>);
  const notice = screen.getByLabelText("Latest turn error");
  expect(notice).toHaveTextContent(task.turnError);
  expect(notice).toHaveClass("taskchef-turn-error");
  expect(screen.getByLabelText("Latest turn response").compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  rerender(<MantineProvider><NextTaskDetail {...props} task={{ ...task, replyText: null, replyExcerpt: null }} /></MantineProvider>);
  expect(screen.getByLabelText("Latest turn error")).toBeVisible();
  rerender(<MantineProvider><NextTaskDetail {...props} task={{ ...task, status: "working" }} /></MantineProvider>);
  expect(screen.queryByLabelText("Latest turn error")).toBeNull();
});
