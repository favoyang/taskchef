import test from "node:test";
import assert from "node:assert/strict";
import { formatTime } from "../public/time.js";

const now = new Date(2026, 9, 23, 12, 0, 0);

test("today uses hour:minuteAM/PM without a space", () => {
  assert.equal(formatTime(new Date(2026, 9, 23, 9, 3).toISOString(), now), "9:03AM");
  assert.equal(formatTime(new Date(2026, 9, 23, 15, 7).toISOString(), now), "3:07PM");
  assert.equal(formatTime(new Date(2026, 9, 23, 0, 5).toISOString(), now), "12:05AM");
  assert.equal(formatTime(new Date(2026, 9, 23, 12, 0).toISOString(), now), "12:00PM");
});

test("this year uses Mon D", () => {
  assert.equal(formatTime(new Date(2026, 9, 18, 13, 44).toISOString(), now), "Oct 18");
});

test("older chats include the year", () => {
  assert.equal(formatTime(new Date(2024, 9, 17, 13, 44).toISOString(), now), "2024 Oct 17");
});
