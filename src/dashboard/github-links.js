const GITHUB_REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]+$/;
const REFERENCE_PATTERN = /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]+)\/(issues|pull)\/([1-9]\d*)(?![A-Za-z0-9_])|([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]+)#([1-9]\d*)(?![A-Za-z0-9_])|#([1-9]\d*)(?![A-Za-z0-9_])|https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?)\/?(?=$|[\s#),.;:!?'"\]}>])/gi;
const ABSOLUTE_HTTP_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;
export const MAX_RELATED_GITHUB_LINKS = 20;

function canonicalRepository(owner, repository) {
  return `${owner.toLowerCase()}/${repository.toLowerCase()}`;
}

function validRepositoryName(repository) {
  return repository !== "." && repository !== "..";
}

export function normalizeGitHubRepository(value) {
  if (typeof value !== "string") return null;
  let candidate = value.trim();
  const url = candidate.match(/^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+?)(?:\.git)?\/?$/i);
  if (url) candidate = `${url[1]}/${url[2]}`;
  if (!GITHUB_REPOSITORY.test(candidate)) return null;
  const [owner, repository] = candidate.split("/");
  if (!validRepositoryName(repository)) return null;
  return canonicalRepository(owner, repository);
}

function rawReferences(text) {
  const value = String(text ?? "");
  const absoluteRanges = absoluteHttpCandidates(value);
  const references = [];
  for (const match of value.matchAll(REFERENCE_PATTERN)) {
    const start = match.index;
    const preceding = start > 0 ? value[start - 1] : "";
    let explicitAbsoluteUrl = null;
    const containingAbsoluteUrl = absoluteRanges.find((range) => (
      start >= range.start && start < range.end
    ));
    if (containingAbsoluteUrl) {
      const explicitGitHubUrl = Boolean(match[1] || match[9]);
      let absoluteHost = null;
      try {
        absoluteHost = new URL(containingAbsoluteUrl.text).hostname.toLowerCase();
      } catch {
        // Invalid absolute URL tokens still block nested shorthand recognition.
      }
      const completeGitHubUrl = explicitGitHubUrl
        && start === containingAbsoluteUrl.start
        && (absoluteHost === "github.com" || absoluteHost === "www.github.com");
      if (!completeGitHubUrl) continue;
      const safeUrl = safeAbsoluteHttpUrl(containingAbsoluteUrl.text);
      if (!safeUrl) continue;
      explicitAbsoluteUrl = {
        end: containingAbsoluteUrl.end,
        suffix: containingAbsoluteUrl.text.slice(match[0].length),
        text: containingAbsoluteUrl.text,
      };
    }
    if (match[8] && /[\w&#/]/.test(preceding)) continue;
    if ((match[5] || match[1] || match[9]) && /[\w/]/.test(preceding)) continue;

    let owner = match[1] ?? match[5] ?? match[9] ?? null;
    let repository = match[2] ?? match[6] ?? match[10] ?? null;
    if (match[9]) repository = repository.replace(/\.git$/i, "");
    const number = match[4] ?? match[7] ?? match[8] ?? null;
    const pathType = match[3]?.toLowerCase();
    const type = match[9]
      ? "repository"
      : pathType === "pull" ? "pull" : pathType === "issues" ? "issue" : "generic";
    const explicit = Boolean(owner && repository);
    if (explicit) {
      if (!validRepositoryName(repository)) continue;
      const normalized = canonicalRepository(owner, repository);
      [owner, repository] = normalized.split("/");
    }
    references.push({
      end: explicitAbsoluteUrl?.end ?? start + match[0].length,
      explicit,
      number,
      owner,
      repository,
      start,
      text: explicitAbsoluteUrl?.text ?? match[0],
      type,
      urlSuffix: explicitAbsoluteUrl?.suffix ?? "",
    });
  }
  return references;
}

function uniqueExplicitRepository(references) {
  const repositories = new Set(
    references.filter(({ explicit }) => explicit).map(({ owner, repository }) => (
      `${owner}/${repository}`
    )),
  );
  return repositories.size === 1 ? [...repositories][0] : null;
}

function uniqueProjectRepository(projectRepositories) {
  const repositories = new Set(
    (projectRepositories ?? []).map(normalizeGitHubRepository).filter(Boolean),
  );
  return repositories.size === 1 ? [...repositories][0] : null;
}

function resolvedReference(reference, repositoryContext) {
  const repository = reference.explicit
    ? `${reference.owner}/${reference.repository}`
    : repositoryContext;
  if (!repository) return null;
  const [owner, repositoryName] = repository.split("/");
  if (reference.type === "repository") {
    return {
      kind: "link",
      label: `${owner}/${repositoryName}`,
      number: null,
      owner,
      provider: "github",
      repository: repositoryName,
      text: reference.text,
      type: reference.type,
      url: `https://github.com/${owner}/${repositoryName}${reference.urlSuffix}`,
    };
  }
  const path = reference.type === "pull" ? "pull" : "issues";
  return {
    kind: "link",
    label: `${owner}/${repositoryName}#${reference.number}`,
    number: reference.number,
    owner,
    provider: "github",
    repository: repositoryName,
    text: reference.text,
    type: reference.type,
    url: `https://github.com/${owner}/${repositoryName}/${path}/${reference.number}${reference.urlSuffix}`,
  };
}

function trimAbsoluteUrl(candidate) {
  let trimmed = candidate;
  let previous;
  do {
    previous = trimmed;
    trimmed = trimmed.replace(/[.,;:!?]+$/u, "");
    for (const [opening, closing] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
      while (trimmed.endsWith(closing)) {
        const openings = [...trimmed].filter((character) => character === opening).length;
        const closings = [...trimmed].filter((character) => character === closing).length;
        if (closings <= openings) break;
        trimmed = trimmed.slice(0, -1);
      }
    }
  } while (trimmed !== previous);
  return trimmed;
}

function absoluteHttpCandidates(text) {
  const candidates = [];
  for (const match of String(text ?? "").matchAll(ABSOLUTE_HTTP_PATTERN)) {
    const candidate = trimAbsoluteUrl(match[0]);
    if (!candidate) continue;
    candidates.push({
      end: match.index + candidate.length,
      start: match.index,
      text: candidate,
    });
  }
  return candidates;
}

function hasDotPathSegment(candidate) {
  const authorityAndPath = candidate.slice(candidate.indexOf("//") + 2).split(/[?#]/u, 1)[0];
  const pathStart = authorityAndPath.indexOf("/");
  if (pathStart < 0) return false;
  return authorityAndPath.slice(pathStart).split("/").some((segment) => {
    try {
      const decoded = decodeURIComponent(segment);
      return decoded === "." || decoded === "..";
    } catch {
      return true;
    }
  });
}

function safeAbsoluteHttpUrl(candidate) {
  try {
    const url = new URL(candidate);
    if (
      !url.hostname
      || url.username
      || url.password
      || candidate.includes("\\")
      || hasDotPathSegment(candidate)
    ) return null;
    return url.href;
  } catch {
    return null;
  }
}

function rawAbsoluteHttpReferences(text) {
  const references = [];
  for (const candidate of absoluteHttpCandidates(text)) {
    const url = safeAbsoluteHttpUrl(candidate.text);
    if (!url) continue;
    references.push({
      end: candidate.end,
      kind: "link",
      label: candidate.text,
      provider: "web",
      start: candidate.start,
      text: candidate.text,
      type: "url",
      url,
    });
  }
  return references;
}

export function githubReferenceSegments(text, {
  projectRepositories = [],
  taskRepository = null,
} = {}) {
  const value = String(text ?? "");
  const references = rawReferences(value);
  const sourceRepository = uniqueExplicitRepository(references);
  const repositoryContext = sourceRepository
    ?? normalizeGitHubRepository(taskRepository)
    ?? uniqueProjectRepository(projectRepositories);
  const segments = [];
  let offset = 0;
  for (const reference of references) {
    if (reference.start > offset) {
      segments.push({ kind: "text", text: value.slice(offset, reference.start) });
    }
    const resolved = resolvedReference(reference, repositoryContext);
    if (resolved) segments.push(resolved);
    else {
      segments.push({
        kind: "ambiguous",
        reason: `GitHub reference ${reference.text} is not linked because the repository is ambiguous.`,
        text: reference.text,
      });
    }
    offset = reference.end;
  }
  if (offset < value.length) segments.push({ kind: "text", text: value.slice(offset) });
  return segments;
}

export function referenceSegments(text, options = {}) {
  const value = String(text ?? "");
  const githubSegments = githubReferenceSegments(value, options);
  const references = [];
  let cursor = 0;
  for (const segment of githubSegments) {
    const start = value.indexOf(segment.text, cursor);
    if (start < 0) continue;
    if (segment.kind !== "text") {
      references.push({ end: start + segment.text.length, segment, start });
    }
    cursor = start + segment.text.length;
  }
  const absoluteReferences = rawAbsoluteHttpReferences(value).filter((reference) => (
    !references.some(({ end, start }) => reference.start < end && reference.end > start)
  ));
  if (absoluteReferences.length === 0) return githubSegments;

  references.push(...absoluteReferences.map((segment) => ({
    end: segment.end,
    segment,
    start: segment.start,
  })));
  references.sort((left, right) => left.start - right.start);

  const segments = [];
  let offset = 0;
  for (const reference of references) {
    if (reference.start < offset) continue;
    if (reference.start > offset) {
      segments.push({ kind: "text", text: value.slice(offset, reference.start) });
    }
    segments.push(reference.segment);
    offset = reference.end;
  }
  if (offset < value.length) segments.push({ kind: "text", text: value.slice(offset) });
  return segments;
}

function taskTexts(task) {
  const texts = [task.instruction];
  for (const turn of task.turns ?? []) {
    texts.push(turn.requestSummary, turn.result?.summary);
  }
  if (!(task.turns?.length > 0)) {
    for (const result of task.results ?? []) texts.push(result.summary);
    texts.push(task.summary);
  }
  return texts.filter((text) => typeof text === "string" && text.length > 0);
}

function relatedLinkLabel(link) {
  if (link.type === "repository") return `${link.owner}/${link.repository}`;
  return `${link.owner}/${link.repository}#${link.number}`;
}

export function taskGitHubProjection(task) {
  const texts = taskTexts(task);
  const explicitRepositories = new Set();
  for (const text of texts) {
    for (const reference of rawReferences(text)) {
      if (reference.explicit) {
        explicitRepositories.add(`${reference.owner}/${reference.repository}`);
      }
    }
  }
  const taskRepository = explicitRepositories.size === 1 ? [...explicitRepositories][0] : null;
  const links = [];
  const seen = new Set();
  let truncated = false;
  sourceLoop:
  for (const text of texts) {
    for (const segment of githubReferenceSegments(text, {
      projectRepositories: task.project?.githubRepos,
      taskRepository,
    })) {
      if (segment.kind !== "link") continue;
      const key = segment.url;
      if (seen.has(key)) continue;
      if (links.length === MAX_RELATED_GITHUB_LINKS) {
        truncated = true;
        break sourceLoop;
      }
      seen.add(key);
      links.push(segment);
    }
  }
  return {
    relatedGitHubLinks: links.map((link) => ({
      label: relatedLinkLabel(link),
      number: link.number,
      owner: link.owner,
      repository: link.repository,
      type: link.type,
      url: link.url,
    })),
    relatedGitHubLinksTruncated: truncated,
    relatedGitHubRepository: taskRepository,
  };
}
