---
name: taskchef-delegate
description: "Dispatch actionable requests through the per-user TaskChef workspace into independently openable Codex project tasks. Use automatically for actionable work received in the canonical TaskChef dispatcher workspace. From any other project, use only when the user explicitly asks to delegate or split separate work into Codex tasks; TaskChef-related subject matter alone is not delegation intent. Record before creation, rely on the initial TaskChef hook for provisional identity, and never wait for executor completion."
---

# TaskChef Delegate

Create real Codex tasks through the canonical per-user TaskChef data workspace
and return immediately.

## Invocation boundary

A task whose initial structured `codexDelegation.input` starts with an exact
`<!-- taskchef_id=<full UUID> -->` marker already owns that delegated
assignment. Execute the assignment in the current task. Do not re-dispatch it
merely because it concerns TaskChef or a configured project.

This does not prevent the task from using TaskChef later. Use this skill
normally when the initial assignment explicitly asks to delegate separate
work, or when the user later explicitly requests a new delegation.

Use the bundled TaskChef `prepare_dispatch`, `record_task`, `resolve_task`, and `report_result`
tools for deterministic workspace and task-record operations. Call them
directly; never probe for them or fall back to shell CLI writes. If a required
tool is unavailable, stop and report that the TaskChef plugin must be reloaded
or reinstalled. Resolve the plugin root from this skill only when writing an
explicitly requested benchmark artifact.

## Boundaries

- Keep implementation, tests, and reports in the TaskChef source repository.
- Keep only `AGENTS.md`, `taskchef.json`, and `tasks.jsonl` in a dispatcher
  workspace.
- Use real Codex tasks, never collaboration or subagent tools.
- Use only TaskChef's `UserPromptSubmit` hook: it resolves initial identity and
  provides read-only current-turn context on follow-up prompts. Never infer
  lifecycle state from hooks.
- Never use schedules, daemons, polling, thread-discovery retries, or background
  monitors.
- Never wait for delegated work after executor creation.
- Never collect transcripts or hidden reasoning.

## Dispatch

1. Split the request into the smallest independently useful outcomes. Include
   constraints, expected testing, and reporting in every instruction.
2. In parallel, list the native Codex projects once and call `prepare_dispatch`
   exactly once for each outcome. Every preparation produces a distinct task
   UUID and marker; never reuse either across executors. The preparation tool
   resolves the canonical workspace, loads and validates the configured routing targets,
   generates the lowercase full UUID task ID, and returns `preparedAt` plus the
   exact first-line marker. Use
   `$taskchef-bootstrap` if the workspace is missing or unhealthy.
   The tool resolves an absolute (or `~/`-prefixed) `TASKCHEF_WORKSPACE`, then
   `~/.agents/taskchef`; do not substitute the current project. Reject the
   dispatcher workspace itself as a target. Never take a pre-creation thread
   snapshot.
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
5. For each outcome, use only its corresponding task ID, preparation time, and
   marker returned by its own preparation call.
   Prefix the complete executor instruction with
   exactly `<!-- taskchef_id=<full UUID> -->` as the first line, followed by a
   blank line, this executor-role paragraph, another blank line, the result
   paragraph below, another blank line, and the instruction body:

   > This task owns the delegated assignment. Execute it in this task; do not re-dispatch it merely because it concerns TaskChef or a configured project. Explicit requests to delegate separate work remain valid.

   > Before ending, call the TaskChef report_result MCP tool with completed, needs_input, or failed and a concise summary. Use needs_input only for a semantic decision or information the user must provide; a native approval prompt is live Codex state, not a TaskChef result. Do not include secrets, transcripts, or raw command output.

   Preserve this
   marked instruction for recording, and note the creation time. The exact
   random marker is the sole correlation proof.
6. Before creating each executor, call `record_task` exactly once with `id`,
   `project`, `title`, the marked `instruction`, and `threadId: null`. This
   closes the hook race: the entry exists before the executor can submit its
   initial prompt.
7. Create one real Codex task using the exact configured project, a local
   environment on its executor host, the marked instruction, and a short title.
8. If creation returns a durable `threadId`, call `resolve_task` immediately.
   If creation returns only `clientThreadId`, `pendingWorktreeId`, or a `local:`
   ID, retain it only for the created-thread directive. Return immediately; the
   initial TaskChef hook will atomically fill the durable root thread ID. Never
   list, read, wait for, or poll threads to resolve it.

9. If executor creation fails, call `report_result` for the already-recorded
   task with `failed`, null thread/turn IDs, and a concise creation error.
10. Emit the appropriate created-thread directive and return immediately.
    Treat a nullable record as preserved but not yet linked. Do not read an
    executor for progress and never wait for executor work completion.

The bundled structured tools are the only dispatch-time path to the canonical
workspace. They reuse the same exact-field validation, locking, atomic writes,
and one-way nullable resolution as the CLI without shell parsing, stdin, or
per-command filesystem escalation. The package exports repository routing,
marker, and record-before-create orchestration helpers for deterministic tests.
Keep the CLI for bootstrap, manual inspection, and recovery outside delegation.

## Later resolution

The trusted initial hook normally resolves an unresolved task. For manual
recovery, require one exact structured marker match, then call `resolve_task`
once. Never edit `tasks.jsonl` directly. Resolution is an idempotent one-way
transition from `threadId: null` to one unique durable root thread ID.

## Legacy benchmark compatibility

The schema-v1 benchmark fixtures below describe the removed snapshot resolver
and remain only for historical-result validation. Do not use that resolver for
new delegation benchmarks. A future benchmark schema should measure record,
creation, initial-hook resolution, and result callback without polling. The
legacy fixture starts from
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
