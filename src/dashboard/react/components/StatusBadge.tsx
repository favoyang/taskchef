import { Badge } from "@mantine/core";
import { statusColor, statusLabel } from "../presentation";
import type { Task } from "../types";

export function StatusBadge({ status }: { status: Task["status"] | "interrupted" }) {
  return <Badge className="taskchef-status-badge" color={statusColor(status)} size="sm" variant="light">{statusLabel(status)}</Badge>;
}
