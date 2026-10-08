import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { ReplyMarkdown } from "./ReplyMarkdown";

afterEach(cleanup);

test("renders Markdown blocks, formatting, links, and GFM tables", () => {
  const { container } = render(<ReplyMarkdown text={'# Review\n\n**Ready** with `npm test`.\n\n- First\n- Second\n\n```js\nconst ready = true;\n```\n\n| Check | Result |\n| --- | --- |\n| CI | Passed |\n\n[PR](https://github.com/example/repo/pull/1)'} />);
  expect(screen.getByRole("heading", { name: "Review" })).toBeVisible();
  expect(container.querySelector("strong")).toHaveTextContent("Ready");
  expect(container.querySelectorAll("li")).toHaveLength(2);
  expect(container.querySelector("pre code")).toHaveTextContent("const ready = true;");
  expect(screen.getByRole("table")).toHaveTextContent("Passed");
  expect(screen.getByRole("link", { name: "PR" })).toHaveAttribute("rel", "noopener noreferrer");
});

test("compact previews keep formatting without exposing Markdown markers", () => {
  const { container } = render(<ReplyMarkdown compact text={'**Ready**\n\n- Run `npm test`'} />);
  expect(container.firstChild).toHaveClass("taskchef-markdown--compact");
  expect(container.querySelector("strong")).toHaveTextContent("Ready");
  expect(container.querySelector("code")).toHaveTextContent("npm test");
  expect(container).not.toHaveTextContent("**Ready**");
});

test("does not execute HTML, use unsafe links, or fetch saved images", () => {
  const { container } = render(<ReplyMarkdown text={'<script>alert(1)</script>\n\n[Unsafe](javascript:alert%281%29) [Local](/tmp/test)\n\n![Screenshot](https://example.com/private.png)\n\n![Bad](data:image/png;base64,aaa)'} />);
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector("img")).toBeNull();
  expect(screen.queryByRole("link", { name: "Unsafe" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Local" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Bad" })).toBeNull();
  expect(screen.getByRole("link", { name: "Screenshot" })).toHaveAttribute("href", "https://example.com/private.png");
});
