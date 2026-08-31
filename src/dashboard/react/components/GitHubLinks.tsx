import { Anchor, Box, Group, Text } from "@mantine/core";
import {
  githubReferenceAccessibleLabel,
  githubReferenceDisplayLabels,
  groupRelatedGitHubLinks,
} from "../../github-links.js";
import type { GitHubLink, Task } from "../types";

export function GitHubLinks({ task }: { task: Task }) {
  const links = task.relatedGitHubLinks ?? [];
  if (links.length === 0 && !task.relatedGitHubLinksTruncated) return null;
  const groups = groupRelatedGitHubLinks(links) as GitHubLink[][];
  const displayLabels = githubReferenceDisplayLabels(groups.flat(), { related: true }) as string[];
  let linkIndex = 0;
  return (
    <Box aria-label={`Related GitHub links for ${task.title}`} className="taskchef-github-groups" component="nav">
      {groups.map((group) => (
        <Group className="taskchef-github-group" gap={5} key={`${group[0].owner}/${group[0].repository}`} wrap="wrap">
          {group.map((link) => {
            const displayLabel = displayLabels[linkIndex];
            linkIndex += 1;
            const kind = link.type === "pull"
              ? ", GitHub pull request"
              : link.type === "issue"
                ? ", GitHub issue"
                : " on GitHub";
            return (
              <Anchor
                aria-label={`${githubReferenceAccessibleLabel(link)}${kind} (opens in a new tab)`}
                className="taskchef-github-link"
                href={link.url}
                key={link.url}
                rel="noopener noreferrer"
                size="xs"
                target="_blank"
              >
                {displayLabel}
              </Anchor>
            );
          })}
        </Group>
      ))}
      {task.relatedGitHubLinksTruncated && <Text c="dimmed" size="xs">More links in task history</Text>}
    </Box>
  );
}
