import { Anchor, Group, Text } from "@mantine/core";
import type { Task } from "../types";

export function GitHubLinks({ task }: { task: Task }) {
  const links = task.relatedGitHubLinks ?? [];
  if (links.length === 0 && !task.relatedGitHubLinksTruncated) return null;
  return (
    <Group aria-label={`Related GitHub links for ${task.title}`} component="nav" gap={5} wrap="wrap">
      {links.map((link) => (
        <Anchor
          aria-label={`${link.label}, GitHub ${link.type === "pull" ? "pull request" : link.type ?? "link"} (opens in a new tab)`}
          className="taskchef-github-link"
          href={link.url}
          key={link.url}
          rel="noopener noreferrer"
          size="xs"
          target="_blank"
        >
          {link.label}
        </Anchor>
      ))}
      {task.relatedGitHubLinksTruncated && <Text c="dimmed" size="xs">More links in task history</Text>}
    </Group>
  );
}
