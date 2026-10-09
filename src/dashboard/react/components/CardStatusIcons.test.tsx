import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { nextRunLabel, prPresentation, PullRequestIcons, PullRequestInfo } from "./CardStatusIcons";
import type { PullRequestStatus } from "../types";
afterEach(cleanup);
const url="https://github.com/example/repo/pull/12";
const pr:PullRequestStatus={url,state:"open",checks:"passed",title:"Improve search"};
test("cards keep PR status in an accessible icon without extra text",()=>{
  render(<MantineProvider><PullRequestIcons pullRequests={[pr,{...pr,url:"https://github.com/example/repo/pull/13",state:"unknown"}]}/></MantineProvider>);
  expect(screen.getByRole("button",{name:"Improve search: Checks passed"})).toBeInTheDocument();
  expect(screen.getByRole("button",{name:"Improve search: PR status not checked or unavailable"})).toBeInTheDocument();
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
  expect(screen.getByText("Merged · CI passed")).toBeInTheDocument();
  expect(screen.getByRole("link",{name:"Improve search"})).toHaveAttribute("href",url);
  rerender(<MantineProvider><PullRequestInfo pr={{...pr,state:"unknown",checks:"unknown",url:"javascript:alert(1)"}}/></MantineProvider>);
  expect(screen.getByText("PR status not checked or unavailable · CI status unknown")).toBeInTheDocument();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});
