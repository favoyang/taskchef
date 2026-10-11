import { IconClock } from "@tabler/icons-react";
import type { Task } from "../types";
import { ReplyMarkdown } from "./ReplyMarkdown";

export function TurnContent({ task, compact = false }: { task: Task; compact?: boolean }) {
  const prompt = compact ? task.promptExcerpt : task.promptText ?? task.promptExcerpt;
  const reply = compact ? task.replyExcerpt : task.replyText ?? task.replyExcerpt;
  return <div className={`taskchef-turn-content${compact ? " taskchef-turn-content--compact" : ""}`}>
    {prompt && <div className="taskchef-turn-prompt" aria-label="Latest turn request">
      {task.inputSource === "scheduled" && <IconClock className="taskchef-schedule-clock taskchef-prompt-clock" size={14} stroke={1.5} aria-label="Scheduled prompt" />}
      <ReplyMarkdown compact={compact} text={prompt} />
    </div>}
    {reply && <div className="taskchef-turn-response" aria-label="Latest turn response"><ReplyMarkdown compact={compact} text={reply} /></div>}
  </div>;
}
