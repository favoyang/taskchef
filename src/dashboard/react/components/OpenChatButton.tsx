import { Button } from "@mantine/core";
import { IconExternalLink } from "@tabler/icons-react";

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
      leftSection={<IconExternalLink aria-hidden size={15} />}
      loading={loading}
      onClick={onClick}
      size="compact-sm"
      variant="default"
    >
      Open chat
    </Button>
  );
}
