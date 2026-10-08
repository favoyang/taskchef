import { Tooltip, UnstyledButton } from "@mantine/core";
import { IconClock } from "@tabler/icons-react";
import { createContext, useContext, useState, type ReactNode } from "react";
import { formatCardTime, formatExactTime, formatRelativeTime } from "../../time.js";

const RelativeTimeClock = createContext<number | null>(null);

export function RelativeTimeProvider({ children, now }: { children: ReactNode; now: number }) {
  return <RelativeTimeClock value={now}>{children}</RelativeTimeClock>;
}

export function RelativeTime({
  icon,
  calendar = false,
  label,
  value,
}: {
  icon?: ReactNode;
  calendar?: boolean;
  label: string;
  value: string | null | undefined;
}) {
  const [exact, setExact] = useState(false);
  const now = useContext(RelativeTimeClock) ?? Date.now();
  const shortText = calendar ? formatCardTime(value, { now }) : formatRelativeTime(value);
  const text = exact ? formatExactTime(value) : shortText;
  const exactText = formatExactTime(value);
  const unavailable = exactText === "—";
  const tooltip = unavailable ? "Updated time unavailable" : exact ? shortText : exactText;
  return (
    <Tooltip events={{ focus: true, hover: true, touch: false }} label={tooltip}>
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
