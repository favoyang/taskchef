import os from "node:os";
import path from "node:path";

export const TASKCHEF_WORKSPACE_ENV = "TASKCHEF_WORKSPACE";

export function defaultWorkspacePath({ homedir = os.homedir() } = {}) {
  return path.join(homedir, ".agents", "taskchef");
}

function expandHome(value, homedir) {
  if (value === "~") return homedir;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(homedir, value.slice(2));
  }
  return value;
}

export function resolveWorkspacePath({
  explicit = null,
  env = process.env,
  homedir = os.homedir(),
  cwd = process.cwd(),
} = {}) {
  let source = "default";
  let value = defaultWorkspacePath({ homedir });
  if (env[TASKCHEF_WORKSPACE_ENV] !== undefined) {
    if (typeof env[TASKCHEF_WORKSPACE_ENV] !== "string" || env[TASKCHEF_WORKSPACE_ENV].trim() === "") {
      throw new Error(`${TASKCHEF_WORKSPACE_ENV} must be a non-empty path`);
    }
    source = "environment";
    value = env[TASKCHEF_WORKSPACE_ENV];
  }
  if (explicit !== null) {
    if (typeof explicit !== "string" || explicit.trim() === "") {
      throw new Error("--workspace must be a non-empty path");
    }
    source = "explicit";
    value = explicit;
  }
  const expanded = expandHome(value, homedir);
  if (source === "environment" && !path.isAbsolute(expanded)) {
    throw new Error(`${TASKCHEF_WORKSPACE_ENV} must be an absolute path or start with ~/`);
  }
  return {
    workspace: path.resolve(cwd, expanded),
    source,
  };
}
