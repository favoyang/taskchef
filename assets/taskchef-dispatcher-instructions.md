<!-- taskchef:dispatcher-instructions:start -->
# TaskChef Dispatcher Instructions

This folder is the canonical per-user TaskChef dispatcher workspace.

- Early in every dispatcher turn, best-effort call the TaskChef
  `ensure_dashboard` MCP tool. Dashboard startup failure must not block direct
  TaskChef answers, reporting, or delegation.
- A request to start, recover, or open the TaskChef dashboard is TaskChef
  maintenance, not delegated project work. Use `$taskchef-dashboard`.
- Use `$taskchef-bootstrap` when initializing or refreshing this workspace,
  changing or listing its configured projects, running TaskChef doctor,
  or repairing its managed instructions.
- When the user asks to answer, follow up, resume, or continue the same
  recorded assignment in its existing executor task, use `$taskchef-copilot`
  before the general delegation rule. A direct imperative that names the exact
  existing task is explicit send authorization, but copilot must immediately
  re-read that exact task and apply its state and identity guardrails.
- For every other actionable request that asks for an independent new outcome,
  use `$taskchef-delegate` automatically, even when the user does not explicitly
  say "delegate" or mention TaskChef.
- GitHub issue and pull-request URLs may identify any repository advertised by
  a configured project, including child repositories of managed workspaces.
- Do not perform delegated work directly in the dispatcher thread.
- Return immediately after dispatch, as required by `$taskchef-delegate`.
- Answer directly only when the user explicitly asks about TaskChef itself or
  explicitly says not to delegate.
- Use `$taskchef-copilot` when the user asks what delegated work finished,
  what needs attention, why it failed or needs input, or what should happen
  next, including same-assignment continuation in an exact existing executor.
  Copilot uses the cached TaskChef brief by default; the dashboard is the
  primary monitoring and browsing UI. Live verification is explicit or
  contradiction-driven, focused, and never polled.
- Explicit invocations of TaskChef skills from other Codex projects use this
  same workspace and task history through TaskChef's global resolution rules.
- Every final response in this dispatcher workspace must end with this exact
  clickable link on its final non-empty line:
  `[TaskChef Dashboard](http://127.0.0.1:3210/)`. Keep any
  `::created-thread{...}` directive required by delegation on its own line
  immediately before the dashboard link so the immediate-return contract still
  holds. Include the link even when `ensure_dashboard` failed.
<!-- taskchef:dispatcher-instructions:end -->
