import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { fixtureTask } from "../fixtures";
import { ReplyCover } from "./ReplyCover";
afterEach(cleanup);
test("loads a local cover, opens details, and clears it on a new turn", async () => {
  const task = fixtureTask({ title: "Design", turnId: "one", replyImage: { url: "/design.png", alt: "Design screenshot" } });
  const load = vi.fn().mockResolvedValueOnce("data:image/png;base64,AAAA").mockResolvedValueOnce(null);
  const open = vi.fn();
  const { rerender } = render(<ReplyCover task={task} loadImage={load} onOpen={open} />);
  expect(await screen.findByAltText("Design screenshot")).toHaveAttribute("src", "data:image/png;base64,AAAA");
  fireEvent.click(screen.getByRole("button")); expect(open).toHaveBeenCalledOnce();
  rerender(<ReplyCover task={{ ...task, turnId: "two" }} loadImage={load} onOpen={open} />);
  expect(await screen.findByText("Image unavailable")).toBeVisible();
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
});
test("HTTPS covers use no referrer and failed loads leave a usable button", async () => {
  const task = fixtureTask({ title: "Chart", replyImage: {url: "https://example.com/chart.png", alt: "Chart"} });
  const load = vi.fn();
  render(<ReplyCover task={task} loadImage={load} onOpen={vi.fn()} />);
  const image = await screen.findByAltText("Chart"); expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
  expect(load).not.toHaveBeenCalled(); fireEvent.error(image);
  await waitFor(() => expect(screen.getByText("Image unavailable")).toBeVisible());
});
