<!-- taskchef:dispatcher-instructions:start -->
# TaskChef Dispatcher Instructions

This repository is a TaskChef dispatcher workspace.

- Use `$taskchef-bootstrap` when initializing or refreshing this workspace,
  changing or listing its configured projects, running TaskChef doctor,
  or repairing its managed instructions.
- For every actionable work request, use `$taskchef-delegate`
  automatically, even when the user does not explicitly say "delegate" or
  mention TaskChef.
- Do not perform delegated work directly in the dispatcher thread.
- Return immediately after dispatch, as required by `$taskchef-delegate`.
- Answer directly only when the user explicitly asks about TaskChef itself or
  explicitly says not to delegate.
- Use `$taskchef-report` only when the user asks for a live report about work in
  the dispatch journey. Reports query the recorded Codex tasks once and do not
  write status or results to this workspace.
<!-- taskchef:dispatcher-instructions:end -->
