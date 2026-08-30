import { afterEach, expect, test, vi } from "vitest";
import { fixtureTask } from "./fixtures";
import { manualTransition } from "./api";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("times out a stalled manual transition and returns a retryable error", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  })));

  const request = manualTransition(fixtureTask(), "completed", crypto.randomUUID());
  await vi.advanceTimersByTimeAsync(10_000);

  await expect(request).resolves.toMatchObject({
    ok: false,
    code: "request_timeout",
    message: "Task state change timed out. Try again.",
  });
});
