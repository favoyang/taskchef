import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { SavedUsage } from "../types";
import { useAnimatedUsage } from "./SavedUsageFormat";

const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock("@mantine/hooks", () => ({ useReducedMotion: () => motion.reduced }));
const usage = (tokens: number, cost: number): SavedUsage => ({
  tokens: { input_tokens: tokens, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: tokens },
  samples: 1, costUsd: cost, partial: false, costPartial: false,
});
function Counter({ value, running = true, identity = "turn-1" }: { value?: SavedUsage; running?: boolean; identity?: string }) {
  const displayed = useAnimatedUsage(value, running, identity);
  return <output data-testid="counter">{displayed ? `${displayed.tokens.total_tokens}:${displayed.costUsd}` : "missing"}</output>;
}
let clock = 0, nextFrame = 0;
const frames = new Map<number, FrameRequestCallback>();
function advance(now: number) {
  act(() => {
    clock = now;
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback(now));
  });
}
function displayed() { return screen.getByTestId("counter").textContent; }
beforeEach(() => {
  clock = 0; nextFrame = 0; motion.reduced = false; frames.clear();
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test("running usage catches up and continues from the displayed amount when another update arrives", () => {
  const view = render(<Counter value={usage(1000, 2)} />);
  expect(displayed()).toBe("0:0");
  advance(400);
  expect(displayed()).toBe("875:1.75");
  view.rerender(<Counter value={usage(2000, 4)} />);
  expect(displayed()).toBe("875:1.75");
  advance(800);
  expect(displayed()).toBe("1859:3.71875");
  advance(1200);
  expect(displayed()).toBe("2000:4");
  expect(frames.size).toBe(0);
});

test("late usage animates from zero and a new turn does not inherit the old counter", () => {
  const view = render(<Counter />);
  expect(displayed()).toBe("missing");
  view.rerender(<Counter value={usage(1000, 2)} />);
  advance(800);
  expect(displayed()).toBe("1000:2");
  view.rerender(<Counter value={usage(300, 0.5)} identity="turn-2" />);
  expect(displayed()).toBe("0:0");
  advance(1600);
  expect(displayed()).toBe("300:0.5");
});

test("completed chats and reduced motion show the exact total and cancel pending animation", () => {
  const view = render(<Counter value={usage(1000, 2)} />);
  advance(200);
  view.rerender(<Counter value={usage(1000, 2)} running={false} />);
  expect(displayed()).toBe("1000:2");
  expect(frames.size).toBe(0);
  motion.reduced = true;
  view.rerender(<Counter value={usage(2000, 4)} />);
  expect(displayed()).toBe("2000:4");
  expect(frames.size).toBe(0);
});

test("unmount cancels the counter's pending frame", () => {
  const view = render(<Counter value={usage(1000, 2)} />);
  expect(frames.size).toBe(1);
  view.unmount();
  expect(frames.size).toBe(0);
});
