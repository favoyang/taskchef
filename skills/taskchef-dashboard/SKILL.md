---
name: taskchef-dashboard
description: "Ensure and recover the canonical TaskChef dashboard. Use when the user asks to start, restore, open, or get the link for the TaskChef dashboard. Do not use to dispatch work or inspect task outcomes."
---

# TaskChef Dashboard

Maintain only the canonical TaskChef dashboard.

1. Call the TaskChef `ensure_dashboard` MCP tool with its empty input. Do not
   supply a workspace, host, or port.
2. Report whether the returned `action` is `started` or `reused` and provide
   the returned canonical URL as a clickable link.
3. If the user asked to open the dashboard and an in-app browser navigation
   capability is available and permits the returned localhost URL, open or
   navigate to it. Browser absence, refusal, or blocked localhost navigation is
   non-fatal: still return the clickable URL and the ensure result.

Do not dispatch project work, read task briefs, inspect executor outcomes, poll,
start a separate foreground CLI server, or modify TaskChef workspace files.
