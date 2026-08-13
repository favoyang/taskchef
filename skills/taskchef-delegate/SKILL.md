---
name: taskchef-delegate
description: "Dispatch actionable requests through the per-user TaskChef workspace into independently openable Codex project tasks. Use for ordinary work requests in the TaskChef project or explicit delegation from any project. Forward one request as one task by default; split only when the user asks for standalone tasks or requirements clearly belong to different projects. Preserve unresolved delegations for later marker-based recovery, and never use subagents, hooks, schedules, daemons, or executor-completion waiting."
---

# TaskChef Delegate

Create real Codex tasks through the canonical per-user TaskChef data workspace
and return immediately.

Resolve this skill directory with `realpath`. The TaskChef plugin root is two
parents above the skill directory. Use the TaskChef executable under that root
for all deterministic workspace and task-record operations.

## Boundaries

- Keep implementation, tests, and reports in the TaskChef source repository.
- Keep only `AGENTS.md`, `taskchef.json`, and `tasks.jsonl` in a dispatcher
  workspace.
- Use real Codex tasks, never collaboration or subagent tools.
- Never use hooks, callbacks, schedules, daemons, indefinite polling, or
  background monitors.
- Use only bounded provisional-ID resolution after `create_thread` returns a
  provisional client ID. Prefer a native Codex wait or resolver when available.
- Never wait for delegated work after executor creation.
- Never collect transcripts or hidden reasoning.

## Dispatch

1. Run `<plugin-root>/bin/taskchef.js workspace path --json`, then run
   `<plugin-root>/bin/taskchef.js project list --json`
   to load and validate the configured routing targets. Use
   `$taskchef-bootstrap` if the workspace is missing or unhealthy.
   The CLI resolves `--workspace`, then `TASKCHEF_WORKSPACE`, then
   `~/.agents/taskchef`; do not substitute the current project. Reject the
   dispatcher workspace itself as a target.
2. Preserve the user's request as one executor instruction by default. Do not
   decompose several requirements merely because they can be completed
   independently. Do not split work that belongs to one project unless the
   user explicitly asks for standalone tasks. Create multiple tasks only when
   either:

   - the user explicitly asks for standalone tasks; or
   - the request contains distinct requirements that clearly belong to
     different configured projects.

   When splitting for either reason, keep each requirement intact with its
   constraints, expected testing, and reporting. Do not create task groups or
   persist the broad request.
3. Classify against configured `name`, every URL in the `githubRepos` list, and
   `description`. Use `path` only as checkout identity. Managed `*-workspace`
   projects advertise their child or sub-repositories in this list.
   When the prompt contains a GitHub issue or pull-request URL, canonicalize
   its case-insensitive owner/repository identity, ignoring `http` versus
   `https`, an optional `www`, a trailing slash or `.git`, and the issue or PR
   suffix. Check that identity against every repository URL of every configured
   project. Route on this evidence only when exactly one configured project
   matches. When one target is clear, dispatch without a routing preview. When
   no project matches confidently or several projects remain plausible, do not
   create a task. Ask the user to choose, concisely showing the candidate
   projects and the routing evidence that made the choice ambiguous.
4. Resolve native projects once and require the exact configured path.
5. Generate a lowercase full UUID task ID before creation. Prefix the complete
   executor instruction with exactly `<!-- taskchef_id=<full UUID> -->` as the
   first line, followed by a blank line and the instruction body. Preserve this
   marked instruction for recording, and note the creation time.
   Do not take a pre-creation thread snapshot; the exact random marker is the
   correlation key.
6. Create one real Codex task using the exact configured project, a local
   environment on its executor host, the marked instruction, and a short title.
7. When `create_thread` returns a durable `threadId`, immediately run
   `<plugin-root>/bin/taskchef.js task record --json`.
   Send exactly `id`, `project`, `title`, `instruction`, and `threadId` as JSON
   on stdin. Use the configured project path for `project`, and send the marked
   instruction unchanged. Never persist a provisional `clientThreadId` or
   `pendingWorktreeId` as `threadId`. Never persist `hostId`, status, results,
   transcripts, or hidden reasoning.
8. When creation returns only `clientThreadId` or `pendingWorktreeId`, keep it
   only for the created-thread directive and diagnostic reporting. It is not a
   durable ID and cannot be passed to thread tools or converted directly.
   Immediately record the marked instruction with `threadId: null` using the
   command from step 7, then resolve the durable ID with this bounded workflow:

   - If the current Codex tool surface provides a dedicated operation that
     accepts the provisional ID and waits for or resolves its durable thread
     ID, call it exactly once with a timeout of at most 30 seconds. Do not invent
     an operation or pass the provisional ID to tools that require `threadId`.
   - When no native operation is available, take at most two `list_threads`
     snapshots with limit 50, near 10 and 30 seconds after the provisional
     result. Count tool latency against the 30-second deadline. Do not start a
     snapshot, candidate read, marker verification, or task-resolution write
     after it.
   - Filter Codex candidates by the expected host, project, creation time
     (allow five seconds of clock skew), and worktree environment whenever
     those fields are present. Use the title only to prioritize reads; Codex
     may normalize it, so never exclude a candidate because its title differs.
   - Read every remaining candidate with `read_thread`, requesting one turn and
     no command output. Read candidates concurrently when the tool surface
     permits. Inspect only the structured
     `userMessage.content[].codexDelegation.input`; do not trust titles,
     summaries, previews, plain-text echoes, or assistant output as proof.
   - Accept a candidate only when the structured input's first line is exactly
     the task's `<!-- taskchef_id=<full UUID> -->` marker and exactly one
     candidate matches. Require an immediately following blank line. Reject old
     heading-style markers, malformed comments, missing blank separators, and
     marker-like text anywhere else. Apply the same marker verification to a
     thread ID returned by a native resolver. Reject any returned or discovered
     thread ID equal to the provisional identifier or in its `local:` namespace.
     Then use
     the task-resolution command under **Later resolution** to atomically fill
     the nullable field.
   - Treat native-resolution, snapshot, candidate-read, wait, and task-resolution
     failures as indeterminate. If the workflow ends with zero exact matches,
     multiple matches, or errors, leave the already-recorded `threadId: null`,
     clearly report the unresolved reason and provisional diagnostic ID, and
     never guess.

9. If executor creation fails, do not record a task. If recording fails
   after creation, still return the created task and clearly say that it is not
   in the task log. Do not delete the executor.
10. Return immediately after immediate recording or the bounded ID-resolution
    workflow. Emit the appropriate created-thread directive, but label a
    client-thread directive as provisional when resolution failed. Treat a
    nullable record as preserved but unresolved, not as a durable task link. Do
    not read an executor for progress and never wait for executor work
    completion.

The package exports pure repository canonicalization and unique URL matching
helpers from `src/github.js`, plus marker, candidate-filtering, and
injected-adapter orchestration helpers from `src/delegation.js`, for
deterministic tests and hosts that can supply thread-tool callbacks. The
standalone Node CLI cannot call desktop thread tools; perform the tool calls in
Codex and use the CLI only for validated workspace data operations.

## Later resolution

When a later Codex workflow finds exactly one durable thread whose structured
delegated input contains an unresolved task's exact marker, run
`<plugin-root>/bin/taskchef.js task resolve <task-id> --thread-id <thread-id> --json`.
Never edit `tasks.jsonl` directly. The CLI permits only an idempotent one-way
transition from `threadId: null` to one unique durable thread ID.
