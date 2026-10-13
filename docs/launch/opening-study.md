# Opening study

Review this 11.8-second composition before rebuilding the full launch film.

```sh
npm ci
npm ci --prefix video
npm run video:preview
```

Open `http://localhost:8090/TaskChefOpening` and press Play with sound on.
The existing `TaskChefLaunch` cut is unchanged.

When an export is requested, `npm --prefix video run render:opening` exports
this opening to `video/out/taskchef-opening.mp4`. `npm run video:render`
continues to export the full film. This review deliverable is the Studio preview.

## Edit

| Time | Picture |
| --- | --- |
| 0–1.97s | Large logo and “TaskChef — Dashboard for Codex.” Three native Running cards float on the right. |
| 1.97–3.93s | “Every project. In view.” A short statement of the board’s value; no example project-name tags. |
| 3.93–4.93s | Large “See what’s running” on the left, board on the right. The title exits while the board grows into full view. |
| 4.75–6.05s | Full board, including Scheduled and all nine chats. |
| 6.05–8.10s | Push into Running, brief hold, then pull back to the board. |
| 8.85–10.30s | Move into the next chapter: large “Ready for review” on the left; the board recedes to the right. |
| 10.10–11.80s | Move into the review columns; the featured chat finishes and moves into Waiting for review. |

All data is synthetic. Native `TaskBoard`, project picker, controls, mark,
theme and card styling come from product code. Film typography and camera
motion are separate from product behavior. No screen recording is used.

## Pacing

The opening identity and slogan follow four-beat phrases at about 122 BPM.
Camera and title transitions then overlap to keep the edit moving. This is
an editorial choice, not a universal industry standard.
Google recommends early action, tight framing, large text and faster pacing
for video ads. Wide views show the full board; the next chapter begins before
nine seconds, without a long static ending.

[Google creative guidance](https://business.google.com/de/think/search-and-video/aufmerksamkeit-gewinnen-youtube-ads/)

## Music

- Track: **Tech House vibes**, Alejandro Magaña (A. M.).
- [Official track catalog](https://mixkit.co/free-stock-music/electronica/)
- [Mixkit Stock Music Free License](https://mixkit.co/license/#musicFree)
- [License text](https://mixkit.co/license/modal/musicFree/), checked 13 October 2026.
- Commercial web/social videos and online marketing ads are allowed.
- Audio starts approximately 1.52 seconds into the source, at the measured pulse.
- The preview fades the music in and out. No narration is included.

`video/prepare-assets.mjs` copies the product mark and downloads the fixed
music asset to ignored `video/public/`. It validates the source checksum and
reuses the local copy. Raw music is not committed or included in the plugin.
The first preview start requires network access. Do not claim authorship of
the music or register it with a rights-management service.
