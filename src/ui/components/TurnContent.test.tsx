import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { fixtureTask } from "../fixtures";
import { TurnContent } from "./TurnContent";
afterEach(cleanup);
test("a running request is visible without a stale or placeholder reply", () => {
  const task={...fixtureTask(),status:"working" as const,promptExcerpt:"Current **request**",replyExcerpt:null};
  render(<TurnContent task={task} compact />);
  expect(screen.getByLabelText("Latest turn request").querySelector('strong')?.textContent).toBe('request');
  expect(screen.queryByLabelText("Latest turn response")).toBeNull();
});
test("details use full text, and only actual scheduled input has a clock", () => {
  const task={...fixtureTask(),scheduled:true,inputSource:"ordinary" as const,promptExcerpt:"Short",promptText:"Full request",replyExcerpt:"Short result",replyText:"Full result"};
  const {rerender}=render(<TurnContent task={task} />);
  expect(screen.getByText('Full request')).toBeVisible(); expect(screen.getByText('Full result')).toBeVisible();
  expect(screen.queryByLabelText('Scheduled prompt')).toBeNull();
  rerender(<TurnContent task={{...task,inputSource:'scheduled'}} />);
  expect(screen.getByLabelText('Scheduled prompt')).toBeVisible();
});

test("cards show only the prompt while running and only the response otherwise", () => {
 const task={...fixtureTask(),status:"working" as const,promptExcerpt:"Current request",replyExcerpt:"Current response"};
 const {rerender}=render(<TurnContent task={task} compact />);
 expect(screen.getByText('Current request')).toBeVisible();expect(screen.queryByText('Current response')).toBeNull();
 rerender(<TurnContent task={{...task,status:'needs_input'}} compact />);
 expect(screen.queryByText('Current request')).toBeNull();expect(screen.getByText('Current response')).toBeVisible();
});


test("details hide generated request labels and put worked time before the complete reply", () => {
 render(<TurnContent task={{...fixtureTask(),promptText:"## My request:\nPlease review.",replyText:"Full response.",observed:{archive:false,recentFileActivity:false,lastTurnEvent:"completed",lastTurnEventAt:null,latestTurnDurationMs:298000}}} />);
 expect(screen.getByLabelText('Latest turn request')).toHaveTextContent('Please review.');
 expect(screen.getByLabelText('Latest turn request')).not.toHaveTextContent('My request:');
 expect(screen.getByRole('separator')).toHaveTextContent('Worked for 4m');
 expect(screen.getByLabelText('Latest turn response')).toHaveTextContent('Full response.');
});

test("card prompt cleanup does not change response headings", () => {
 const task={...fixtureTask(),status:"working" as const,promptExcerpt:"## My request:\nReview this.",replyExcerpt:"## My requests:\nA response section."};
 const {rerender}=render(<TurnContent task={task} compact />);
 expect(screen.getByLabelText("Latest turn request")).not.toHaveTextContent("My request:");
 rerender(<TurnContent task={{...task,status:"needs_input"}} compact />);
 expect(screen.getByLabelText("Latest turn response")).toHaveTextContent("My requests:");
});


test("compact errors keep the full message accessible and details show it without a clamp", () => {
  const turnError = Array.from({ length: 20 }, (_, i) => `Recorded failure detail ${i}.`).join("\n");
  const task = { ...fixtureTask(), status: "interrupted" as const, turnError, replyExcerpt: null };
  const { rerender } = render(<TurnContent task={task} compact />);
  const compact = screen.getByLabelText("Latest turn error");
  expect(compact).toHaveClass("taskchef-turn-error-compact");
  expect(compact.querySelector("span")).toHaveAttribute("title", turnError);
  rerender(<TurnContent task={task} />);
  expect(screen.getByLabelText("Latest turn error")).not.toHaveClass("taskchef-turn-error-compact");
  expect(screen.getByLabelText("Latest turn error").textContent).toBe(turnError);
});
