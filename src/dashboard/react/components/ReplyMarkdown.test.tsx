import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { MantineProvider } from "@mantine/core";
import { ReplyMarkdown } from "./ReplyMarkdown";

// Test TaskChef's rows and keyboard handlers without jsdom layout work.
// Browser QA separately exercises Mantine's real popup and positioning.
vi.mock("@mantine/core", async () => {
  const actual = await vi.importActual<typeof import("@mantine/core")>("@mantine/core");
  const React = await import("react");
  const { createPortal } = await import("react-dom");
  const Open = React.createContext(false);
  const Popover = Object.assign(
    ({opened, children}: {opened: boolean; children: React.ReactNode}) => <Open value={opened}>{children}</Open>,
    {
      Target: ({children}: {children: React.ReactNode}) => children,
      Dropdown: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>((props, ref) =>
        React.useContext(Open) ? createPortal(<div {...props} ref={ref} />, document.body) : null),
    },
  );
  return {...actual, Popover};
});

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


test.each(["## My request:\nFix the filter.", "## My requests:\nFix the filter.", "My requests:\n\nFix the filter.", "My requests: Fix the filter.", "My requests:\nFix the filter.", "My requests:  \nFix the filter.", "**My requests:** Fix the filter.", "## **My requests:**\nFix the filter.", "**My requests:**  \nFix the filter."])("card previews hide request labels: %s", text => {
  const { container, rerender } = render(<ReplyMarkdown compact hideRequestLabels text={text} />);
  expect(container).toHaveTextContent("Fix the filter.");
  expect(container).not.toHaveTextContent(/My requests?:/i);
  rerender(<ReplyMarkdown text={text} />);
  expect(container).toHaveTextContent(/My requests?:/i);
});

test("card request-label cleanup preserves quoted and code examples", () => {
  const { container } = render(<ReplyMarkdown compact hideRequestLabels text={"> ## My requests:\n\n```text\nMy requests:\n```"} />);
  expect(container.querySelector("blockquote")).toHaveTextContent("My requests:");
  expect(container.querySelector("pre code")).toHaveTextContent("My requests:");
});

test("prompt cleanup preserves later user headings", () => {
 const { container } = render(<ReplyMarkdown hideRequestLabels text={"## My request:\nReview this.\n\n## My requests:\nA real later section."} />);
 expect(container.querySelectorAll("h2")).toHaveLength(1);
 expect(container.querySelector("h2")).toHaveTextContent("My requests:");
});

test.each([false, true])("annotations render readable links with selected text and comment (compact=%s)", async compact => {
 const {container}=render(<MantineProvider><ReplyMarkdown compact={compact} annotations={[{text:'Quoted selection',annotation:'Requested change'}]} text={'Final plan :codex-annotation{index="1"}'} /></MantineProvider>);
 const button=screen.getByRole('button',{name:'Annotation 1'});
 expect(container).not.toHaveTextContent(':codex-annotation');
 fireEvent.focus(button);
 expect(await screen.findByRole('tooltip')).toHaveTextContent('Selected text:Quoted selectionUser comment:Requested change');
});
test('code examples stay literal and unavailable annotations do not borrow another index', async () => {
 const {container}=render(<MantineProvider><ReplyMarkdown annotations={[{text:'First selection',annotation:'First comment'}]} text={':codex-annotation{index="2"}\n\n`:codex-annotation{index="1"}`\n\n```text\n:codex-annotation{index="1"}\n```'} /></MantineProvider>);
 expect(container.querySelectorAll('code')).toHaveLength(2);
 expect(container.querySelector('code')).toHaveTextContent(':codex-annotation{index="1"}');
 expect(screen.queryByRole('button',{name:'Annotation 1'})).toBeNull();
 fireEvent.focus(screen.getByRole('button',{name:'Annotation 2'}));
 expect(await screen.findByRole('tooltip')).toHaveTextContent('Annotation details unavailable.');
});

test('an open annotation survives same-turn refresh and closes without opening a card', async () => {
 const annotation={text:'Selected text',annotation:'User comment'};
 const clicked=vi.fn();
 const {rerender}=render(<MantineProvider><div onClick={clicked}><ReplyMarkdown text={':codex-annotation{index="1"}'} annotations={[annotation]} /></div></MantineProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Annotation 1'}));
 expect(clicked).not.toHaveBeenCalled();
 rerender(<MantineProvider><div onClick={clicked}><ReplyMarkdown text={':codex-annotation{index="1"}'} annotations={[{...annotation}]} /></div></MantineProvider>);
 expect(screen.getByRole('tooltip')).toHaveTextContent('User comment');
 fireEvent.keyDown(screen.getByRole('button',{name:'Annotation 1'}),{key:'Escape'});
 expect(screen.queryByRole('tooltip')).toBeNull();
});
