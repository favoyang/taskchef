import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { NextNotificationCenter, type NextNotification } from "./NextNotificationCenter";

afterEach(cleanup);
const notice = (id: string, extra: Partial<NextNotification> = {}): NextNotification => ({
  id, taskId: "chat", title: "Fix login is ready for input or review", detail: "", kind: "ready", read: false,
  timestamp: "2026-10-09T07:00:00Z", ...extra,
});

test("existing repeated chat messages keep the latest timestamp and read state", () => {
  const onAction = vi.fn().mockResolvedValue(undefined);
  const onOpen = vi.fn();
  const latest = notice("latest", { timestamp: "2026-10-09T08:00:00Z", read: true });
  render(<NextNotificationCenter state={{ revision: 1, items: [latest, notice("old"), notice("older")] }} toasts={[]} onAction={onAction} onOpen={onOpen} onDismiss={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Notifications" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
  const center = screen.getByRole("region", { name: "Notification center" });
  expect(within(center).getAllByRole("article")).toHaveLength(1);
  expect(center.querySelector("time")).toHaveAttribute("datetime", latest.timestamp);
  fireEvent.click(within(center).getByRole("button", { name: "Unread" }));
  expect(within(center).getByText("No unread notifications")).toBeVisible();
  fireEvent.click(within(center).getByRole("button", { name: "All" }));
  fireEvent.click(within(center).getByRole("button", { name: /Fix login is ready/ }));
  expect(onAction).toHaveBeenCalledWith("read", "latest");
  expect(onOpen).toHaveBeenCalledWith(latest);
});

test("new repeats replace the visible entry while other chats and messages stay separate", () => {
  const props = { toasts: [], onAction: vi.fn().mockResolvedValue(undefined), onOpen: vi.fn(), onDismiss: vi.fn() };
  const original = notice("old");
  const separate = [notice("other-chat", { taskId: "another" }), notice("interrupted", { kind: "interrupted", title: "Fix login was interrupted" }), notice("detail", { detail: "Different details" }), notice("global-one", { taskId: null }), notice("global-two", { taskId: null })];
  const { rerender } = render(<NextNotificationCenter {...props} state={{ revision: 1, items: [original, ...separate] }} />);
  fireEvent.click(screen.getByRole("button", { name: "Notifications, unread" }));
  const latest = notice("latest", { timestamp: "2026-10-09T08:00:00Z" });
  rerender(<NextNotificationCenter {...props} state={{ revision: 2, items: [latest, original, ...separate] }} />);
  const center = screen.getByRole("region", { name: "Notification center" });
  const entries = within(center).getAllByRole("article");
  expect(entries).toHaveLength(6);
  expect(entries[0].querySelector("time")).toHaveAttribute("datetime", latest.timestamp);
  expect(within(center).getByRole("button", { name: "Unread (6)" })).toBeVisible();
});


test("opening and scrolling marks only notifications observed in the panel read", async () => {
  const observers: Array<{ callback: IntersectionObserverCallback; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  vi.stubGlobal("IntersectionObserver", class {
    observe = vi.fn(); disconnect = vi.fn();
    constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit) { expect(options.threshold).toBe(0.01); observers.push({ callback, observe: this.observe, disconnect: this.disconnect }); }
  });
  try {
    const onAction = vi.fn().mockResolvedValue(undefined);
    const props = { toasts: [], onAction, onOpen: vi.fn(), onDismiss: vi.fn() };
    render(<NextNotificationCenter {...props} state={{ revision: 1, items: [notice("visible"), notice("offscreen", { taskId: "other" })] }} />);
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Notifications, unread" }));
    const entries = screen.getAllByRole("article");
    await act(async () => observers[0].callback([{ target: entries[0], isIntersecting: true }, { target: entries[1], isIntersecting: false }] as unknown as IntersectionObserverEntry[], {} as IntersectionObserver));
    expect(onAction).toHaveBeenCalledExactlyOnceWith("read", "visible");
    await act(async () => observers[0].callback([{ target: entries[0], isIntersecting: true }, { target: entries[1], isIntersecting: true }] as unknown as IntersectionObserverEntry[], {} as IntersectionObserver));
    expect(onAction).toHaveBeenCalledTimes(2);
    expect(onAction).toHaveBeenLastCalledWith("read", "offscreen");
    fireEvent.click(screen.getByRole("button", { name: "Close notifications" }));
    expect(observers[0].disconnect).toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});


test("failed auto-read requests retry when the panel opens again", async () => {
  const observers: IntersectionObserverCallback[] = [];
  vi.stubGlobal("IntersectionObserver", class {
    observe = vi.fn(); disconnect = vi.fn();
    constructor(callback: IntersectionObserverCallback) { observers.push(callback); }
  });
  try {
    const onAction = vi.fn().mockRejectedValueOnce(new Error("Temporary failure")).mockResolvedValue(undefined);
    render(<NextNotificationCenter state={{revision: 1, items: [notice("retry")]}} toasts={[]} onAction={onAction} onOpen={vi.fn()} onDismiss={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", {name: "Notifications, unread"}));
    await act(async () => observers[0]([{target: screen.getByRole("article"), isIntersecting: true}] as unknown as IntersectionObserverEntry[], {} as IntersectionObserver));
    fireEvent.click(screen.getByRole("button", {name: "Close notifications"}));
    fireEvent.click(screen.getByRole("button", {name: "Notifications, unread"}));
    await act(async () => observers[1]([{target: screen.getByRole("article"), isIntersecting: true}] as unknown as IntersectionObserverEntry[], {} as IntersectionObserver));
    expect(onAction).toHaveBeenCalledTimes(2);
  } finally {vi.unstubAllGlobals();}
});
