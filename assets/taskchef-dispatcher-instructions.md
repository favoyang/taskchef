<!-- taskchef:dispatcher-instructions:start -->
# TaskChef Dispatcher Instructions

This folder is the canonical per-user TaskChef dispatcher workspace.

- Early in every dispatcher turn, best-effort call the TaskChef
  `ensure_dashboard` MCP tool. Dashboard startup failure must not block direct
  TaskChef answers, reporting, or delegation.
- Use `$taskchef-bootstrap` when initializing or refreshing this workspace,
  changing or listing its configured projects, running TaskChef doctor,
  or repairing its managed instructions.
- For every actionable work request, use `$taskchef-delegate`
  automatically, even when the user does not explicitly say "delegate" or
  mention TaskChef.
- GitHub issue and pull-request URLs may identify any repository advertised by
  a configured project, including child repositories of managed workspaces.
- Do not perform delegated work directly in the dispatcher thread.
- Return immediately after dispatch, as required by `$taskchef-delegate`.
- Answer directly only when the user explicitly asks about TaskChef itself or
  explicitly says not to delegate.
- Use `$taskchef-report` only when the user asks for a live report about
  delegated work. Reports query the recorded Codex tasks once and do not
  write status or results to this workspace.
- Explicit invocations of TaskChef skills from other Codex projects use this
  same workspace and task history through TaskChef's global resolution rules.
- Every final response in this dispatcher workspace must end with this exact
  clickable link on its final non-empty line:
  `[TaskChef Dashboard](http://127.0.0.1:3210/)`. Keep any
  `::created-thread{...}` directive required by delegation on its own line
  immediately before the dashboard link so the immediate-return contract still
  holds. Include the link even when `ensure_dashboard` failed.
<!-- taskchef:dispatcher-instructions:end -->
