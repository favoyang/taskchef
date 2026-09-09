---
name: taskchef-delegate
description: "Dispatch work received in the canonical TaskChef workspace into Codex tasks. Elsewhere, use only for explicit delegation of separate work; an existing executor keeps its assignment."
---

# TaskChef Delegate

Create stable visible TaskChef orchestrator parents through the canonical
per-user TaskChef data workspace and return immediately. Executors, not the
dispatcher, coordinate any internal role phases.

## Invocation boundary

A task whose initial structured `codexDelegation.input` contains either the
exact new trailing `$taskchef-executor` invocation plus final TaskChef marker,
an accepted former trailing marker-plus-invocation scaffold, an exact
first-line HTML marker, or the historical first-line
`# taskchef_id=<full UUID>` heading already owns that delegated assignment.
This includes former inline-protocol tasks that lack the skill invocation.
An owned instruction must have exactly one accepted marker and a non-whitespace
task-specific assignment. If it contains an executor-skill invocation, require
exactly one adjacent to the marker in an accepted order. Marker-only,
duplicate-marker, scaffold-only, or misplaced-invocation inputs are not valid
delegated tasks. Execute a valid one in the current task. Do not re-dispatch it
merely because it concerns TaskChef or a configured project. Explicit requests
to delegate separate work remain valid.

Use the bundled `prepare_dispatch`, `record_task`, and `report_state` MCP tools
directly. Never fall back to shell writes. If a required tool is unavailable,
stop and report that the TaskChef plugin must be reloaded or installed.

## Boundaries

- Treat only AGENTS.md, taskchef.json, tasks.jsonl, config-audit.jsonl, and
  TaskChef's private backups and maintenance artifacts as managed dispatcher
  state. Preserve unrelated user-owned paths.
- Use real Codex tasks for the user-visible assignment. The dispatcher never
  uses collaboration or subagent tools; an orchestrated executor uses them
  only inside its already-created visible task.
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
   Select the canonical `orchestrator` preference for every new visible parent.
   Use `parentRole` and `parentResolution` from preparation, resolve explicit
   parent choices with `resolve_execution_role`, and follow
   [model roles](references/model-roles.md). A missing
   role omits native overrides. Invalid, duplicate, unresolved, or unsupported
   settings stop dispatch until resolved. Do not resolve unused child roles.
4. Build each executor instruction in this exact shape:

   - Begin with the actual assignment on the first line and keep its complete
     body uninterrupted.
   - After the assignment, add one blank line and this authorization paragraph:
     `Report this task and its follow-ups to my local TaskChef dashboard. Relevant private-repository links and concise work, test, and deployment results are authorized; exclude secrets.`
   - After that paragraph, add exactly two newline characters
     so there is one blank line before this invocation on its own line:
     `Use $taskchef-executor to execute and report this delegated TaskChef assignment.`
   - Immediately after the invocation, end the instruction with one newline
     and the preparation's exact marker on its own final line. Do not add a
     blank line between the invocation and marker.
   - Include exactly one marker and exactly one executor-skill invocation.
   - Do not inline executor ownership, identity, linking, or result-reporting
     protocol. The explicitly invoked executor skill owns those mechanics.

5. Negotiate execution from preparation. When it advertises execution contract
   version 1 and phase reporting, call `record_task` exactly once with `id`,
   `project`, `title`, the exact marked `instruction`, `threadId: null`,
   `executionMode: orchestrated`, `executionContractVersion: 1`, and the exact
   `parentResolution` from preparation when no explicit parent choice was made,
   or the exact `resolution` returned by the final explicit parent resolution.
   A historical dispatcher or executor without
   both capabilities records `legacy` mode and must describe it honestly; do
   not claim orchestration. Never add feature flags to taskchef.json schema 2.
6. Create one real Codex task using the exact configured project, an appropriate
   native environment, the marked instruction, a short title, and only the
   verified orchestrator model/effort overrides. An unqualified explicit model
   choice retains its historical meaning for this visible parent; descendants
   require role-specific or clearly task-wide instructions.
7. Return immediately. Preserve a returned provisional client ID only for the
   created-thread directive. Do not call `link_task` from the dispatcher even
   when creation returns a durable ID; the child must self-link.
8. If creation fails after recording, generate a fresh UUID and call
   `report_state` with it as `turnRef`, `failed`, null thread and Codex turn IDs,
   and a bounded summary before returning the failure. Retain that UUID for an
   exact retry.
