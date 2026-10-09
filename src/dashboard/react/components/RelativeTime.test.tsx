import { MantineProvider } from "@mantine/core";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { formatCardTime } from "../../time.js";
import { ElapsedTime, RelativeTime, RelativeTimeProvider } from "./RelativeTime";

afterEach(() => { cleanup(); vi.useRealTimers(); });
const local = (year: number, month: number, day: number, hour = 0, minute = 0) => new Date(year, month - 1, day, hour, minute).toISOString();

test("elapsed time ticks from the turn start, resets for a new turn, and cleans up", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-09T07:12:34Z"));
  const { rerender, unmount } = render(<MantineProvider><ElapsedTime startedAt="2026-10-09T07:00:00Z" /></MantineProvider>);
  expect(screen.getByLabelText(/^Elapsed time:/)).toHaveTextContent("12m");
  expect(screen.getByLabelText(/^Elapsed time:/).querySelector("svg")).not.toBeNull();
  expect(screen.getByLabelText(/^Elapsed time:/)).toHaveAccessibleName(/Started/);
  act(() => { vi.advanceTimersByTime(1000); });
  expect(screen.getByLabelText(/^Elapsed time:/)).toHaveTextContent(/^12m$/);
  act(() => { vi.advanceTimersByTime(25000); });
  expect(screen.getByLabelText(/^Elapsed time:/)).toHaveTextContent(/^13m$/);
  rerender(<MantineProvider><ElapsedTime startedAt="2026-10-09T06:00:00Z" /></MantineProvider>);
  expect(screen.getByLabelText(/^Elapsed time:/)).toHaveTextContent("1h 13m");
  rerender(<MantineProvider><ElapsedTime startedAt="2026-10-09T07:13:00Z" /></MantineProvider>);
  expect(screen.getByLabelText(/^Elapsed time:/)).toHaveTextContent("<1m");
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test("elapsed time does not invent a start time and clamps clock skew", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-09T07:00:00Z"));
  const { rerender } = render(<MantineProvider><ElapsedTime startedAt="invalid" /></MantineProvider>);
  expect(screen.getByLabelText(/^Elapsed time:/)).toHaveTextContent("—");
  expect(vi.getTimerCount()).toBe(0);
  rerender(<MantineProvider><ElapsedTime startedAt="2026-10-09T07:00:01Z" /></MantineProvider>);
  expect(screen.getByLabelText(/^Elapsed time:/)).toHaveTextContent("<1m");
});

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
