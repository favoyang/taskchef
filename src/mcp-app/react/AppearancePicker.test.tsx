import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AppearancePicker } from "./AppearancePicker";

beforeEach(() => vi.stubGlobal("PointerEvent", class extends MouseEvent {
  pointerType: string;
  constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerType = init.pointerType ?? "mouse"; }
}));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
test("hover stays open while crossing into the panel and closes after leaving", () => {
  vi.useFakeTimers();
  render(<MantineProvider><AppearancePicker value="dark" onChange={vi.fn()} /></MantineProvider>);
  const button = screen.getByRole("button", { name: "Appearance" });
  fireEvent.pointerEnter(button, { pointerType: "mouse" });
  const panel = screen.getByRole("region", { name: "Appearance settings" });
  fireEvent.pointerLeave(button, { pointerType: "mouse" });
  fireEvent.pointerEnter(panel, { pointerType: "mouse" });
  act(() => vi.advanceTimersByTime(250));
  expect(panel).toBeVisible();
  fireEvent.pointerLeave(panel, { pointerType: "mouse" });
  act(() => vi.advanceTimersByTime(250));
  expect(screen.queryByRole("region", { name: "Appearance settings" })).not.toBeInTheDocument();
});
test("tap opens, appearance changes, and Escape restores focus", () => {
  const onChange = vi.fn();
  render(<MantineProvider><AppearancePicker value="dark" onChange={onChange} /></MantineProvider>);
  const button = screen.getByRole("button", { name: "Appearance" });
  fireEvent.pointerEnter(button, { pointerType: "touch" });
  expect(screen.queryByRole("region", { name: "Appearance settings" })).not.toBeInTheDocument();
  fireEvent.click(button);
  fireEvent.click(screen.getByRole("radio", { name: "DAY" }));
  expect(onChange).toHaveBeenCalledWith("light");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("region", { name: "Appearance settings" })).not.toBeInTheDocument();
  expect(button).toHaveFocus();
});
test("theme rows use native variants and keyboard selection", () => {
  const onVisualThemeChange = vi.fn();
  render(<MantineProvider><AppearancePicker value="light" appearance="light" visualThemeId="chatgpt" onChange={vi.fn()} onVisualThemeChange={onVisualThemeChange} /></MantineProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
  expect(screen.queryByRole("radio", { name: "Dracula" })).not.toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "Proof" })).toBeVisible();
  const selected = screen.getByRole("radio", { name: "ChatGPT" });
  selected.focus();
  fireEvent.keyDown(selected, { key: "ArrowDown" });
  expect(screen.queryByRole("radio", { name: "Ayu" })).not.toBeInTheDocument();
  expect(onVisualThemeChange).toHaveBeenCalledWith("absolutely");
  expect(screen.getByRole("radio", { name: "Absolutely" })).toHaveFocus();
});
