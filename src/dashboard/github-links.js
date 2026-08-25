const GITHUB_REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]+$/;
const REFERENCE_PATTERN = /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]+)\/(issues|pull)\/([1-9]\d*)(?![A-Za-z0-9_])|([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]+)#([1-9]\d*)(?![A-Za-z0-9_])|#([1-9]\d*)(?![A-Za-z0-9_])/gi;
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
  const references = [];
  for (const match of value.matchAll(REFERENCE_PATTERN)) {
    const start = match.index;
    const preceding = start > 0 ? value[start - 1] : "";
    if (match[8] && /[\w&#/]/.test(preceding)) continue;
    if ((match[5] || match[1]) && /[\w/]/.test(preceding)) continue;

    let owner = match[1] ?? match[5] ?? null;
    let repository = match[2] ?? match[6] ?? null;
    const number = match[4] ?? match[7] ?? match[8];
    const pathType = match[3]?.toLowerCase();
    const type = pathType === "pull" ? "pull" : pathType === "issues" ? "issue" : "generic";
    const explicit = Boolean(owner && repository);
    if (explicit) {
      if (!validRepositoryName(repository)) continue;
      const normalized = canonicalRepository(owner, repository);
      [owner, repository] = normalized.split("/");
    }
    references.push({
      end: start + match[0].length,
      explicit,
      number,
      owner,
      repository,
      start,
      text: match[0],
      type,
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
  const path = reference.type === "pull" ? "pull" : "issues";
  return {
    kind: "link",
    number: reference.number,
    owner,
    repository: repositoryName,
    text: reference.text,
    type: reference.type,
    url: `https://github.com/${owner}/${repositoryName}/${path}/${reference.number}`,
  };
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

function relatedLinkLabel(link, includeRepository, includeOwner) {
  const reference = link.type === "pull"
    ? `PR #${link.number}`
    : link.type === "issue"
      ? `Issue #${link.number}`
      : `#${link.number}`;
  if (!includeRepository) return reference;
  const repository = includeOwner ? `${link.owner}/${link.repository}` : link.repository;
  return `${repository} ${reference}`;
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
      const key = segment.url.toLowerCase();
      if (seen.has(key)) continue;
      if (links.length === MAX_RELATED_GITHUB_LINKS) {
        truncated = true;
        break sourceLoop;
      }
      seen.add(key);
      links.push(segment);
    }
  }
  const repositories = new Set(links.map(({ owner, repository }) => `${owner}/${repository}`));
  const repositoryNames = new Map();
  for (const link of links) {
    const owners = repositoryNames.get(link.repository) ?? new Set();
    owners.add(link.owner);
    repositoryNames.set(link.repository, owners);
  }
  const includeRepository = repositories.size > 1;
  return {
    relatedGitHubLinks: links.map((link) => ({
      label: relatedLinkLabel(link, includeRepository, repositoryNames.get(link.repository).size > 1),
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
