# TaskChef icons

All icons use the same chef hat and T artwork. The SVG files are the editable sources.

| Use | File | Background |
| --- | --- | --- |
| App and navbar, light theme | `taskchef.svg` | Rounded orange square; transparent outside |
| App and navbar, dark theme | `taskchef-dark.svg` | Rounded orange square; transparent outside |
| App icon PNG export, dark theme | `taskchef-app-rounded.png` | Rounded orange square; transparent outside |
| Sidebar preview, light theme | `taskchef-sidebar-light.svg` | Dark strokes; transparent |
| Sidebar preview, dark theme | `taskchef-sidebar-dark.svg` | Light strokes; transparent |
| Codex sidebar | `taskchef-sidebar.svg` | Monochrome `currentColor`; transparent |
| GitHub and other services that apply a circle crop | `taskchef-avatar-square.svg`, `taskchef-avatar-square.png` | Solid orange to all four edges |

The app and sidebar SVGs are unchanged. The square avatar uses the current dark-theme navbar artwork and colors. Its hat is enlarged by 30% and centered for circle crops. The two sidebar preview files show the same light/dark colors that the MCP server already provides; the runtime continues to use the theme-neutral template. Both PNG exports are 512 × 512 pixels.

For GitHub, upload `taskchef-avatar-square.png` and set the badge background color to `#F59E0B`. Keep the full image when GitHub asks for a crop.

Export PNGs directly from the SVG sources. Do not use an image generator: these are flat vector icons, with no gradients, shadows, or texture.
