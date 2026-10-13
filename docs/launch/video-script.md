# TaskChef launch video — final script

**Length:** 45 seconds. **Format:** 1920 × 1080, 30 fps.
**Positioning:** Keep parallel AI work in view.

The preview is a silent, text-led film. The narration below is ready to record
if a voice track is wanted. All product views use TaskChef's React components,
styles, and Codex dark palette. All chats, projects, usage, and PRs are synthetic.

| Time | Narration | Picture and on-screen text |
| --- | --- | --- |
| 00–06 | AI lets you work on several projects at once. Keeping track gets harder. | The actual board fades in with chats from Atlas, Beacon, and Studio. **More projects. More moving parts.** |
| 06–11 | TaskChef puts your Codex chats on one board. | Hold the three columns: Running, Waiting for review, Done. **See what is running.** The main chat is “Build project search” in Running. |
| 11–17 | When a run finishes, its card moves to Waiting for review. | Animate the same card across the board. Its prompt becomes its result. Neighboring cards make room. **Ready for your review.** |
| 17–27 | Check tokens and estimated API cost for the latest turn—and the whole chat. | Open the real Details popup. Hold the Usage table: Latest turn **1.24M · $0.86**; Total chat **5.32M · $3.72**. Keep the API estimate footnote visible. **Know the usage behind the work.** |
| 27–30 | Review it. Merge it. | Back to the board. The main card is in Waiting for review. Latest turn PR #42 is open, with passing checks. |
| 30–35 | Merge the pull request. Watch the card move to Done. | The PR glyph changes to merged. Animate the same card into Done. **Merged. Moved to Done.** |
| 35–41 | Filter by project when you need to focus. | Highlight the real project picker. Change All projects to Atlas. Other projects disappear; Atlas's Done cards remain. **One project. Your full attention.** |
| 41–45 | TaskChef. Keep parallel AI work in view. | Product mark, TaskChef, positioning line, **taskchef.dev**. |

The end card uses the intended new home, `taskchef.dev`. The website is still
being prepared. Publish this cut only after its homepage is live.

## Production rules

- Render the UI from code. Use no screen recordings or screenshot stand-ins.
- Keep the main chat's identity throughout both moves and the usage close-up.
- Only the latest turn's confirmed merged PR drives the move to Done.
- “Merged” describes the PR. Do not claim that merging deploys the change.
- API-equivalent cost is an estimate. It is not a subscription charge.
- Use no real chat text, private project names, account data, or personal images.
- Do not add explanatory UI helper text for ordinary interactions.

## Preview and editing

From the repository root:

```sh
npm ci
npm ci --prefix video
npm run video:check
npm run video:preview
```

Open `http://localhost:8090/TaskChefLaunch`. Play or scrub the 45-second
composition. The Scenes folder also exposes each chapter independently.
Frame 330 starts Running → Waiting for review; frame 900 starts
Waiting for review → Done. Each move lasts 30 frames.

Remotion has a separate, locked development package in `video/`. This avoids
changing the plugin's dependencies. The source is in `video/`. It imports `TaskBoard`, `ProjectPicker`,
`NextTaskDetail`, their providers, the product mark, and the production CSS.
The header uses the same Mantine controls as the native app. The host bridge is
not mounted; the film makes no MCP or GitHub requests.

The film uses a fixed three-column viewport. Card dimensions, frame-driven
transforms, and synthetic clock/usage labels keep playback and scrubbing
repeatable. These overrides apply only inside `.film-product`. The product's
280 ms live animation is slowed to one second in the film so the move is easy
to follow. No product behavior or installed plugin is changed.

The preview has no music or voice track. To export the current silent cut:

```sh
npm run video:render
```

Output: `video/out/taskchef-launch.mp4` (ignored by Git and excluded from the
published plugin). Remotion may download its render browser on the first export.
Review Remotion's current [license terms](https://www.remotion.dev/docs/license)
before commercial distribution if the producer's eligibility changes.
