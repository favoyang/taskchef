import { Button } from "@mantine/core";
import { IconArrowUpRight } from "@tabler/icons-react";

export function OpenChatButton({
  loading,
  onClick,
  taskTitle,
}: {
  loading?: boolean;
  onClick: () => void;
  taskTitle: string;
}) {
  return (
    <Button
      aria-label={`Open chat for ${taskTitle}`}
      leftSection={<IconArrowUpRight aria-hidden size={15} stroke={1.6} />}
      loading={loading}
      onClick={onClick}
      size="compact-sm"
      variant="default"
    >
      Open chat
    </Button>
  );
}
