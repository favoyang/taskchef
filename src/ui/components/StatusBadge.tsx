import { Badge } from "@mantine/core";
import { statusColor, statusLabel } from "../presentation";
import type { Task } from "../types";

export function StatusBadge({ status, label }: { status: Task["status"] | "interrupted"; label?: string }) {
  return <Badge className="taskchef-status-badge" color={statusColor(status)} size="sm" variant="light">{label ?? statusLabel(status)}</Badge>;
}
