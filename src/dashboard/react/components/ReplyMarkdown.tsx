import { useMemo, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PhrasingContent, Root } from "mdast";

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
    tree.children = tree.children.filter(node => !(
      (node.type === "heading" || node.type === "paragraph") && node.children.length === 1
      && /^My requests?:\s*$/i.test(requestLabelText(node.children[0]) ?? "")
    ));
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

export function ReplyMarkdown({ text, compact = false, hideRequestLabels = false, renderImage }: { text: string; compact?: boolean; hideRequestLabels?: boolean; renderImage?: (url: string, alt: string) => ReactNode }) {
  const components = useMemo<Components>(() => ({
      a: ({ href, children }) => href
        ? <a href={href} target={href.startsWith("#") ? undefined : "_blank"} rel="noopener noreferrer">{children}</a>
        : <span>{children}</span>,
      img: ({ src, alt }) => src && renderImage && localImagePath(src) ? renderImage(src, alt || "Image") : src
        ? <a href={src} target="_blank" rel="noopener noreferrer">{alt || "Image"}</a>
        : <span>{alt || "Image"}</span>,
      table: ({ children }) => <div className="taskchef-markdown-table"><table>{children}</table></div>,
  }), [renderImage]);
  return <div className={`taskchef-markdown${compact ? " taskchef-markdown--compact" : ""}`}>
    <Markdown skipHtml remarkPlugins={compact || hideRequestLabels ? [remarkGfm, hideCardRequestLabels] : [remarkGfm]} urlTransform={(url, key) => key === "src" && renderImage && localImagePath(url) ? url : replyUrl(url)} components={components}>{text}</Markdown>
  </div>;
}
