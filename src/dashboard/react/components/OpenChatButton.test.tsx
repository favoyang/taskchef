import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { OpenChatButton } from "./OpenChatButton";

afterEach(cleanup);

test("uses the shared open-chat presentation and accessible task label", () => {
  const onClick = vi.fn();
  render(
    <MantineProvider>
      <OpenChatButton onClick={onClick} taskTitle="Review checkout reconciliation" />
    </MantineProvider>,
  );

  const button = screen.getByRole("button", { name: "Open chat for Review checkout reconciliation" });
  expect(button).toHaveTextContent("Open chat");
  expect(button).toHaveAttribute("data-variant", "default");
  expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  fireEvent.click(button);
  expect(onClick).toHaveBeenCalledOnce();
});
