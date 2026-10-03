# TaskChef sidebar app

Call `open_taskchef_board` in Codex to open the TaskChef MCP App in the sidebar. The app reads the same local workspace and task log as the web dashboard. It needs the TaskChef MCP server to be connected and an MCP Apps-capable Codex host.

The sidebar uses the dashboard's task cards, horizontal board lanes, and detail view. Switch between **List** and **Board**. In List, filter by project, update window, and status; status counts reflect the selected project and window, and the summary reports visible tasks. Board shows all status lanes for the selected project and window. Task cards include request and result summaries, relative update times, reported work and usage summaries, and related GitHub links. Select a task for its usage, activity timeline, instruction, and metadata.

**Open chat** opens a linked Codex thread, or the configured project when the task has no usable direct chat link. **Mark completed** and **Mark failed** require confirmation and use the same audited, conflict-checked manual transition as the web dashboard. The app refreshes every five seconds and offers manual refresh. A refresh does not replace a newer selection or a changed task with an older response.

The UI is a bundled `ui://taskchef/task-board/v2` MCP resource. Its read, open, and transition calls are app-only tools on the existing stdio MCP server. The iframe does not read files or contact the local HTTP dashboard. The web dashboard remains available separately.

For development, run `npm run build:mcp-app` after editing `src/mcp-app/react/`. The generated single-file resource is `src/mcp-app/dist/index.html`. Run `npm run check:mcp-app` and `npm test` before release. Reopen the sidebar after rebuilding to load the new resource.
