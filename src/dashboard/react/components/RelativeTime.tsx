import { Tooltip, UnstyledButton } from "@mantine/core";
import { IconClock } from "@tabler/icons-react";
import { createContext, useContext, useState, type ReactNode } from "react";
import { formatExactTime, formatRelativeTime } from "../../time.js";

const RelativeTimeClock = createContext<number | null>(null);

export function RelativeTimeProvider({ children, now }: { children: ReactNode; now: number }) {
  return <RelativeTimeClock value={now}>{children}</RelativeTimeClock>;
}

export function RelativeTime({
  icon,
  label,
  tooltipLabel,
  value,
}: {
  icon?: ReactNode;
  label: string;
  tooltipLabel?: string;
  value: string | null | undefined;
}) {
  const [exact, setExact] = useState(false);
  useContext(RelativeTimeClock);
  const text = exact ? formatExactTime(value) : formatRelativeTime(value);
  const exactText = formatExactTime(value);
  const unavailable = exactText === "—";
  const tooltip = exactText === "—"
    ? "Updated time unavailable"
    : exact
      ? "Show relative time"
      : `Exact time: ${exactText}. Show exact time`;
  return (
    <Tooltip events={{ focus: true, hover: true, touch: false }} label={tooltipLabel ?? tooltip}>
      <UnstyledButton
        aria-label={unavailable
          ? `${label}: unavailable.`
          : `${label}: ${text}. ${exact ? "Show relative time" : "Show exact time"}`}
        className="taskchef-time"
        disabled={unavailable}
        onClick={() => setExact((value) => !value)}
      >
        {icon ?? <IconClock aria-hidden size={12} />}
        <bdi className="taskchef-time-label">{text}</bdi>
      </UnstyledButton>
    </Tooltip>
  );
}
