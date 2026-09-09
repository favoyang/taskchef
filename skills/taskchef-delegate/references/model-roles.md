# Dispatch model roles

Preparation resolves only the personal `orchestrator` preference for a new
visible TaskChef parent. Role preferences come from native Codex agent TOML in
the global `$CODEX_HOME/agents/` directory (default `~/.codex/agents/`) and are
optional. The packaged resolver requires Python 3.11+.

Pass the orchestrator's `taskOverrides` as native `model` and `thinking`
arguments only after checking those values against the current create-task
tool's supported model/effort choices. A missing orchestrator means omitting
both arguments and using the native new-task default. An invalid profile,
duplicate name, unavailable model/effort, structurally ambiguous TOML, or
resolver failure must be visible and stops creation until resolved.

Explicit user model choices take precedence over the personal role and native
defaults. An unqualified explicit model retains its historical scope: the
visible parent only. An explicit model without explicit effort omits effort;
never combine it with a different model's role effort. Explicit effort alone
replaces the role effort. A clearly task-wide or role-specific instruction may
also govern descendants. Resolve explicit parent choices or recheck after a
configuration change with `resolve_execution_role` and its explicit fields.
Use the returned `resolution` as the immutable `parentResolution` passed to
`record_task`; do not reuse preparation's earlier snapshot after an override.
The packaged CLI equivalent for diagnostics is:

```sh
python3 <plugin-root>/scripts/roles/resolve_roles.py --role orchestrator --model <user-model> --effort <user-effort>
```

Omit flags the user did not specify. Resolve the plugin root from this skill's
real path, two parents above the skill directory. The local model catalog is
advisory; current native creation support is authoritative. Explain evidence
that disproves a stale warning before using the value. When the current
create-task interface itself lists the cache-flagged model and effort, re-run
`resolve_execution_role` with `nativeAvailabilityConfirmed: true`; never use
that flag for malformed, duplicate, or otherwise invalid role configuration.

Planner, implementer, and reviewer preferences are intentionally not resolved
during preparation. The stable parent re-resolves exactly the needed child
role immediately before every fresh phase spawn. A planning-only request, a
combined plan-and-implement request, direct implementation, and a later
“implement it” follow-up remain in one visible parent; their intent and phase
history distinguish the fulfilled work.

Only model and reasoning effort are adapted. Global TOML developer
instructions, tools, permissions, other settings, repository-local profiles,
and named-agent selectors are outside this narrow adapter. A role label in a
title is not evidence that native role settings were applied.
