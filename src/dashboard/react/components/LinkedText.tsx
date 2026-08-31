import { Anchor } from "@mantine/core";
import {
  githubReferenceAccessibleLabel,
  githubReferenceDisplayLabels,
  referenceSegments,
} from "../../github-links.js";
import type { Task } from "../types";

interface ReferenceSegment {
  kind: "ambiguous" | "link" | "text";
  label?: string;
  owner?: string;
  reason?: string;
  repository?: string;
  text: string;
  type?: "generic" | "issue" | "pull" | "repository";
  url?: string;
}

export function LinkedText({ task, text }: { task: Task; text: string }) {
  const segments = referenceSegments(text, {
    projectRepositories: task.project.githubRepos,
    taskRepository: task.relatedGitHubRepository,
  }) as ReferenceSegment[];
  const links = segments.filter((segment) => segment.kind === "link");
  const displayLabels = githubReferenceDisplayLabels(links) as string[];
  let linkIndex = 0;
  return segments.map((segment, index) => {
    if (segment.kind === "text") return segment.text;
    if (segment.kind === "ambiguous") {
      return (
        <span
          aria-label={segment.reason}
          className="taskchef-github-reference-ambiguous"
          key={`${index}:${segment.text}`}
          tabIndex={0}
          title={segment.reason}
        >
          {segment.text}
        </span>
      );
    }
    const displayLabel = displayLabels[linkIndex];
    linkIndex += 1;
    const kind = segment.type === "pull"
      ? ", GitHub pull request"
      : segment.type === "issue"
        ? ", GitHub issue"
        : segment.owner ? " on GitHub" : "";
    return (
      <Anchor
        aria-label={`${githubReferenceAccessibleLabel(segment)}${kind} (opens in a new tab)`}
        className="taskchef-github-link"
        href={segment.url}
        key={`${index}:${segment.url}`}
        rel="noopener noreferrer"
        target="_blank"
      >
        {displayLabel}
      </Anchor>
    );
  });
}
