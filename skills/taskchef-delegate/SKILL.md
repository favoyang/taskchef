---
name: taskchef-delegate
description: "Dispatch actionable requests through the per-user TaskChef workspace into independently openable Codex project tasks. Use for ordinary work requests in the TaskChef project, explicit delegation from any project, or splitting independent work across projects. Preserve unresolved delegations for later marker-based recovery, and never use subagents, hooks, schedules, daemons, or executor-completion waiting."
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

1. In parallel, run `<plugin-root>/bin/taskchef.js dispatch prepare --json`,
   list the native Codex projects once, and, only when neither a dedicated
   provisional-ID resolver nor programmatic tool orchestration is available,
   take one pre-creation `list_threads` snapshot with limit 50. Do not add this
   snapshot when candidate reads can be issued in one programmatic batch. The
   prepare command resolves the
   canonical workspace, loads and validates the configured routing targets,
   generates the lowercase full UUID task ID, and returns `preparedAt` plus the
   exact first-line marker. Use
   `$taskchef-bootstrap` if the workspace is missing or unhealthy.
   The CLI resolves `--workspace`, then `TASKCHEF_WORKSPACE`, then
   `~/.agents/taskchef`; do not substitute the current project. Reject the
   dispatcher workspace itself as a target. From the pre-creation snapshot,
   retain only durable Codex thread IDs as a candidate-elimination baseline.
   Snapshot failure must not block creation; continue without a baseline.
2. Split the request into the smallest independently useful outcomes. Include
   constraints, expected testing, and reporting in every instruction.
3. Classify against configured `name`, every URL in the `githubRepos` list, and
   `description`. Use `path` only as checkout identity. Managed `*-workspace`
   projects advertise their child or sub-repositories in this list.
   When the prompt contains a GitHub issue or pull-request URL, canonicalize
   its case-insensitive owner/repository identity, ignoring `http` versus
   `https`, an optional `www`, a trailing slash or `.git`, and the issue or PR
   suffix. Check that identity against every repository URL of every configured
   project. Route on this evidence only when exactly one configured project
   matches. Ask instead of guessing when no project or several projects match.
4. Resolve the selected configured path against the already-loaded native
   projects and require an exact match. Do not list native projects again.
5. Use the task ID, preparation time, and marker returned by the preparation
   command.
   Prefix the complete executor instruction with
   exactly `<!-- taskchef_id=<full UUID> -->` as the first line, followed by a
   blank line and the instruction body. Preserve this
   marked instruction for recording, and note the creation time. The exact
   random marker remains the sole correlation proof; the pre-creation IDs only
   eliminate threads that already existed.
6. Create one real Codex task using the exact configured project, a local
   environment on its executor host, the marked instruction, and a short title.
7. When `create_thread` returns a durable `threadId`, immediately run
   `<plugin-root>/bin/taskchef.js task record --json` in one non-interactive
   invocation whose stdin contains exactly one JSON value and is closed at
   launch. Never open an interactive TTY and never create a temporary record
   file. When the canonical workspace is outside the command sandbox's writable
   roots, request permission for that exact write on the first attempt; never
   use a failed sandbox write as a permission probe. Send exactly `id`,
   `project`, `title`, `instruction`, and `threadId`. Use the configured project
   path for `project`, and send the marked instruction unchanged.
   Never persist a provisional `clientThreadId` or
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
   - When no native operation is available, take at most two post-creation
     `list_threads` snapshots with limit 50. Exclude every durable Codex ID from
     the successful pre-creation baseline before reading candidates. The
     nominal schedule is 10 and 30 seconds after
     the provisional result. Treat the first checkpoint as due, not expired: if
     nullable recording or other required work finishes after 10 seconds, take
     the first snapshot immediately. Start the second snapshot no sooner than
     20 seconds after the first snapshot actually started. Useful candidate
     work counts toward that interval; when it finishes sooner, wait only the
     remainder. Never suppress either snapshot merely because an earlier step
     ran late, and never take a third snapshot.
   - Filter Codex candidates by the expected host, project, creation time
     (allow five seconds of clock skew), and worktree environment whenever
     those fields are present. Use the title only to prioritize reads; Codex
     may normalize it, so never exclude a candidate because its title differs.
   - Read every remaining candidate with `read_thread`, requesting one turn and
     no command output. Read candidates concurrently when the tool surface
     permits; when programmatic tool orchestration is available, issue the
     independent reads together in one programmatic batch. Inspect only the
     structured
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

## End-to-end evaluation

When explicitly asked to benchmark delegation, measure one real task without
waiting for executor completion. Start from
`<plugin-root>/assets/e2e-benchmark-example.json`. Capture one ISO start/end
interval for the parallel preparation/project-list operation, followed by
sequential non-overlapping creation, recording, and optional provisional
resolution stages. Follow the complete schema and workflow transitions in
`<plugin-root>/SPEC.md`; the example is the durable-success starting shape.
Omit later stages when an earlier operation stops the workflow.
Fallback snapshot observations additionally require `recentTaskCount`,
`candidateCount`, `exactMatchCount`, and `resolveWriteMs`. For each snapshot,
also record `resolveWriteOutcome` as `not-attempted`, `succeeded`, or `failed`;
a unique match whose atomic write fails remains unresolved. After the bounded
workflow ends, verify the canonical task record once and, when resolved, read
the task once to verify the requested output. A failed verification remains a
false validation flag even when the corresponding operation succeeded. Feed
one exact JSON value to
`node <plugin-root>/scripts/e2e-benchmark.js write <output-directory>` on closed,
non-interactive stdin. Keep timestamped results in the TaskChef source
repository's ignored `reports/e2e-benchmarks/` directory. Never include hidden
reasoning or transcripts. Use the script's `clean` command before establishing
a replacement baseline. Mark candidate filtering effective only when the
fallback snapshot narrows reads below the complete recent-task window.
