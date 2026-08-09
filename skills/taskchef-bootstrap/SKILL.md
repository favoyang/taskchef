---
name: taskchef-bootstrap
description: "Initialize, diagnose, or refresh TaskChef dispatcher workspaces, project configuration, and managed AGENTS.md instructions. Use when creating a TaskChef workspace, adding, importing, listing, or removing configured projects, running TaskChef doctor, or repairing dispatcher setup. Do not dispatch user work or reconcile executor threads."
---

# TaskChef Bootstrap

Initialize or refresh a data-only TaskChef dispatcher workspace.

Resolve this skill directory with `realpath`. The TaskChef plugin root is two
parents above the skill directory. Invoke `<source-root>/bin/taskchef.js` for
all deterministic workspace operations.

## Boundaries

- Keep implementation, tests, and reports in the TaskChef source repository.
- Keep only `AGENTS.md`, `taskchef.json`, and `tasks/*/task.json` in a
  dispatcher workspace.
- Do not dispatch tasks or reconcile executor threads during bootstrap unless
  the user separately requests those actions.
- Never use collaboration agents, hooks, schedules, polling, or daemons.

## Initialize and repair

1. Run `workspace init --json`. It takes no stdin, creates an empty
   configuration when missing, and idempotently creates or refreshes the task
   directory and managed instructions. The installed plugin provides all three
   TaskChef skills outside the dispatcher workspace.
2. Run `doctor --json` after setup or when the user asks to diagnose the
   workspace. Doctor is read-only; rerun `workspace init --json` to repair the
   managed scaffold.
3. Report the actions or failed checks. End without dispatching unless the user
   separately requested work.

## Configure projects

1. List native Codex projects once when discovery is necessary. Configure only
   projects local to the TaskChef workspace's execution host. Remote connection
   projects are outside the v1 contract.
2. Add one project with `project add <path>`, normally supplying `--name` and a
   curated `--description`. The CLI detects Git status, exact Git root, and a
   canonical GitHub `origin`; use `--no-github` or `--github-repo` only to
   override detection.
3. Bulk import with `project import <file|-> --json`. Input is a JSON array of
   objects containing `path` plus optional `name`, `description`, and
   `githubRepo`. Import merges by canonical path and preserves an existing name
   or description when omitted. Use `--replace` only when the user explicitly
   requests replacement.
4. Inspect configured projects with `project list --json`. Remove by name with
   `project remove`; require explicit user intent before `--force` when task
   records reference the project.
