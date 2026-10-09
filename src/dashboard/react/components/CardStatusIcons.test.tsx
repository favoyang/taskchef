import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { nextRunLabel, prPresentation, PullRequestIcons, PullRequestInfo, CardStatusLine } from "./CardStatusIcons";
import type { PullRequestStatus } from "../types";
// Test TaskChef's rows and keyboard handlers without jsdom layout work.
// Browser QA separately exercises Mantine's real popup and positioning.
vi.mock("@mantine/core", async () => {
  const actual = await vi.importActual<typeof import("@mantine/core")>("@mantine/core");
  const React = await import("react");
  const Open = React.createContext(false);
  const Popover = Object.assign(
    ({opened, children}: {opened: boolean; children: React.ReactNode}) => <Open value={opened}>{children}</Open>,
    {
      Target: ({children}: {children: React.ReactNode}) => children,
      Dropdown: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>((props, ref) =>
        React.useContext(Open) ? <div {...props} ref={ref} /> : null),
    },
  );
  return {...actual, Popover};
});

afterEach(cleanup);
const url="https://github.com/example/repo/pull/12";
const pr:PullRequestStatus={url,state:"open",checks:"passed",title:"Improve search"};
test("cards keep PR status in an accessible icon without extra text",()=>{
  render(<MantineProvider><PullRequestIcons pullRequests={[pr,{...pr,url:"https://github.com/example/repo/pull/13",state:"unknown"}]}/></MantineProvider>);
  expect(screen.getByLabelText("Improve search #12: Checks passed")).toBeInTheDocument();
  expect(screen.getByLabelText("Improve search #13: PR status not checked or unavailable")).toBeInTheDocument();
  expect(screen.queryByText(/unavailable/)).not.toBeInTheDocument();
});
test("PR presentation follows Codex priority for drafts, conflicts, CI and merge readiness",()=>{
  expect(prPresentation({...pr,state:"draft",checks:"failed"}).dot).toBeNull();
  expect(prPresentation({...pr,hasMergeConflicts:true}).label).toBe("Merge conflicts");
  expect(prPresentation({...pr,canMerge:true}).label).toBe("Ready to merge");
  expect(prPresentation({...pr,checks:"pending"}).label).toBe("Checks pending");
  expect(prPresentation({...pr,state:"merged",checks:"failed"}).label).toBe("Merged");
});
test("next run uses Today and Tomorrow and never invents missing times",()=>{
  const now=new Date(2026,9,10,10);
  expect(nextRunLabel(new Date(2026,9,10,15).toISOString(),now)).toMatch(/^Next run: Today at /);
  expect(nextRunLabel(new Date(2026,9,11,9).toISOString(),now)).toMatch(/^Next run: Tomorrow at /);
  expect(nextRunLabel(null,now)).toBe("Next run time unavailable");
});


test("popup content keeps CI for merged and unknown PRs and links only supported URLs",()=>{
  const {rerender}=render(<MantineProvider><PullRequestInfo pr={{...pr,state:"merged"}}/></MantineProvider>);
  expect(screen.getByText("CI passed")).toBeInTheDocument();
  expect(screen.getByRole("link",{name:"Improve search #12"})).toHaveAttribute("href",url);
  rerender(<MantineProvider><PullRequestInfo pr={{...pr,state:"unknown",checks:"unknown",url:"javascript:alert(1)"}}/></MantineProvider>);
  expect(screen.queryByText(/CI status unknown/)).not.toBeInTheDocument();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});


test("one status popup shows available lines, survives movement onto links, and closes with Escape", async () => {
  render(<MantineProvider env="test"><CardStatusLine durationMs={905 * 60000} pullRequests={[{...pr, canMerge: true, checkedAt: new Date().toISOString()}]} scheduled nextRunAt={new Date(Date.now()+3600000).toISOString()}><span>Oct 7th</span></CardStatusLine></MantineProvider>);
  const line = screen.getByLabelText("Turn status details");
  fireEvent.mouseEnter(line);
  expect(screen.getByText("Worked for 15h 5m")).toBeInTheDocument();
  const link = screen.getByRole("link", {name:"Improve search #12",hidden:true});
  expect(link).toHaveAttribute("href",url);
  expect(screen.getByText("CI passed")).toBeInTheDocument();
  expect(screen.getByText(/^Next run:/)).toBeInTheDocument();
  expect(screen.queryByText(/Checked |Ready to merge/)).not.toBeInTheDocument();
  fireEvent.focus(line);
  fireEvent.keyDown(line,{key:"Tab"});
  expect(link).toHaveFocus();
  fireEvent.keyDown(link,{key:"Escape"});
  expect(line).toHaveFocus();
});

test("popup omits missing duration, CI and schedule time instead of unavailable lines", async () => {
  render(<MantineProvider env="test"><CardStatusLine durationMs={null} scheduled nextRunAt={null} pullRequests={[{...pr,checks:"unknown"}]}><span>Oct 7th</span></CardStatusLine></MantineProvider>);
  fireEvent.mouseEnter(screen.getByLabelText("Turn status details"));
  expect(screen.getByRole("link",{name:"Improve search #12",hidden:true})).toBeInTheDocument();
  expect(screen.queryByText(/Worked for|Next run:|CI status|unavailable/)).not.toBeInTheDocument();
});


test("status line describes PR state to keyboard and screen-reader users", () => {
  render(<MantineProvider><CardStatusLine pullRequests={[{...pr,state:"merged"},{...pr,url:"https://github.com/example/repo/pull/13",state:"draft"}]}><span>Oct 7th</span></CardStatusLine></MantineProvider>);
  expect(screen.getByLabelText("Turn status details")).toHaveAccessibleDescription("Improve search #12: Merged. Improve search #13: Draft");
});


test("Tab preserves the time control before handing focus to the PR link", () => {
  render(<MantineProvider env="test"><CardStatusLine pullRequests={[pr]}><button>Oct 7th</button></CardStatusLine></MantineProvider>);
  const line = screen.getByLabelText("Turn status details");
  fireEvent.focus(line);
  expect(fireEvent.keyDown(line, {key:"Tab"})).toBe(true);
  const time = screen.getByRole("button", {name:"Oct 7th"});
  time.focus();
  fireEvent.keyDown(time, {key:"Tab"});
  expect(screen.getByRole("link", {name:"Improve search #12",hidden:true})).toHaveFocus();
});
