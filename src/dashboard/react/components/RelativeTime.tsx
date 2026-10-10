import { Tooltip, UnstyledButton } from "@mantine/core";
import { IconClock, IconHourglass } from "@tabler/icons-react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { formatCardTime, formatExactTime, formatRelativeTime, formatWorkedDuration } from "../../time.js";

const RelativeTimeClock = createContext<number | null>(null);

export function RelativeTimeProvider({ children, now }: { children: ReactNode; now: number }) {
  return <RelativeTimeClock value={now}>{children}</RelativeTimeClock>;
}

export function ElapsedTime({ startedAt, tooltipEnabled = true }: { startedAt: string | null | undefined; tooltipEnabled?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  const start = startedAt ? Date.parse(startedAt) : NaN;
  const available = Number.isFinite(start);
  useEffect(() => {
    if (!available) return;
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [available, startedAt]);
  const text = available ? formatWorkedDuration(Math.max(0, now - start)) : "—";
  const tooltip = available ? `Worked for ${text} · Started ${formatExactTime(startedAt)}` : "Turn start time unavailable";
  return <Tooltip disabled={!tooltipEnabled} events={{ focus: true, hover: true, touch: false }} label={tooltip}>
    <span aria-label={`Elapsed time: ${text}. ${tooltip}`} className="taskchef-time" tabIndex={0}>
      <IconHourglass aria-hidden size={12} />
      <bdi className="taskchef-time-label">{text}</bdi>
    </span>
  </Tooltip>;
}

export function RelativeTime({
  icon,
  calendar = false,
  label,
  value,
  durationMs,
  tooltipEnabled = true,
}: {
  icon?: ReactNode;
  calendar?: boolean;
  label: string;
  value: string | null | undefined;
  durationMs?: number | null;
  tooltipEnabled?: boolean;
}) {
  const [exact, setExact] = useState(false);
  const now = useContext(RelativeTimeClock) ?? Date.now();
  const shortText = calendar ? formatCardTime(value, { now }) : formatRelativeTime(value);
  const text = exact ? formatExactTime(value) : shortText;
  const exactText = formatExactTime(value);
  const unavailable = exactText === "—";
  const duration = formatWorkedDuration(durationMs);
  const tooltip = durationMs !== undefined
    ? duration === "—" ? "Run duration unavailable" : `Worked for ${duration}`
    : unavailable ? "Updated time unavailable" : exact ? shortText : exactText;
  return (
    <Tooltip disabled={!tooltipEnabled} events={{ focus: true, hover: true, touch: false }} label={tooltip}>
      <UnstyledButton
        aria-label={unavailable
          ? `${label}: unavailable.`
          : `${label}: ${text}. ${exact ? calendar ? "Show card date" : "Show relative time" : "Show exact time"}`}
        className="taskchef-time"
        disabled={unavailable}
        onClick={() => setExact((value) => !value)}
      >
        {icon === undefined ? <IconClock aria-hidden size={12} /> : icon}
        <bdi className="taskchef-time-label">{text}</bdi>
      </UnstyledButton>
    </Tooltip>
  );
}
