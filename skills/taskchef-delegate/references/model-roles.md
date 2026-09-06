# Dispatch model roles

Preparation includes personal and per-project model previews. Use the exact
matched project's preview. Role preferences use native Codex agent TOML under
`$CODEX_HOME/agents/` (default `~/.codex/agents/`) and that project's
`.codex/agents/`; they are optional. The resolver requires Python 3.11+.

Select `planner` for a planning assignment or `implementer` for coding. Pass
its `taskOverrides` as native `model` and `thinking` arguments only after checking
those values against the current create-task tool's supported model/effort
choices. A missing role means omit both arguments and use the native new-task
default. This is not guaranteed to inherit the dispatcher's model.

Explicit user model choices take precedence over the project role, personal
role, and native defaults. An explicit model without explicit effort omits effort and uses the native
interface's omission behavior; do not mix in a different role's effort or claim
a specific effective effort without evidence. Explicit effort
alone replaces the resolved role effort. Project roles replace personal roles
as a unit. To resolve explicit choices, or recheck a preview after configuration
changes, run:

```sh
python3 <plugin-root>/scripts/roles/resolve_roles.py --project <project-path> --role implementer --model <user-model> --effort <user-effort>
```

Omit flags the user did not specify. Resolve the plugin root from this skill's
real path, two parents above the skill directory. Do not substitute dispatcher
paths for the target project or infer model names from skill prose.

Report malformed profiles, duplicate names, unavailable models/efforts, and
resolver failures. Do not quietly fall back and claim preferences were honored.
The local model catalog is advisory: explain if a current native tool disproves
its stale warning. Otherwise resolve the problem or obtain a valid explicit
choice before task creation. Native creation failures retain normal TaskChef
failure reporting. A preparation without role fields supports historical
installations: check role files before deciding that no preferences exist.

Only model and effort are adapted. The native agent file's instructions, tools,
permissions, and other settings are not applied by create-task arguments. A
role name in a title is not a native role selector. If the native interface adds
a role selector, use it only with verified effective settings.

For a plan-to-implementation handoff, a planner assignment can save
`plans/addition.md` describing a pure addition function and the acceptance
example `2 + 3 = 5`. A later implementer assignment reads that exact plan,
implements the function, runs the example, and uses fresh reviewer subagents.
The dispatcher returns after each creation; it does not wait for or launch
subsequent phases automatically. A small addition change can instead go
straight to the implementer.
