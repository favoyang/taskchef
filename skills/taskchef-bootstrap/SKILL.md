---
name: taskchef-bootstrap
description: "Initialize, diagnose, or refresh TaskChef dispatcher workspaces, project configuration, task history, and managed AGENTS.md instructions. Use when creating a TaskChef workspace, adding, importing, listing, or removing configured projects, running TaskChef doctor, or repairing dispatcher setup. Do not dispatch user work or report on executor threads."
---

# TaskChef Bootstrap

Initialize or refresh a data-only TaskChef dispatcher workspace.

Resolve this skill directory with `realpath`. The TaskChef plugin root is two
parents above the skill directory. Invoke `<plugin-root>/bin/taskchef.js` for
all deterministic workspace operations.

## Boundaries

- Keep implementation, tests, and reports in the TaskChef source repository.
- Keep only `AGENTS.md`, `taskchef.json`, and `tasks.jsonl` in a dispatcher
  workspace.
- Do not dispatch tasks or report on executor threads during bootstrap unless
  the user separately requests those actions.
- Never use collaboration agents, hooks, schedules, polling, or daemons.

## Initialize and repair

1. Run `workspace init --json`. It takes no stdin, creates an empty
   configuration when missing, creates the append-only task log, refreshes
   managed instructions, and removes legacy TaskChef skill links. The installed
   plugin provides all three TaskChef skills outside the dispatcher workspace.
2. Run `doctor --json` after setup or when the user asks to diagnose the
   workspace. Doctor is read-only. Rerun `workspace init --json` to repair the
   managed scaffold.
3. Report the actions or failed checks. End without dispatching unless the user
   separately requested work.

## Configure projects

1. List native Codex projects once when discovery is necessary. Configure only
   projects local to the TaskChef workspace's execution host. Remote connection
   projects are outside the v1 contract.
2. Add one project with `project add <path>`, normally supplying `--name` and a
   curated `--description`. The CLI detects Git status, exact Git root, and a
   canonical GitHub `origin`. Repeat `--github-repo <url>` to advertise several
   repositories, or use `--no-github` for an empty list. A managed
   `*-workspace` project must list all of its child or sub-repositories so issue
   and pull-request URLs route to that workspace.
3. Bulk import with `project import <file|-> --json`. Input is a JSON array of
   objects containing `path` plus optional `name`, `description`, and
   `githubRepos`, which is always a JSON array of GitHub repository URLs. Import
   merges by canonical path, preserves an existing name or description when
   omitted, and unions existing and imported repository lists without
   duplicates. Use `--replace` only when the user explicitly requests
   replacement.
4. Inspect configured projects with `project list --json`. Remove by name with
   `project remove`. Existing task entries keep their project snapshots.

Example managed-workspace import entry:

```json
{
  "name": "skills-workspace",
  "path": "/workspace/skills-workspace",
  "githubRepos": [
    "https://github.com/example/skill-one",
    "https://github.com/example/skill-two"
  ],
  "description": "Manages the listed child skill repositories."
}
```

`workspace init` safely migrates schema-version-1 configuration: a string
`githubRepo` becomes a one-item `githubRepos` list and `null` becomes
`githubRepos: []`. All subsequent configuration writes use schema version 2.
