import { semanticHash, taskChefError } from "./state-store.js";

function fieldsChanged(before, after) {
  const fields = {};
  for (const key of ["name", "description", "isGitRepository", "githubRepos"]) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      fields[key] = { before: before[key] ?? null, after: after[key] ?? null };
    }
  }
  return fields;
}

export function projectSetHash(projects) {
  return semanticHash({ schemaVersion: 1, projects }, "taskchef-project-set-v1");
}

export function configHash(config) {
  return semanticHash(config, "taskchef-config-v1");
}

export function projectDiff(beforeProjects, afterProjects) {
  const before = new Map(beforeProjects.map((project) => [project.path, project]));
  const after = new Map(afterProjects.map((project) => [project.path, project]));
  const added = [];
  const changed = [];
  const removed = [];
  for (const project of afterProjects) {
    const prior = before.get(project.path);
    if (!prior) added.push(project);
    else {
      const fields = fieldsChanged(prior, project);
      if (Object.keys(fields).length) changed.push({ path: project.path, before: prior, after: project, fields });
    }
  }
  for (const project of beforeProjects) {
    if (!after.has(project.path)) removed.push(project);
  }
  return { added, changed, removed };
}

export function mutationPreview(workspace, operation, beforeConfig, afterConfig) {
  const diff = projectDiff(beforeConfig.projects, afterConfig.projects);
  const preview = {
    schemaVersion: 1,
    operation,
    beforeConfigHash: configHash(beforeConfig),
    afterConfigHash: configHash(afterConfig),
    beforeProjectSetHash: projectSetHash(beforeConfig.projects),
    afterProjectSetHash: projectSetHash(afterConfig.projects),
    beforeCount: beforeConfig.projects.length,
    afterCount: afterConfig.projects.length,
    diff,
    projects: afterConfig.projects,
  };
  return {
    ...preview,
    planHash: semanticHash({
      schemaVersion: 1,
      workspace,
      operation,
      beforeConfigHash: preview.beforeConfigHash,
      afterConfigHash: preview.afterConfigHash,
      diff,
    }, "taskchef-mutation-plan-v1"),
  };
}

function exactStringSet(actual, expected) {
  if (!Array.isArray(actual) || new Set(actual).size !== actual.length) return false;
  return actual.length === expected.length
    && [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}

export function assertMutationAuthorization(preview, authorization = {}, {
  destructive = preview.diff.removed.length > 0,
  replacement = false,
} = {}) {
  if (authorization.expectConfigHash !== preview.beforeConfigHash) {
    throw taskChefError("STALE_PREVIEW", "configuration changed or --expect-config-hash is missing", preview);
  }
  if (!destructive && !replacement) return;
  const removedNames = preview.diff.removed.map((project) => project.name);
  if (authorization.expectProjectCount !== preview.beforeCount
    || authorization.expectAfterCount !== preview.afterCount
    || authorization.confirmPlan !== preview.planHash
    || !exactStringSet(authorization.confirmRemoved, removedNames)) {
    throw taskChefError(
      "CONFIRMATION_REQUIRED",
      "destructive project mutation requires exact preview-bound count, hash, plan, and removed-name confirmation",
      preview,
    );
  }
  const collapses = preview.beforeCount > 0
    && (preview.afterCount === 0 || preview.afterCount / preview.beforeCount <= 0.5);
  if (collapses && authorization.confirmCountCollapse !== `${preview.beforeCount}:${preview.afterCount}`) {
    throw taskChefError("CONFIRMATION_REQUIRED", "project-count collapse requires exact before:after confirmation", preview);
  }
}
