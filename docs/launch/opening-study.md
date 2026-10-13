# Opening study

This archived 11.2-second opening study remains in the Drafts folder.
The approved full film is documented in [video-script.md](video-script.md).

```sh
npm ci
npm ci --prefix video
npm run video:preview
```

Open `http://localhost:8090/TaskChefOpening` and press Play with sound on.
Use `TaskChefLaunch` to review the current 36⅓-second full film.

When an export is requested, `npm --prefix video run render:opening` exports
this opening to `video/out/taskchef-opening.mp4`. `npm run video:render`
continues to export the full film. This review deliverable is the Studio preview.

## Edit

| Time | Picture |
| --- | --- |
| 0–1.97s | Logo, TaskChef, Dashboard for Codex and native cards are visible from frame zero. No fade-in. |
| 1.97–4.37s | Large “Keep every project in view” beside the board; fully readable for about 1.9 seconds before exiting. No duplicate slogan screen. |
| 4.00–5.50s | Move into the full board, including Scheduled and nine chats. |
| 5.50–6.70s | Tight close-up centered on Running. |
| 6.70–7.70s | One continuous pull-back into the right-side next-title pose. |
| 7.45–9.75s | Large “Ready for review”; fully readable for about 1.8 seconds before exiting into the next zoom. |
| 9.40–11.20s | Zoom into review; the featured card moves into Waiting for review. |

All data is synthetic. Native `TaskBoard`, project picker, controls, mark,
theme and card styling come from product code. Film typography and camera
motion are separate from product behavior. No screen recording is used.

## Pacing

The opening identity follows a four-beat phrase at about 122 BPM.
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
