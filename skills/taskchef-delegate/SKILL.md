---
name: taskchef-delegate
description: "Dispatch actionable requests from an initialized TaskChef workspace into independently openable Codex project tasks. Use for ordinary work requests in a TaskChef workspace, explicit delegation, splitting work across projects, or retrying pending executor creation. Dispatch must return immediately and must never use subagents, hooks, schedules, or foreground waiting."
---

# TaskChef Delegate

Create real Codex tasks from a TaskChef data workspace and return immediately.

Resolve this linked skill with `realpath`. The TaskChef source root is two
parents above the skill directory. Use the TaskChef executable under that root
for all deterministic workspace and task-record operations.

## Boundaries

- Keep implementation, tests, and reports in the TaskChef source repository.
- Keep only `AGENTS.md`, `taskchef.json`, `tasks/*/task.json`, and the three
  TaskChef skill links in a dispatcher workspace.
- Use real Codex tasks, never collaboration or subagent tools.
- Never use hooks, callbacks, schedules, polling, daemons, or event logs.
- Never wait for delegated work after executor creation.
- Never collect transcripts or hidden reasoning.

## Dispatch

1. Run
   `<source-root>/bin/taskchef.js project list --json --workspace <workspace>`
   to load and validate the configured routing targets. Use
   `$taskchef-bootstrap` if the workspace is missing or unhealthy.
2. Split the request into the smallest independently useful outcomes. Include
   constraints, expected testing, and reporting in every instruction.
3. Classify against configured `name`, `githubRepo`, and `description`. Use
   `path` only as checkout identity. Ask when metadata does not produce one
   clear project match.
4. Resolve native projects once and require the exact configured path.
5. For an explicit retry, require the exact task ID and run
   `<source-root>/bin/taskchef.js task show <task-id> --json --workspace <workspace>`.
   Reuse the record only when its status is `pending`; ask for the task ID when
   it is missing and reject retries of non-pending records. For new work, run
   `<source-root>/bin/taskchef.js task create --json --workspace <workspace>`
   with the task record JSON on stdin before executor creation.
6. Create one real Codex task per record using the exact saved project and a
   local environment on its executor host.
7. Immediately run
   `<source-root>/bin/taskchef.js task update <task-id> --json --workspace <workspace>`
   with the `running` status and returned `threadId` on stdin. Never persist
   `hostId`.
8. Leave a failed creation pending. Do not invent an ID or delete the record.
9. Return immediately with a created-thread directive for every success. Do
   not read or wait for a newly created executor.
