import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Saved replies are untrusted text. Do not execute HTML or load remote images.
function replyUrl(url: string): string {
  return /^(https?:|mailto:)/i.test(url) || url.startsWith("#") ? url : "";
}

export function ReplyMarkdown({ text, compact = false }: { text: string; compact?: boolean }) {
  return <div className={`taskchef-markdown${compact ? " taskchef-markdown--compact" : ""}`}>
    <Markdown skipHtml remarkPlugins={[remarkGfm]} urlTransform={replyUrl} components={{
      a: ({ href, children }) => href
        ? <a href={href} target={href.startsWith("#") ? undefined : "_blank"} rel="noopener noreferrer">{children}</a>
        : <span>{children}</span>,
      img: ({ src, alt }) => src
        ? <a href={src} target="_blank" rel="noopener noreferrer">{alt || "Image"}</a>
        : <span>{alt || "Image"}</span>,
      table: ({ children }) => <div className="taskchef-markdown-table"><table>{children}</table></div>,
    }}>{text}</Markdown>
  </div>;
}
