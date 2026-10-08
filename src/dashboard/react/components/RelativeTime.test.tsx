import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { formatCardTime } from "../../time.js";
import { RelativeTime, RelativeTimeProvider } from "./RelativeTime";

afterEach(cleanup);
const local = (year: number, month: number, day: number, hour = 0, minute = 0) => new Date(year, month - 1, day, hour, minute).toISOString();

test("card dates use local calendar days across midnight and year boundaries", () => {
  const now = new Date(2026, 9, 8, 14, 35).getTime();
  expect(formatCardTime(local(2026, 10, 8, 14, 30), { now })).toBe("2:30PM");
  expect(formatCardTime(local(2026, 10, 7, 23, 59), { now })).toBe("Yesterday");
  expect(formatCardTime(local(2026, 7, 7), { now })).toBe("July 7th");
  expect(formatCardTime(local(2025, 7, 7), { now })).toBe("July 7th, 2025");
  expect(formatCardTime(local(2025, 12, 31), { now: new Date(2026, 0, 1, 0, 1).getTime() })).toBe("Yesterday");
  expect(formatCardTime(local(2026, 10, 9), { now })).toBe("October 9th");
  expect(formatCardTime(null, { now })).toBe("—");
});

test("ordinal date labels handle teens and month endings", () => {
  const now = new Date(2026, 9, 8).getTime();
  for (const [day, suffix] of [[1, "st"], [2, "nd"], [3, "rd"], [11, "th"], [12, "th"], [13, "th"], [21, "st"], [31, "st"]] as const) {
    expect(formatCardTime(local(2026, 7, day), { now })).toBe(`July ${day}${suffix}`);
  }
});

test("card time has no clock and preserves exact-time access", () => {
  render(<MantineProvider><RelativeTimeProvider now={new Date(2026, 9, 8, 15).getTime()}>
    <RelativeTime calendar icon={false} label="Updated time" value={local(2026, 10, 8, 14, 30)} />
  </RelativeTimeProvider></MantineProvider>);
  const button = screen.getByRole("button", { name: "Updated time: 2:30PM. Show exact time" });
  expect(button.querySelector("svg")).toBeNull();
  fireEvent.click(button);
  expect(button).toHaveAccessibleName(/Show card date/);
  expect(button).toHaveTextContent("2026");
  fireEvent.click(button);
  expect(button).toHaveTextContent("2:30PM");
});
