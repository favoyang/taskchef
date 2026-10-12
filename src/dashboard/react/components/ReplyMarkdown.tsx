import { Popover } from "@mantine/core";
import { createContext, useContext, useEffect, useMemo, useRef, useState, useId, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PhrasingContent, Root, RootContent } from "mdast";

// Saved replies are untrusted text. Do not execute HTML or load remote images.
function replyUrl(url: string): string {
  return /^(https?:|mailto:)/i.test(url) || url.startsWith("#") ? url : "";
}

function localImagePath(url: string): boolean {
  return (url.startsWith("/") && !url.startsWith("//")) || /^[A-Za-z]:[\\/]/.test(url);
}

// Generated request labels add no information to cards or prompt bubbles.
// Keep labels inside quoted examples and code intact.
function requestLabelText(node: PhrasingContent): string | null {
  if (node.type === "text") return node.value;
  if ((node.type === "strong" || node.type === "emphasis") && node.children.length === 1 && node.children[0].type === "text") return node.children[0].value;
  return null;
}

function hideCardRequestLabels() {
  return (tree: Root) => {
    const leading = tree.children[0];
    if (leading && (leading.type === "heading" || leading.type === "paragraph") && leading.children.length === 1
      && /^My requests?:\s*$/i.test(requestLabelText(leading.children[0]) ?? "")) tree.children.shift();
    const first = tree.children[0];
    if (first?.type === "paragraph" && first.children[0]) {
      const label = first.children[0];
      if (label.type === "text") {
        label.value = label.value.replace(/^My requests?:[ \t]*(?:\r?\n)?/i, "");
        if (!label.value) first.children.shift();
      } else if (/^My requests?:\s*$/i.test(requestLabelText(label) ?? "")) {
        first.children.shift();
      } else return;
      if (first.children[0]?.type === "break") first.children.shift();
    }
  };
}

// Transform text nodes only: quoted code and existing links remain literal.
function annotationLinks() {
  return (tree: Root) => {
    const visit = (parent: Root | RootContent) => {
      if (!("children" in parent) || parent.type === "link") return;
      parent.children = parent.children.flatMap((child): (RootContent | PhrasingContent)[] => {
        if (child.type !== "text") { visit(child as RootContent); return [child]; }
        const parts: PhrasingContent[] = [];
        let end = 0;
        for (const match of child.value.matchAll(/:codex-annotation\{index="([1-9]\d*)"\}/g)) {
          if (match.index! > end) parts.push({ type: "text", value: child.value.slice(end, match.index) });
          parts.push({ type: "link", url: `#taskchef-annotation-${match[1]}`, children: [{ type: "text", value: `Annotation ${match[1]}` }] });
          end = match.index! + match[0].length;
        }
        if (!parts.length) return [child];
        if (end < child.value.length) parts.push({ type: "text", value: child.value.slice(end) });
        return parts;
      }) as typeof parent.children;
    };
    visit(tree);
  };
}

type Annotation = { text: string; annotation: string };
type AnnotationOpenChange = (id: string, opened: boolean) => void;
const AnnotationContext = createContext<{ items: Annotation[]; onOpenChange?: AnnotationOpenChange }>({ items: [] });
function AnnotationLink({ index }: { index: number }) {
  const { items, onOpenChange } = useContext(AnnotationContext);
  const annotation = items[index - 1];
  const popupId = useId();
  const label = annotation ? <div className="taskchef-annotation-popup">
    <div className="taskchef-annotation-label">Selected text:</div><div>{annotation.text}</div>
    <div className="taskchef-annotation-label">User comment:</div><div>{annotation.annotation.trim() || "—"}</div>
  </div> : "Annotation details unavailable.";
  const [opened, setOpened] = useState(false);
  useEffect(() => { onOpenChange?.(popupId, opened); return () => onOpenChange?.(popupId, false); }, [popupId, opened, onOpenChange]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const target = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const show = () => { if (timer.current) clearTimeout(timer.current); setOpened(true); };
  const leave = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!target.current?.contains(document.activeElement) && !popup.current?.contains(document.activeElement)) setOpened(false);
    }, 180);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return <Popover opened={opened} onChange={setOpened} withinPortal width={320} zIndex={500} position="bottom-start" middlewares={{ flip: true, shift: { crossAxis: true, padding: 12 } }}>
    <Popover.Target><button ref={target} type="button" className="taskchef-annotation-link" onMouseEnter={show} onMouseLeave={leave} onFocus={show} onBlur={leave}
      onClick={event => { event.stopPropagation(); show(); }} onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape") setOpened(false); }} aria-expanded={opened} aria-label={`Annotation ${index}`}>Annotation {index}</button></Popover.Target>
    <Popover.Dropdown ref={popup} role="tooltip" maw="calc(100vw - 24px)" className="taskchef-status-tooltip" onMouseEnter={show} onMouseLeave={leave} onFocus={show} onBlur={leave}
      onClick={event => event.stopPropagation()} onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape") setOpened(false); }}>{label}</Popover.Dropdown>
  </Popover>;
}

export function ReplyMarkdown({ text, compact = false, hideRequestLabels = false, renderImage, annotations = [], onAnnotationChange }: { text: string; compact?: boolean; hideRequestLabels?: boolean; renderImage?: (url: string, alt: string) => ReactNode; annotations?: Annotation[]; onAnnotationChange?: AnnotationOpenChange }) {
  const components = useMemo<Components>(() => ({
      a: ({ href, children }) => /^#taskchef-annotation-[1-9]\d*$/.test(href ?? "")
        ? <AnnotationLink index={Number(href!.split("-").at(-1))} /> : href
        ? <a href={href} target={href.startsWith("#") ? undefined : "_blank"} rel="noopener noreferrer">{children}</a>
        : <span>{children}</span>,
      img: ({ src, alt }) => src && renderImage && localImagePath(src) ? renderImage(src, alt || "Image") : src
        ? <a href={src} target="_blank" rel="noopener noreferrer">{alt || "Image"}</a>
        : <span>{alt || "Image"}</span>,
      table: ({ children }) => <div className="taskchef-markdown-table"><table>{children}</table></div>,
  }), [renderImage]);
  return <div className={`taskchef-markdown${compact ? " taskchef-markdown--compact" : ""}`}>
    <AnnotationContext value={{ items: annotations, onOpenChange: onAnnotationChange }}><Markdown skipHtml remarkPlugins={hideRequestLabels ? [remarkGfm, hideCardRequestLabels, annotationLinks] : [remarkGfm, annotationLinks]} urlTransform={(url, key) => key === "src" && renderImage && localImagePath(url) ? url : replyUrl(url)} components={components}>{text}</Markdown></AnnotationContext>
  </div>;
}
