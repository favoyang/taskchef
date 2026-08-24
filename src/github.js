function requireRepositoryString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function parseGithubUrl(value, name, { allowIssueOrPull = false } = {}) {
  let remote = requireRepositoryString(value, name);
  const scpMatch = remote.match(/^git@github\.com:([^/]+)\/([^/]+)\/?$/i);
  if (scpMatch) {
    return {
      owner: scpMatch[1],
      repository: scpMatch[2].replace(/\.git$/i, ""),
    };
  }
  if (/^(?:www\.)?github\.com\//i.test(remote)) remote = `https://${remote}`;
  let url;
  try {
    url = new URL(remote);
  } catch {
    throw new Error(`${name} must be a GitHub repository URL`);
  }
  if (
    !["https:", "http:", "ssh:", "git:"].includes(url.protocol)
    || !["github.com", "www.github.com"].includes(url.hostname.toLowerCase())
    || (url.username && !(url.protocol === "ssh:" && url.username === "git"))
    || url.password
    || url.port
    || (!allowIssueOrPull && (url.search || url.hash))
  ) {
    throw new Error(`${name} must be a GitHub repository URL`);
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) throw new Error(`${name} must identify one GitHub repository`);
  const suffix = segments.slice(2);
  if (
    (!allowIssueOrPull && suffix.length > 0)
    || (
      allowIssueOrPull
      && suffix.length > 0
      && !(suffix.length >= 2 && ["issues", "pull"].includes(suffix[0]) && /^\d+$/.test(suffix[1]))
    )
  ) {
    throw new Error(`${name} must identify one GitHub repository`);
  }
  return {
    owner: segments[0],
    repository: segments[1].replace(/\.git$/i, ""),
  };
}

export function canonicalGithubRepository(value, name = "githubRepos") {
  const { owner, repository } = parseGithubUrl(value, name);
  if (repository.length === 0) throw new Error(`${name} must identify one GitHub repository`);
  return `https://github.com/${owner}/${repository}`;
}

export function normalizeGithubRepositories(
  value,
  name = "githubRepos",
) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array of GitHub repository URLs`);
  const repositories = [];
  const seen = new Set();
  for (const [index, repository] of value.entries()) {
    const canonical = canonicalGithubRepository(repository, `${name}[${index}]`);
    const key = canonical.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      repositories.push(canonical);
    }
  }
  return repositories;
}

export function matchProjectForGithubUrl(value, projects) {
  if (!Array.isArray(projects)) throw new Error("projects must be an array");
  let parsed;
  try {
    parsed = parseGithubUrl(value, "GitHub URL", { allowIssueOrPull: true });
  } catch {
    return { status: "unmatched", repository: null, projects: [] };
  }
  const repository = `https://github.com/${parsed.owner}/${parsed.repository}`;
  const key = repository.toLowerCase();
  const matches = projects.filter((project) =>
    Array.isArray(project?.githubRepos)
    && project.githubRepos.some((candidate) => {
      try {
        return canonicalGithubRepository(candidate).toLowerCase() === key;
      } catch {
        return false;
      }
    }));
  if (matches.length === 1) {
    return { status: "matched", repository, project: matches[0], projects: matches };
  }
  return {
    status: matches.length > 1 ? "ambiguous" : "unmatched",
    repository,
    projects: matches,
  };
}
