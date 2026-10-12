import { IconClock } from "@tabler/icons-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { Task } from "../types";
import { ImageGallery } from "./ImageGallery";
import { ReplyImagePreview } from "./ReplyImagePreview";
import { formatWorkedDuration } from "../time.js";
import { ReplyMarkdown } from "./ReplyMarkdown";

const hidePromptImage = () => null;

export function CollapsedMarkdown({ text }: { text: string }) {
  const content = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const element = content.current;
    if (!element || expanded) return;
    const measure = () => setClipped(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, expanded]);
  return <>
    <div ref={content} className={expanded ? "" : "taskchef-turn-collapsed"}><ReplyMarkdown text={text} hideRequestLabels renderImage={hidePromptImage} /></div>
    {(clipped || expanded) && <button type="button" className="taskchef-turn-expand" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? "Show less" : "Show more…"}</button>}
  </>;
}

export function TurnContent({ task, compact = false, loadImage, workedDurationMs, onLightboxChange, onAnnotationChange }: { task: Task; compact?: boolean; loadImage?: (task: Task, url?: string) => Promise<string | null>; workedDurationMs?: number | null; onLightboxChange?: (opened: boolean) => void; onAnnotationChange?: (id: string, opened: boolean) => void }) {
  const currentTask = useRef(task);
  currentTask.current = task;
  const renderImage = useCallback((url: string, alt: string) => loadImage ? <ReplyImagePreview key={`${task.id}:${task.turnId}:${url}`} task={currentTask.current} url={url} alt={alt} loadImage={loadImage} onLightboxChange={onLightboxChange} /> : null, [task.id, task.turnId, loadImage, onLightboxChange]);
  const prompt = compact ? task.promptExcerpt : task.promptText ?? task.promptExcerpt;
  const reply = compact ? task.replyExcerpt : task.replyText ?? task.replyExcerpt;
  if (compact) {
    const text = task.status === "working" ? prompt : reply;
    return text ? <div className="taskchef-turn-card" aria-label={task.status === "working" ? "Latest turn request" : "Latest turn response"}><ReplyMarkdown key={`${task.id}:${task.turnId}`} compact annotations={task.annotations} hideRequestLabels={task.status === "working"} text={text} renderImage={task.status === "working" ? hidePromptImage : undefined} /></div> : null;
  }
  const promptImages = task.promptImages ?? (task.promptImage ? [task.promptImage] : []);
  const duration = workedDurationMs ?? task.observed?.latestTurnDurationMs;
  return <div className="taskchef-turn-content">
    {prompt && <div className="taskchef-turn-prompt" aria-label="Latest turn request">
      {task.inputSource === "scheduled" && <IconClock className="taskchef-schedule-clock taskchef-prompt-clock" size={14} stroke={1.5} aria-label="Scheduled prompt" />}
      {loadImage && promptImages.length > 0 && <ImageGallery task={task} images={promptImages} loadImage={loadImage} onLightboxChange={onLightboxChange} />}
      <CollapsedMarkdown key={`prompt:${task.id}:${task.turnId}`} text={prompt} />
    </div>}
    {reply && <>
      <div className="taskchef-turn-divider" role="separator">{duration != null && Number.isFinite(duration) && duration >= 0 ? `Worked for ${formatWorkedDuration(duration)}` : null}</div>
      <div className="taskchef-turn-response" aria-label="Latest turn response"><ReplyMarkdown key={`${task.id}:${task.turnId}`} onAnnotationChange={onAnnotationChange} annotations={task.annotations} text={reply} renderImage={loadImage ? renderImage : undefined} /></div>
    </>}
  </div>;
}
