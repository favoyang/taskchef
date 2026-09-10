# Model roles

TaskChef reads optional personal role preferences from native Codex agent TOML
in `$CODEX_HOME/agents/` (default `~/.codex/agents/`). Only model and reasoning
effort are adapted; TaskChef does not load the files' instructions, tools, or
permissions.

For a new visible task, select `orchestrator` from the `modelRoles` returned by
`prepare_dispatch`. Pass its `taskOverrides` as the native task's `model` and
`thinking` only after checking that the current creation interface supports
them. Missing configuration means omit both overrides. Invalid or unavailable
configuration must be reported rather than silently ignored.

Explicit user choices take precedence. An explicit model without an explicit
effort omits effort; do not combine it with a configured effort from another
model. To resolve an explicit choice, run the packaged resolver before creating
the task:

```sh
python3 <plugin-root>/scripts/roles/resolve_roles.py --role orchestrator --model <model> [--effort <effort>]
```

Resolve `<plugin-root>` from this skill's installed path. Omit flags the user
did not specify. The local model catalog is advisory; the current native tool
is authoritative about supported model and effort values.

The visible executor resolves Planner, Implementer, and Reviewer preferences
itself when it starts those subagents. The dispatcher does not create or wait
for those children.
