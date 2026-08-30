import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { ManualTransitionConfirmation, type TerminalStatus } from "./TaskDetail";

afterEach(cleanup);

test("clears a manual-transition confirmation only after success", async () => {
  const onTransition = vi.fn().mockResolvedValue({ ok: true });
  render(<ConfirmationHarness onTransition={onTransition} />);
  expect(screen.getByRole("alert")).toHaveTextContent("Mark task completed?");
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

  await waitFor(() => expect(onTransition).toHaveBeenCalledWith("completed", expect.any(String)));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  await waitFor(() => expect(screen.getByRole("heading", { name: "Task title" })).toHaveFocus());
});

test("retains a manual-transition confirmation after failure", async () => {
  const onTransition = vi.fn().mockResolvedValue({ ok: false });
  render(<ConfirmationHarness onTransition={onTransition} />);
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

  await waitFor(() => expect(onTransition).toHaveBeenCalledWith("completed", expect.any(String)));
  expect(screen.getByRole("alert")).toHaveTextContent("Mark task completed?");
});

test("reuses an action ID for retryable failures and rotates it after a stale task", async () => {
  const onTransition = vi.fn()
    .mockResolvedValueOnce({ ok: false })
    .mockResolvedValueOnce({ ok: false, rotateActionId: true })
    .mockResolvedValueOnce({ ok: false });
  render(<ConfirmationHarness onTransition={onTransition} />);
  const confirm = screen.getByRole("button", { name: "Confirm" });
  fireEvent.click(confirm);
  await waitFor(() => expect(onTransition).toHaveBeenCalledTimes(1));
  const firstActionId = onTransition.mock.calls[0][1];
  fireEvent.click(confirm);
  await waitFor(() => expect(onTransition).toHaveBeenCalledTimes(2));
  expect(onTransition.mock.calls[1][1]).toBe(firstActionId);
  fireEvent.click(confirm);
  await waitFor(() => expect(onTransition).toHaveBeenCalledTimes(3));
  expect(onTransition.mock.calls[2][1]).not.toBe(firstActionId);
});

function ConfirmationHarness({ onTransition }: { onTransition: (status: TerminalStatus, actionId: string) => Promise<{ ok: boolean; rotateActionId?: boolean }> }) {
  const [opened, setOpened] = useState(true);
  return (
    <MantineProvider>
      <h2 id="task-detail-title" tabIndex={-1}>Task title</h2>
      {opened && (
        <ManualTransitionConfirmation
          busy={false}
          onCancel={() => setOpened(false)}
          onTransition={onTransition}
          status="completed"
        />
      )}
    </MantineProvider>
  );
}
