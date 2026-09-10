# Compatibility

Pre-authorization prompts with the invocation before the final marker use the
entrypoint lifecycle without requiring a new authorization paragraph.

Existing delegated tasks may include the former inline ownership, linking, and
`report_result` paragraphs. Continue executing those tasks here without
re-dispatching. Prefer `report_state` when available. If an older installed
TaskChef exposes only `report_result`, follow its inline protocol; after an
upgrade, the deprecated `report_result` alias remains available for exact
legacy retries. Also accept historical trailing instructions that place the
marker before the invocation, with or without the former blank line before the
marker; the former compact assignment-to-invocation boundary with the marker
last; an exact HTML marker on the first line with or without the former blank
line; or the older exact
first-line `# taskchef_id=<full UUID>` heading. These compatibility forms do not
change the identity or lifecycle rules in `SKILL.md`. For either first-line form, the
assignment follows the marker. Ignore the final executor invocation and any
recognizable former inline ownership, linking, working-state, or
result-reporting paragraphs as lifecycle scaffolding; execute the remaining
task-specific body. Require non-whitespace task-specific content and never
treat an invocation by itself as an assignment.
