import { CollapsedMarkdown } from "./TurnContent";
import type { Task } from "../types";
import { ReplyMarkdown } from "./ReplyMarkdown";
import { ImageGallery } from "./ImageGallery";
import { ReplyCover } from "./ReplyCover";

function QueueIcon() {
  return <svg className="taskchef-queue-icon" width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.33" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3.33 3.33V11c0 3.2.8 4 4 4h9.34M14.58 12.92 16.67 15l-2.09 2.08M7.5 5h6.67M7.5 9.58h4.17" />
  </svg>;
}

export function QueuedPrompts({ task, compact = false, loadImage, onLightboxChange, onOpen }: { task: Task; compact?: boolean; loadImage?: (task: Task, url?: string) => Promise<string | null>; onLightboxChange?: (opened: boolean) => void; onOpen?: () => void }) {
  if (!task.queuedPrompts?.length) return null;
  return <section className={`taskchef-queued-prompts${compact ? " is-compact" : ""}`} aria-label="Queued prompts">
    <div className="taskchef-queued-heading">{compact ? `${task.queuedPrompts.length} queued` : `Queued prompts (${task.queuedPrompts.length})`}</div>
    <ol>{task.queuedPrompts.map(prompt => compact
      ? <li key={prompt.id}>
        <QueueIcon />
        {loadImage && onOpen && prompt.images[0] && <ReplyCover task={task} image={prompt.images[0]} loadImage={loadImage} onOpen={onOpen} />}
        <span><ReplyMarkdown text={prompt.text} compact hideRequestLabels renderImage={() => null} /></span>
      </li>
      : <QueuedPrompt key={prompt.id} task={task} prompt={prompt} loadImage={loadImage} onLightboxChange={onLightboxChange} />)}</ol>
  </section>;
}
function QueuedPrompt({ task, prompt, loadImage, onLightboxChange }: { task: Task; prompt: NonNullable<Task['queuedPrompts']>[number]; loadImage?: (task: Task, url?: string) => Promise<string | null>; onLightboxChange?: (opened: boolean) => void }) {
  return <li>
    <QueueIcon />
    <div className="taskchef-queue-content">
    {loadImage && prompt.images.length > 0 && <ImageGallery task={task} images={prompt.images} loadImage={loadImage} onLightboxChange={onLightboxChange} />}
    <CollapsedMarkdown text={prompt.text} />
    </div>
  </li>;
}
