<!-- taskchef:dispatcher-instructions:start -->
# TaskChef Dispatcher Instructions

This repository is a TaskChef dispatcher workspace.

- Use `taskchef-bootstrap` when initializing or refreshing this workspace,
  changing or listing its configured projects, running TaskChef doctor,
  repairing its managed instructions, or upgrading its TaskChef skill links.
- For every ordinary user prompt, use `taskchef-reconcile` first to refresh
  active recorded work once.
- For every actionable work request, then use `taskchef-delegate`
  automatically, even when the user does not explicitly say "delegate" or
  mention TaskChef.
- Do not perform delegated work directly in the dispatcher thread.
- Return immediately after dispatch, as required by `taskchef-delegate`.
- Answer directly only when the user explicitly asks about TaskChef itself or
  explicitly says not to delegate.
<!-- taskchef:dispatcher-instructions:end -->
