import { IconClock } from "@tabler/icons-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { Task } from "../types";
import { ReplyMarkdown } from "./ReplyMarkdown";

function CollapsedMarkdown({ text }: { text: string }) {
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
    <div ref={content} className={expanded ? "" : "taskchef-turn-collapsed"}><ReplyMarkdown text={text} /></div>
    {(clipped || expanded) && <button type="button" className="taskchef-turn-expand" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? "Show less" : "Show more…"}</button>}
  </>;
}

export function TurnContent({ task, compact = false }: { task: Task; compact?: boolean }) {
  const prompt = compact ? task.promptExcerpt : task.promptText ?? task.promptExcerpt;
  const reply = compact ? task.replyExcerpt : task.replyText ?? task.replyExcerpt;
  if (compact) {
    const text = task.status === "working" ? prompt : reply;
    return text ? <div className="taskchef-turn-card" aria-label={task.status === "working" ? "Latest turn request" : "Latest turn response"}><ReplyMarkdown compact text={text} /></div> : null;
  }
  return <div className="taskchef-turn-content">
    {prompt && <div className="taskchef-turn-prompt" aria-label="Latest turn request">
      {task.inputSource === "scheduled" && <IconClock className="taskchef-schedule-clock taskchef-prompt-clock" size={14} stroke={1.5} aria-label="Scheduled prompt" />}
      <CollapsedMarkdown key={`prompt:${task.id}:${task.turnId}`} text={prompt} />
    </div>}
    {reply && <div className="taskchef-turn-response" aria-label="Latest turn response"><CollapsedMarkdown key={`reply:${task.id}:${task.turnId}`} text={reply} /></div>}
  </div>;
}
