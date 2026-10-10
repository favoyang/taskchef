# Chat details proposal

Status: proposed, awaiting review. No detail-layout code changed.

- Keep the title, project, queue label, and Open in Codex at the top. Put Copy Chat ID and archive guidance in the action menu. Show Mark Done only when allowed.
- Render the saved reply excerpt directly, without a section heading or footer explanation. Keep the existing bounded excerpt and Markdown support.
- Put Activity before Pull requests. Activity shows work duration, next scheduled run, and direct subagents across chat history. Hide missing rows.
- In wide views, place Activity and Pull requests beside the reply; in narrow views, place them above it.
- Order PRs by the most recent occurrence in the chat, newest first. The current sidebar fetches latest-turn PRs only. Listing older chat PRs needs a separate bounded history lookup when Details opens; this does not change card classification or board fetching.
- Show a repository access alert once, below its first PR in the ordered list. Older PRs for that repository do not repeat it. Different repositories each get their own alert when needed.
- Keep Technical details collapsed. Only show Chat ID (copy), Turn ID (copy), Source (Desktop/CLI/Exec), and Last input (Human/Scheduled/Unknown). Hide absent fields. These help identify a chat and explain which input rules apply.
- Show the project folder as a tooltip on the project name. Remove duplicate IDs, generic queue explanation, updated-by text, redundant archive/schedule flags, sampled log byte counts, and observed message counts from normal details.

## Comparison with the current web detail view

The current shared `TaskDetail` component contains these sections:

| Current section | Proposed sidebar treatment |
| --- | --- |
| Title, project, status, Open Chat, actions | Keep; simplify actions and project display |
| PR badges and related GitHub links | Move PRs into ordered list; retain useful issue/repository links there when present |
| Tokens, estimated cost, duration, models | Keep duration in Activity. Other metrics need a reliable sidebar data source before adding them |
| Activity timeline | Keep the proposal focused on the saved reply. Full timeline is separate future work |
| Original instruction | Omit until the sidebar can fetch the actual initial prompt reliably |
| Latest saved reply heading and excerpt | Keep the excerpt, remove the heading |
| Metadata block | Replace with the four collapsed fields above |
| Errors, confirmations, notices | Keep in their existing action flow; notifications stay in the notification center |

The web view uses recorded TaskChef usage and turn history. Those records are not supplied by the passive Codex scanner. Empty usage/timeline sections should not be added to the sidebar.

[Editable wireframe](diagrams/taskchef-detail-wireframe.drawio) · [PNG](diagrams/taskchef-detail-wireframe.drawio.png)
