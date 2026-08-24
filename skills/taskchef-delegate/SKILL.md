---
name: taskchef-delegate
description: "Dispatch actionable requests through the per-user TaskChef workspace into independently openable Codex project tasks. Use automatically for actionable work received in the canonical TaskChef dispatcher workspace. From any other project, use only when the user explicitly asks to delegate or split separate work into Codex tasks; TaskChef-related subject matter alone is not delegation intent. Record before creation, require executor self-linking, and never wait for executor completion."
---

# TaskChef Delegate

Create real Codex tasks through the canonical per-user TaskChef data workspace
and return immediately.

## Invocation boundary

A task whose initial structured `codexDelegation.input` starts with an exact
`<!-- taskchef_id=<full UUID> -->` marker already owns that delegated
assignment. Execute it in the current task. Do not re-dispatch it merely
because it concerns TaskChef or a configured project. Explicit requests to
delegate separate work remain valid.

Use the bundled `prepare_dispatch`, `record_task`, and `report_state` MCP tools
directly. Never fall back to shell writes. If a required tool is unavailable,
stop and report that the TaskChef plugin must be reloaded or installed.

## Boundaries

- Treat only `AGENTS.md`, `taskchef.json`, and `tasks.jsonl` as TaskChef-managed
  dispatcher files. Preserve unrelated user-owned paths.
- Use real Codex tasks, never collaboration or subagent tools.
- Never use hooks, schedules, daemons, background monitors, recent-task
  searches, transcripts, hidden reasoning, or polling for identity.
- Never wait for delegated work after native creation.
- Treat executor-supplied identity as a cooperative assertion in TaskChef's
  local single-user trust boundary, not transport-authenticated proof.

## Dispatch

1. Split the request into the smallest independently useful outcomes. Include
   constraints, expected testing, and reporting in every instruction.
2. In parallel, list native Codex projects once and call `prepare_dispatch`
   exactly once per outcome. Never reuse a task ID or marker. Do not take a
   pre-creation thread snapshot.
3. Route against configured project `name`, `description`, and canonical
   `githubRepos`; use `path` only as checkout identity. Require exactly one
   match and an exact native-project path. Ask instead of guessing.
4. Build each executor instruction in this exact shape:

   - Keep the preparation's exact marker as the first line.
   - Begin the actual assignment on the second line, with no blank line after
     the marker.
   - End the instruction after one blank line with exactly:
     `Use $taskchef-executor to execute and report this delegated TaskChef assignment.`
   - Do not inline executor ownership, identity, linking, or result-reporting
     protocol. The explicitly invoked executor skill owns those mechanics.

5. Before creating each executor, call `record_task` exactly once with `id`,
   `project`, `title`, the exact marked `instruction`, and `threadId: null`.
6. Create one real Codex task using the exact configured project, an appropriate
   native environment, the marked instruction, and a short title.
7. Return immediately. Preserve a returned provisional client ID only for the
   created-thread directive. Do not call `link_task` from the dispatcher even
   when creation returns a durable ID; the child must self-link.
8. If creation fails after recording, call `report_state` with `failed`, null
   thread/turn IDs, and a bounded summary before returning the failure.
