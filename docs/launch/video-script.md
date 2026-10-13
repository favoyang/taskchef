# TaskChef launch video — final script

**Length:** 36⅓ seconds. **Format:** 1920 × 1080, 30 fps.
**Positioning:** Dashboard for Codex. Keep every project in view.

The film uses the actual TaskChef React components, controls, mark and Codex
palette. All chats, projects, usage and PRs are synthetic. Music is included;
there is no narration or screen recording.

| Time | Title | Picture and action |
| --- | --- | --- |
| 0–1.33s | TaskChef · Dashboard for Codex | Logo, name, descriptor and native cards visible from frame zero. Cards move gently beside the identity. |
| 1.33–3.83s | Keep every project in view. | Large title overlays the full board, then fades to reveal it. Scheduled, Running, Waiting for review and Done remain visible with nine chats and three synthetic image covers. No Running close-up in this chapter. |
| 3.83–8.83s | See what’s running. | Move into Running. Follow Build project search as latest-turn tokens rise from 600K to 1.24M and estimated API-equivalent cost rises from $0.40 to $0.86. |
| 8.83–13.83s | Ready for your review. | The chat finishes. Follow the same card into Waiting for review while neighboring cards make room. Its prompt becomes its result. |
| 13.83–18.83s | Usage, turn by turn. | Open the native Details popup. Highlight Latest turn (1.24M · $0.86), then Total chat (5.32M · $3.72). Keep the native API estimate note visible. |
| 18.83–23.83s | Merged. Done. | Latest-turn PR #42 changes from open to merged. Its native link, result text and glyph update as the card moves into Done. |
| 23.83–28.83s | Focus on one project. | Highlight the real project picker. Change All projects to Atlas. Other projects fade out and matching cards reposition. Scheduled remains visible. |
| 28.83–33.33s | Make it your own. | Show the native appearance controls. Switch ChatGPT Day → Catppuccin Night → Codex Night, then return to the full board. |
| 33.33–36.33s | TaskChef · Dashboard for Codex | Logo, identity and taskchef.dev. Music fades to the ending. |

The opening holds for 1⅓ seconds. The overview moves straight into Running
after its title fades, without an idle hold.

Each chapter title uses one line with white and blue emphasis. It stays fully
readable for about two seconds over a dark
gradient, then fades. The board remains the visual background. The camera
moves directly from Running to review and from usage to Done. It returns to
the full board for overview and project filtering, without resetting to a
small board on the right.

## Preview

```sh
npm ci
npm ci --prefix video
npm run video:check
npm run video:preview
```

Open `http://localhost:8090/TaskChefLaunch` and press Play with sound enabled.
The full composition is 1,090 frames. Studio exposes each chapter title as a
named timeline item. The Drafts folder retains earlier scene studies; those
are not the current full cut.

Key review points at 30 fps:

- Frame 0: complete product identity, without fade-in.
- Frame 114: full board with nine chats and Scheduled.
- Frames 205 and 253: changing native card token/cost values.
- Frames 355–376: Running → Waiting for review.
- Frames 520 and 544: latest-turn and total-chat usage highlights.
- Frames 649–670: PR merged → Done.
- Frames 782–811: project selection, fading and repositioning.
- Frames 945 and 970: light and dark theme switches.
- Frame 1040: ending.

The shared camera and board preserve spatial continuity. `ProductBoard` reuses
`TaskBoard`, `ProjectPicker`, Mantine controls, native theme and production CSS;
`NextTaskDetail` supplies the actual usage table. The video uses the native
cover loader and appearance icon, controls, Aa previews and theme variables.
Its frame-controlled theme panel shows three choices from the native list.
Cover illustrations are local SVG fixtures authored in code. Frame-driven overrides keep
motion, spinner rotation, clock labels and usage values repeatable. They apply
only to the video. The host bridge is not mounted and the film makes no MCP or
GitHub requests. No product behavior or installed plugin changes.

## Music and export

**Tech House vibes**, Alejandro Magaña (A. M.), from the
[official Mixkit catalog](https://mixkit.co/free-stock-music/electronica/).
The [Stock Music Free License](https://mixkit.co/license/modal/musicFree/)
allows commercial online videos and marketing ads. Raw audio downloads into
ignored `video/public/` with a fixed checksum; it is not committed or included
in the plugin package. `video/prepare-assets.mjs` reuses the local copy. First
preview startup needs network access. Do not claim authorship or register the
music with a rights-management service.

When an export is requested:

```sh
npm run video:render
```

Output: `video/out/taskchef-launch.mp4`, ignored by Git. The isolated locked
`video/` package and launch docs are excluded from the published plugin. Review
Remotion's [license terms](https://www.remotion.dev/docs/license) before
commercial distribution if the producer's eligibility changes.

## Publication and accuracy

- Publish the video only after the taskchef.dev homepage is live.
- The latest turn's confirmed merged PR drives the move to Done.
- Merged describes the PR; it does not claim deployment.
- API-equivalent cost is an estimate, not a subscription charge. Preserve the
  native estimate note in the detail view.
- Use no private chats, real account data, personal images or screen recordings.
- Add no explanatory UI helper text for ordinary interactions.

The [Strata reference](https://x.com/l0gicgate/status/2109739837435814207)
informed framing and pacing. No footage or assets are copied from it.
