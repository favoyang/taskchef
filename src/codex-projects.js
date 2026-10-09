import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, relative, sep } from "node:path";

export const NO_PROJECT = "projectless";
const contains = (root, cwd) => {
  const child = relative(root, cwd);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
};

// Only the project-related fields leave this reader. Never return the desktop's other saved settings.
export class CodexProjects {
  constructor(codexHome) { this.codexHome = codexHome; this.saved = null; }
  async desktopProjects() {
    const file = join(this.codexHome, ".codex-global-state.json");
    let stamp;
    try {
      const info = await stat(file, { bigint: true });
      stamp = `${info.ino}:${info.mtimeNs}:${info.ctimeNs}:${info.size}`;
    } catch (error) { if (error.code === "ENOENT") return {}; throw error; }
    if (this.saved?.stamp === stamp) return this.saved.data;
    const state = JSON.parse(await readFile(file, "utf8"));
    const data = {
      assignments: state["thread-project-assignments"] ?? {},
      hints: state["thread-workspace-root-hints"] ?? {}, projectless: new Set(state["projectless-thread-ids"] ?? []),
      ids: state["app-server-project-id-by-legacy-project-id-by-host"]?.[`local:${this.codexHome}`] ?? {},
    };
    this.saved = { stamp, data };
    return data;
  }
  async worktreeRoot(cwd) {
    // Chats can start below the checkout root. Stop at the nearest Git boundary.
    for (let directory = resolve(cwd); ; directory = dirname(directory)) {
      let pointer;
      try { pointer = await readFile(join(directory, ".git"), "utf8"); }
      catch (error) {
        if (error.code === "EISDIR") return null;
        if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
      }
      if (pointer !== undefined) {
        const match = /^gitdir: (.+)\s*$/.exec(pointer.trim());
        if (!match) return null;
        const gitdir = resolve(directory, match[1]);
        try {
          const common = (await readFile(join(gitdir, "commondir"), "utf8")).trim();
          return dirname(resolve(gitdir, common));
        } catch (error) {
          if (["ENOENT", "ENOTDIR"].includes(error.code)) return null;
          throw error;
        }
      }
      if (dirname(directory) === directory) return null;
    }
  }
  async group(tasks, registry) {
    const saved = await this.desktopProjects();
    const projects = registry.map((project) => ({ ...project, roots: [...project.roots] }));
    const byId = new Map(projects.map((project) => [project.id, project]));
    const matchRoot = (cwd) => projects.flatMap((project) => project.roots.map((root) => ({ project, root })))
      .filter(({ root }) => cwd && contains(root, cwd)).sort((a, b) => b.root.length - a.root.length)[0]?.project;
    const origins = new Map();
    const projectlessRoot = join(homedir(), "Documents", "Codex");
    const grouped = await Promise.all(tasks.map(async (task) => {
      const cwd = task.project.path;
      const assignment = saved.assignments?.[task.id];
      const assignedId = assignment?.projectKind === "local" ? saved.ids?.[assignment.projectId] ?? assignment.projectId : null;
      const explicit = byId.get(task.project.id) ?? byId.get(assignedId);
      const noProject = !explicit && (saved.projectless?.has(task.id) || (cwd && contains(projectlessRoot, cwd)) || !cwd);
      const hinted = matchRoot(saved.hints?.[task.id]);
      if (!explicit && !noProject && !hinted && !origins.has(cwd)) origins.set(cwd, this.worktreeRoot(cwd));
      const origin = origins.has(cwd) ? await origins.get(cwd) : null;
      const project = noProject ? null : explicit ?? hinted ?? matchRoot(origin || cwd);
      return { ...task, project: { ...task.project, id: project?.id ?? NO_PROJECT, name: project?.name ?? "No project" } };
    }));
    return { tasks: grouped, projects: projects.map(({ id, name, roots }) => ({ id, name, path: roots[0] ?? "", githubRepos: [] })) };
  }
}
