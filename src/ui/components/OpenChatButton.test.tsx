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
  expect(button).toHaveClass("taskchef-open-chat");
  expect(button).toHaveAttribute("data-variant", "default");
  expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  fireEvent.click(button);
  expect(onClick).toHaveBeenCalledOnce();
});

test("opening a chat keeps its label and icon still while preventing another click", () => {
  const click = vi.fn();
  const view = render(<MantineProvider><OpenChatButton loading onClick={click} taskTitle="Example" /></MantineProvider>);
  const button = screen.getByRole("button", {name:"Open chat for Example"});
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute("aria-busy", "true");
  expect(button).not.toHaveAttribute("data-loading");
  expect(button.querySelector(".mantine-Button-loader")).toBeNull();
  expect(button).toHaveTextContent("Open chat");
  expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  fireEvent.click(button);
  expect(click).not.toHaveBeenCalled();
  view.rerender(<MantineProvider><OpenChatButton onClick={click} taskTitle="Example" /></MantineProvider>);
  expect(button).toBeEnabled();
  expect(button).not.toHaveAttribute("aria-busy");
  fireEvent.click(button);
  expect(click).toHaveBeenCalledOnce();
});
