import { MantineProvider } from "@mantine/core";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { GitHubConnection } from "./GitHubConnection";

afterEach(() => { cleanup(); vi.useRealTimers(); });
const auth = { configured: true, connected: false, login: null };
function setup(props: Partial<Parameters<typeof GitHubConnection>[0]> = {}) {
  const request = vi.fn().mockResolvedValue({ ...auth, pending: { userCode: "ABCD-EFGH", verificationUrl: "https://github.com/login/device", expiresAt: Date.now() + 900_000 } });
  const openLink = vi.fn().mockResolvedValue({});
  const refresh = vi.fn().mockResolvedValue({});
  const openSettings = vi.fn().mockResolvedValue({});
  render(<MantineProvider><GitHubConnection auth={auth} request={request} openLink={openLink} refresh={refresh} openSettings={openSettings} {...props} /></MantineProvider>);
  fireEvent.click(screen.getByRole("button", { name: "GitHub connection" }));
  return { request, openLink, refresh, openSettings };
}
test("unconfigured connection directs users to native plugin settings", async () => {
  const c = setup({ auth: { ...auth, configured: false } });
  fireEvent.click(await screen.findByRole("button", { name: "Open plugin settings" }));
  await waitFor(() => expect(c.openSettings).toHaveBeenCalledOnce());
});
test("sign-in displays only the user code and opens GitHub's verification page", async () => {
  const c = setup();
  fireEvent.click(await screen.findByRole("button", { name: "Sign in with GitHub" }));
  expect(await screen.findByText("ABCD-EFGH")).toBeInTheDocument();
  expect(c.request).toHaveBeenCalledWith("start");
  fireEvent.click(screen.getByRole("button", { name: "Open GitHub" }));
  await waitFor(() => expect(c.openLink).toHaveBeenCalledWith("https://github.com/login/device"));
});
test("connected account can remove its local sign-in and refresh the board", async () => {
  const request = vi.fn().mockResolvedValue(auth);
  const c = setup({ auth: { ...auth, connected: true, login: "tester" }, request });
  expect(await screen.findByText("tester")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Disconnect this computer" }));
  await waitFor(() => expect(request).toHaveBeenCalledWith("disconnect"));
  await waitFor(() => expect(c.refresh).toHaveBeenCalledOnce());
  expect(await screen.findByRole("button", { name: "Sign in with GitHub" })).toBeInTheDocument();
});

test("five-second board snapshots do not reset the pending sign-in timer", async () => {
  vi.useFakeTimers();
  const pending = { userCode: "ABCD-EFGH", verificationUrl: "https://github.com/login/device", expiresAt: Date.now() + 900_000 };
  const request = vi.fn().mockResolvedValue({ ...auth, pending });
  const refresh = vi.fn().mockResolvedValue({});
  const props = { request, refresh, openSettings: vi.fn(), openLink: vi.fn() };
  const { rerender } = render(<MantineProvider><GitHubConnection {...props} auth={{ ...auth, pending }} /></MantineProvider>);
  fireEvent.click(screen.getByRole("button", { name: "GitHub connection" }));
  await act(async () => { vi.advanceTimersByTime(4000); });
  rerender(<MantineProvider><GitHubConnection {...props} auth={{ ...auth, pending: { ...pending } }} /></MantineProvider>);
  await act(async () => { vi.advanceTimersByTime(1000); });
  expect(request).toHaveBeenCalledWith("poll");
});
