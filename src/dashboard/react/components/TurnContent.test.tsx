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
