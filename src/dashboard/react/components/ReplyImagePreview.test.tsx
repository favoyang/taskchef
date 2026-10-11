import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { fixtureTask } from "../fixtures";
import { NextTaskDetail } from "../../../mcp-app/react/NextTaskDetail";
import { TurnContent } from "./TurnContent";
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
const png = 'data:image/png;base64,iVBORw0KGgo=';
test('reply thumbnails open above Details and close with Escape', async () => {
 const load=vi.fn().mockResolvedValue(png);
 const close = vi.fn();
 const { rerender } = render(<MantineProvider><NextTaskDetail task={{...fixtureTask(),title:'Chat details',replyText:'![Design](</local/design (2).png>)'}} opened busy={false} error={null} onClose={close} onOpenCodex={()=>{}} loadImage={load} /></MantineProvider>);
 const thumbnail=await screen.findByRole('button',{name:'Enlarge Design'});
 expect(load).toHaveBeenCalledWith(expect.anything(),'/local/design%20(2).png');
 fireEvent.click(thumbnail);
 await waitFor(()=>expect(screen.getByRole('dialog',{name:'Design'})).toBeVisible());
 rerender(<MantineProvider><NextTaskDetail task={{...fixtureTask(),title:'Chat details',replyText:'![Design](</local/design (2).png>)'}} opened busy={false} error={null} onClose={close} onOpenCodex={()=>{}} loadImage={load} /></MantineProvider>);
 expect(screen.getByRole('dialog',{name:'Design'})).toBeVisible();
 fireEvent.keyDown(screen.getByRole('dialog',{name:'Design'}),{key:'Escape'});
 await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Design'})).not.toBeInTheDocument());
 expect(screen.getByRole('dialog',{name:'Chat details'})).toBeVisible();
 expect(close).not.toHaveBeenCalled();
});
test('missing local images are hidden and remote images stay links', async () => {
 const load=vi.fn().mockResolvedValue(null);
 render(<MantineProvider><TurnContent task={{...fixtureTask(),replyText:'![Missing](/gone.png)\n![Remote](https://example.com/image.png)'}} loadImage={load} /></MantineProvider>);
 await waitFor(()=>expect(load).toHaveBeenCalledTimes(1));
 expect(screen.queryByRole('img')).toBeNull();expect(screen.queryByRole('button',{name:/Enlarge/})).toBeNull();
 expect(screen.getByRole('link',{name:'Remote'})).toHaveAttribute('href','https://example.com/image.png');
});

test('all prompt images stay visible beside capped prompt text and open in the lightbox', async () => {
 const load=vi.fn().mockResolvedValue(png); const close=vi.fn();
 const task={...fixtureTask(),title:'Prompt images',promptText:'![First](/first.png)\n\n![Second](/second.png)\n\nPlease review both.',promptImages:[{url:'/first.png',alt:'First'},{url:'/second.png',alt:'Second'}]};
 render(<MantineProvider><NextTaskDetail task={task} opened busy={false} error={null} onClose={close} onOpenCodex={()=>{}} loadImage={load} /></MantineProvider>);
 expect(await screen.findByRole('button',{name:'Enlarge First'})).toBeVisible();
 const second=await screen.findByRole('button',{name:'Enlarge Second'});
 expect(second.closest('.taskchef-turn-collapsed')).toBeNull();
 expect(screen.getAllByRole('img')).toHaveLength(2);
 fireEvent.click(second);
 await waitFor(()=>expect(screen.getByRole('dialog',{name:'Second'})).toBeVisible());
 fireEvent.keyDown(screen.getByRole('dialog',{name:'Second'}),{key:'Escape'});
 await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Second'})).toBeNull());
 expect(close).not.toHaveBeenCalled();
});

test('Escape closes an annotation popup while keeping Details open', async () => {
 const close=vi.fn();
 render(<MantineProvider><NextTaskDetail task={{...fixtureTask(),title:'Annotated chat',replyText:':codex-annotation{index="1"}',annotations:[{text:'Selected text',annotation:'User comment'}]}} opened busy={false} error={null} onClose={close} onOpenCodex={()=>{}} /></MantineProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Annotation 1'}));
 await waitFor(()=>expect(screen.getByRole('tooltip')).toBeVisible());
 fireEvent.keyDown(screen.getByRole('button',{name:'Annotation 1'}),{key:'Escape'});
 await waitFor(()=>expect(screen.queryByRole('tooltip')).toBeNull());
 expect(screen.getByRole('dialog',{name:'Annotated chat'})).toBeVisible();
 expect(close).not.toHaveBeenCalled();
});
