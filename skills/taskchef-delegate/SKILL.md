---
name: taskchef-delegate
description: "Dispatch actionable requests from an initialized TaskChef workspace into independently openable Codex project tasks. Use for ordinary work requests in a TaskChef workspace, explicit delegation, or splitting independent work across projects. Record successful dispatches, return immediately, and never use subagents, hooks, schedules, or foreground waiting."
---

# TaskChef Delegate

Create real Codex tasks from a TaskChef data workspace and return immediately.

Resolve this skill directory with `realpath`. The TaskChef plugin root is two
parents above the skill directory. Use the TaskChef executable under that root
for all deterministic workspace and dispatch-record operations.

## Boundaries

- Keep implementation, tests, and reports in the TaskChef source repository.
- Keep only `AGENTS.md`, `taskchef.json`, and `dispatches.jsonl` in a dispatcher
  workspace.
- Use real Codex tasks, never collaboration or subagent tools.
- Never use hooks, callbacks, schedules, polling, or daemons.
- Never wait for delegated work after executor creation.
- Never collect transcripts or hidden reasoning.

## Dispatch

1. Run
   `<plugin-root>/bin/taskchef.js project list --json --workspace <workspace>`
   to load and validate the configured routing targets. Use
   `$taskchef-bootstrap` if the workspace is missing or unhealthy.
2. Split the request into the smallest independently useful outcomes. Include
   constraints, expected testing, and reporting in every instruction.
3. Classify against configured `name`, `githubRepo`, and `description`. Use
   `path` only as checkout identity. Ask when metadata does not produce one
   clear project match.
4. Resolve native projects once and require the exact configured path.
5. Create one real Codex task per assignment using the exact configured project
   and a local environment on its executor host. Generate a unique dispatch ID
   before creation, but do not write anything yet.
6. After executor creation returns a thread ID, immediately run
   `<plugin-root>/bin/taskchef.js dispatch record --json --workspace <workspace>`.
   Send exactly `id`, `project`, `title`, `instruction`, and `threadId` as JSON
   on stdin. Use the configured project path for `project`. Never persist
   `hostId`, status, results, transcripts, or hidden reasoning.
7. If executor creation fails, do not record a dispatch. If recording fails
   after creation, still return the created task and clearly say that it is not
   in the dispatch log. Do not delete the executor.
8. Return immediately with a created-thread directive for every success. Do
   not read or wait for a newly created executor.
