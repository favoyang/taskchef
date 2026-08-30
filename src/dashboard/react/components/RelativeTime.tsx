import { Tooltip, UnstyledButton } from "@mantine/core";
import { IconClock } from "@tabler/icons-react";
import { createContext, useContext, useState, type ReactNode } from "react";
import { formatExactTime, formatRelativeTime } from "../../time.js";

const RelativeTimeClock = createContext<number | null>(null);

export function RelativeTimeProvider({ children, now }: { children: ReactNode; now: number }) {
  return <RelativeTimeClock value={now}>{children}</RelativeTimeClock>;
}

export function RelativeTime({ label, value }: { label: string; value: string | null | undefined }) {
  const [exact, setExact] = useState(false);
  useContext(RelativeTimeClock);
  const text = exact ? formatExactTime(value) : formatRelativeTime(value);
  return (
    <Tooltip label={exact ? "Show relative time" : "Show exact time"}>
      <UnstyledButton
        aria-label={`${label}: ${text}. ${exact ? "Show relative time" : "Show exact time"}`}
        className="taskchef-time"
        onClick={() => setExact((value) => !value)}
      >
        <IconClock aria-hidden size={12} />
        <span className="taskchef-time-label">{text}</span>
      </UnstyledButton>
    </Tooltip>
  );
}
