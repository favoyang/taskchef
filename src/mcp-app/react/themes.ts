// Palette seeds from the installed Codex desktop theme registry (October 2026).
// Declarative UI colors and font families; no desktop implementation or syntax themes are bundled.
export type Appearance = "light" | "dark";
export interface PaletteSeed { surface: string; ink: string; accent: string; contrast: number; diffAdded: string; diffRemoved: string; skill: string; uiFont?: string; codeFont?: string; contentFont?: string; }
export interface VisualTheme { id: string; label: string; variants: Partial<Record<Appearance, PaletteSeed>>; }
export const VISUAL_THEMES: VisualTheme[] = [
  {"id": "chatgpt", "label": "ChatGPT", "variants": {"light": {"surface": "#fcfcfc", "ink": "#0d0d0d", "accent": "#3a83f7", "contrast": 45, "diffAdded": "#00a240", "diffRemoved": "#ba2623", "skill": "#924ff7"}, "dark": {"surface": "#000000", "ink": "#ededed", "accent": "#3a83f7", "contrast": 60, "diffAdded": "#40c977", "diffRemoved": "#fa423e", "skill": "#ad7bf9"}}},
  {"id": "ayu", "label": "Ayu", "variants": {"dark": {"surface": "#10141c", "ink": "#bfbdb6", "accent": "#e6b450", "contrast": 60, "diffAdded": "#70bf56", "diffRemoved": "#f26d78", "skill": "#d0a1ff"}}},
  {"id": "catppuccin", "label": "Catppuccin", "variants": {"light": {"surface": "#eff1f5", "ink": "#4c4f69", "accent": "#8839ef", "contrast": 45, "diffAdded": "#40a02b", "diffRemoved": "#d20f39", "skill": "#8839ef"}, "dark": {"surface": "#1e1e2e", "ink": "#cdd6f4", "accent": "#cba6f7", "contrast": 60, "diffAdded": "#a6e3a1", "diffRemoved": "#f38ba8", "skill": "#cba6f7"}}},
  {"id": "absolutely", "label": "Absolutely", "variants": {"light": {"surface": "#f9f9f7", "ink": "#2d2d2b", "accent": "#cc7d5e", "contrast": 45, "diffAdded": "#00c853", "diffRemoved": "#ff5f38", "skill": "#cc7d5e"}, "dark": {"surface": "#2d2d2b", "ink": "#f9f9f7", "accent": "#cc7d5e", "contrast": 60, "diffAdded": "#00c853", "diffRemoved": "#ff5f38", "skill": "#cc7d5e"}}},
  {"id": "codex", "label": "Codex", "variants": {"light": {"surface": "#ffffff", "ink": "#0d0d0d", "accent": "#0169cc", "contrast": 45, "diffAdded": "#00a240", "diffRemoved": "#e02e2a", "skill": "#751ed9"}, "dark": {"surface": "#111111", "ink": "#fcfcfc", "accent": "#0169cc", "contrast": 60, "diffAdded": "#00a240", "diffRemoved": "#e02e2a", "skill": "#b06dff"}}},
  {"id": "dracula", "label": "Dracula", "variants": {"dark": {"surface": "#282a36", "ink": "#f8f8f2", "accent": "#ff79c6", "contrast": 60, "diffAdded": "#50fa7b", "diffRemoved": "#ff5555", "skill": "#ff79c6"}}},
  {"id": "everforest", "label": "Everforest", "variants": {"light": {"surface": "#fdf6e3", "ink": "#5c6a72", "accent": "#93b259", "contrast": 45, "diffAdded": "#8da101", "diffRemoved": "#f85552", "skill": "#df69ba"}, "dark": {"surface": "#2d353b", "ink": "#d3c6aa", "accent": "#a7c080", "contrast": 60, "diffAdded": "#a7c080", "diffRemoved": "#e67e80", "skill": "#d699b6"}}},
  {"id": "github", "label": "GitHub", "variants": {"light": {"surface": "#ffffff", "ink": "#1f2328", "accent": "#0969da", "contrast": 45, "diffAdded": "#1a7f37", "diffRemoved": "#cf222e", "skill": "#8250df"}, "dark": {"surface": "#0d1117", "ink": "#e6edf3", "accent": "#1f6feb", "contrast": 60, "diffAdded": "#3fb950", "diffRemoved": "#f85149", "skill": "#bc8cff"}}},
  {"id": "gruvbox", "label": "Gruvbox", "variants": {"light": {"surface": "#fbf1c7", "ink": "#3c3836", "accent": "#458588", "contrast": 45, "diffAdded": "#3c3836", "diffRemoved": "#cc241d", "skill": "#b16286"}, "dark": {"surface": "#282828", "ink": "#ebdbb2", "accent": "#458588", "contrast": 60, "diffAdded": "#ebdbb2", "diffRemoved": "#cc241d", "skill": "#b16286"}}},
  {"id": "linear", "label": "Linear", "variants": {"light": {"surface": "#fcfcfd", "ink": "#1b1b1b", "accent": "#5e6ad2", "contrast": 45, "diffAdded": "#52a450", "diffRemoved": "#c94446", "skill": "#8160d8", "uiFont": "Inter"}, "dark": {"surface": "#0f0f11", "ink": "#e3e4e6", "accent": "#606acc", "contrast": 60, "diffAdded": "#69c967", "diffRemoved": "#ff7e78", "skill": "#c2a1ff", "uiFont": "Inter"}}},
  {"id": "lobster", "label": "Lobster", "variants": {"dark": {"surface": "#111827", "ink": "#e4e4e7", "accent": "#ff5c5c", "contrast": 60, "diffAdded": "#22c55e", "diffRemoved": "#ff5c5c", "skill": "#3b82f6", "uiFont": "Satoshi"}}},
  {"id": "material", "label": "Material", "variants": {"dark": {"surface": "#212121", "ink": "#eeffff", "accent": "#80cbc4", "contrast": 60, "diffAdded": "#c3e88d", "diffRemoved": "#f07178", "skill": "#c792ea"}}},
  {"id": "matrix", "label": "Matrix", "variants": {"dark": {"surface": "#040805", "ink": "#b8ffca", "accent": "#1eff5a", "contrast": 60, "diffAdded": "#1eff5a", "diffRemoved": "#fa423e", "skill": "#1eff5a", "uiFont": "ui-monospace, \"SFMono-Regular\", \"SF Mono\", Menlo, Consolas, \"Liberation Mono\", monospace"}}},
  {"id": "monokai", "label": "Monokai", "variants": {"dark": {"surface": "#272822", "ink": "#f8f8f2", "accent": "#99947c", "contrast": 60, "diffAdded": "#86b42b", "diffRemoved": "#c4265e", "skill": "#8c6bc8"}}},
  {"id": "night-owl", "label": "Night Owl", "variants": {"dark": {"surface": "#011627", "ink": "#d6deeb", "accent": "#44596b", "contrast": 60, "diffAdded": "#c5e478", "diffRemoved": "#ef5350", "skill": "#c792ea"}}},
  {"id": "nord", "label": "Nord", "variants": {"dark": {"surface": "#2e3440", "ink": "#d8dee9", "accent": "#88c0d0", "contrast": 60, "diffAdded": "#a3be8c", "diffRemoved": "#bf616a", "skill": "#b48ead"}}},
  {"id": "notion", "label": "Notion", "variants": {"light": {"surface": "#ffffff", "ink": "#37352f", "accent": "#3183d8", "contrast": 45, "diffAdded": "#008000", "diffRemoved": "#a31515", "skill": "#0000ff"}, "dark": {"surface": "#191919", "ink": "#d9d9d8", "accent": "#3183d8", "contrast": 60, "diffAdded": "#4ec9b0", "diffRemoved": "#fa423e", "skill": "#3183d8"}}},
  {"id": "og", "label": "OG", "variants": {"dark": {"surface": "#343541", "ink": "#d1d5db", "accent": "#10a37f", "contrast": 60, "diffAdded": "#65c99a", "diffRemoved": "#f28b82", "skill": "#b4a1e5", "uiFont": "Arial, sans-serif", "contentFont": "Arial, sans-serif"}}},
  {"id": "oscurange", "label": "Oscurange", "variants": {"dark": {"surface": "#0b0b0f", "ink": "#e6e6e6", "accent": "#f9b98c", "contrast": 60, "diffAdded": "#40c977", "diffRemoved": "#fa423e", "skill": "#479ffa"}}},
  {"id": "one", "label": "One", "variants": {"light": {"surface": "#fafafa", "ink": "#383a42", "accent": "#526fff", "contrast": 45, "diffAdded": "#3bba54", "diffRemoved": "#e45649", "skill": "#526fff"}, "dark": {"surface": "#282c34", "ink": "#abb2bf", "accent": "#4d78cc", "contrast": 60, "diffAdded": "#8cc265", "diffRemoved": "#e05561", "skill": "#c162de"}}},
  {"id": "proof", "label": "Proof", "variants": {"light": {"surface": "#f5f3ed", "ink": "#2f312d", "accent": "#3d755d", "contrast": 45, "diffAdded": "#3d755d", "diffRemoved": "#ba2623", "skill": "#5f6ac2"}}},
  {"id": "raycast", "label": "Raycast", "variants": {"light": {"surface": "#ffffff", "ink": "#030303", "accent": "#ff6363", "contrast": 45, "diffAdded": "#006b4f", "diffRemoved": "#b12424", "skill": "#9a1b6e", "uiFont": "Inter", "codeFont": "\"Jetbrains Mono\""}, "dark": {"surface": "#101010", "ink": "#fefefe", "accent": "#ff6363", "contrast": 60, "diffAdded": "#59d499", "diffRemoved": "#ff6363", "skill": "#cf2f98", "uiFont": "Inter", "codeFont": "\"Jetbrains Mono\""}}},
  {"id": "rose-pine", "label": "Rose Pine", "variants": {"light": {"surface": "#faf4ed", "ink": "#575279", "accent": "#d7827e", "contrast": 45, "diffAdded": "#56949f", "diffRemoved": "#797593", "skill": "#907aa9"}, "dark": {"surface": "#232136", "ink": "#e0def4", "accent": "#ea9a97", "contrast": 60, "diffAdded": "#9ccfd8", "diffRemoved": "#908caa", "skill": "#c4a7e7"}}},
  {"id": "sentry", "label": "Sentry", "variants": {"dark": {"surface": "#2d2935", "ink": "#e6dff9", "accent": "#7055f6", "contrast": 60, "diffAdded": "#8ee6d7", "diffRemoved": "#fa423e", "skill": "#7055f6"}}},
  {"id": "solarized", "label": "Solarized", "variants": {"light": {"surface": "#fdf6e3", "ink": "#657b83", "accent": "#b58900", "contrast": 45, "diffAdded": "#859900", "diffRemoved": "#dc322f", "skill": "#d33682"}, "dark": {"surface": "#002b36", "ink": "#839496", "accent": "#d30102", "contrast": 60, "diffAdded": "#859900", "diffRemoved": "#dc322f", "skill": "#d33682"}}},
  {"id": "tokyo-night", "label": "Tokyo Night", "variants": {"dark": {"surface": "#1a1b26", "ink": "#a9b1d6", "accent": "#3d59a1", "contrast": 60, "diffAdded": "#449dab", "diffRemoved": "#914c54", "skill": "#9d7cd8"}}},
  {"id": "temple", "label": "Temple", "variants": {"dark": {"surface": "#02120c", "ink": "#c7e6da", "accent": "#e4f222", "contrast": 60, "diffAdded": "#40c977", "diffRemoved": "#fa423e", "skill": "#e4f222"}}},
  {"id": "vercel", "label": "Vercel", "variants": {"light": {"surface": "#ffffff", "ink": "#171717", "accent": "#006aff", "contrast": 40, "diffAdded": "#28A948", "diffRemoved": "#EB001D", "skill": "#A100F8", "uiFont": "Geist, Inter", "codeFont": "\"Geist Mono\", ui-monospace, \"SFMono-Regular\""}, "dark": {"surface": "#000000", "ink": "#ededed", "accent": "#006efe", "contrast": 50, "diffAdded": "#00AD3A", "diffRemoved": "#F13342", "skill": "#9540D5", "uiFont": "Geist, Inter", "codeFont": "\"Geist Mono\", ui-monospace, \"SFMono-Regular\""}}},
  {"id": "vscode-plus", "label": "VS Code Plus", "variants": {"light": {"surface": "#ffffff", "ink": "#000000", "accent": "#007acc", "contrast": 45, "diffAdded": "#008000", "diffRemoved": "#ee0000", "skill": "#0000ff"}, "dark": {"surface": "#1e1e1e", "ink": "#d4d4d4", "accent": "#007acc", "contrast": 60, "diffAdded": "#369432", "diffRemoved": "#f44747", "skill": "#000080"}}},
  {"id": "xcode", "label": "Xcode", "variants": {"light": {"surface": "#ffffff", "ink": "#000000", "accent": "#0e0eff", "contrast": 45, "diffAdded": "#00a240", "diffRemoved": "#c41a16", "skill": "#0e0eff", "codeFont": "\"SFMono-Regular\""}, "dark": {"surface": "#1f1f24", "ink": "#ffffff", "accent": "#5482ff", "contrast": 60, "diffAdded": "#67b7a4", "diffRemoved": "#fc6a5d", "skill": "#5482ff", "codeFont": "\"SFMono-Medium\""}}}
];

export function visualTheme(id: string | null, appearance: Appearance): VisualTheme {
  return VISUAL_THEMES.find(item => item.id === id && item.variants[appearance]) ?? VISUAL_THEMES[0];
}
export const VISUAL_THEME_KEY = "taskchef.app.visualTheme";
export function savedVisualTheme(appearance: Appearance): string {
  try { return visualTheme(window.localStorage.getItem(`${VISUAL_THEME_KEY}.${appearance}`), appearance).id; }
  catch { return "chatgpt"; }
}

function mix(from: string, to: string, amount: number): string {
  const channels = [1, 3, 5].map(offset => {
    const start = parseInt(from.slice(offset, offset + 2), 16);
    return Math.round(start + (parseInt(to.slice(offset, offset + 2), 16) - start) * amount).toString(16).padStart(2, "0");
  });
  return `#${channels.join("")}`;
}
function alpha(color: string, opacity: number): string { return `${color}${Math.round(opacity * 255).toString(16).padStart(2, "0")}`; }
export function contrastRatio(foreground: string, background: string): number {
  const luminance = (color: string) => [1, 3, 5].reduce((sum, offset, index) => {
    const value = parseInt(color.slice(offset, offset + 2), 16) / 255;
    return sum + (value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][index];
  }, 0);
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + .05) / (values[1] + .05);
}
function readable(color: string, backgrounds: string[], dark: boolean): string {
  for (let amount = 0; amount <= 100; amount++) {
    const adjusted = mix(color, dark ? "#ffffff" : "#000000", amount / 100);
    if (backgrounds.every(background => contrastRatio(adjusted, background) >= 4.5)) return adjusted;
  }
  return dark ? "#ffffff" : "#000000";
}
export function themeVariables(theme: VisualTheme, appearance: Appearance): Record<string, string> {
  const seed = theme.variants[appearance]!;
  const { surface, ink, accent } = seed;
  const dark = appearance === "dark";
  const baseline = dark ? 60 : 45;
  // Codex increases surface separation and foreground opacity with contrast.
  const rawContrast = seed.contrast / 100 + (seed.contrast - baseline) / 60 * .7;
  const contrast = seed.contrast <= baseline ? rawContrast : baseline / 100 + (rawContrast - baseline / 100) * 2;
  const page = mix(surface, dark ? "#000000" : ink, (dark ? .16 : .04) + (seed.contrast - baseline) * (dark ? .0015 : .0012));
  const control = mix(surface, dark ? ink : "#ffffff", dark ? .06 + contrast * .05 : .09 + contrast * .04);
  const elevated = mix(surface, dark ? ink : "#ffffff", dark ? .08 + contrast * .08 : .16 + contrast * .12);
  const backgrounds = [page, surface, control, elevated];
  const text = readable(ink, backgrounds, dark);
  const muted = readable(mix(surface, ink, .65 + contrast * .1), backgrounds, dark);
  const link = readable(dark ? mix(accent, "#ffffff", .3 + contrast * .15) : accent, backgrounds, dark);
  const systemFont = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  const codeFallback = 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';
  return {
    "--taskchef-font": seed.uiFont ? `${seed.uiFont}, ${systemFont}` : systemFont,
    "--taskchef-content-font": seed.contentFont ? `${seed.contentFont}, ${systemFont}` : seed.uiFont ? `${seed.uiFont}, ${systemFont}` : systemFont,
    "--taskchef-code-font": seed.codeFont ? `${seed.codeFont}, ${codeFallback}` : codeFallback,
    "--taskchef-page": page,
    "--taskchef-surface": surface,
    "--taskchef-surface-muted": control,
    "--taskchef-elevated": elevated,
    "--taskchef-border": alpha(ink, .06 + contrast * .04),
    "--taskchef-border-heavy": alpha(ink, (dark ? .12 : .09) + contrast * .06),
    "--taskchef-text": text,
    "--taskchef-muted": muted,
    "--taskchef-accent": link,
    "--taskchef-link": link,
    "--taskchef-focus": link,
    "--taskchef-hover": alpha(ink, dark ? .05 + contrast * .03 : .08 + contrast * .04),
    "--taskchef-prompt": theme.id === "chatgpt" ? (dark ? "#323232d9" : "#e9e9e980") : alpha(ink, .05),
    "--taskchef-prompt-text": text,
    "--taskchef-popup-shadow": dark ? "0 8px 32px #0006" : "0 8px 24px #00000014",
    "--taskchef-card-shadow": dark ? "none" : "0 1px 3px #00000008",
    "--taskchef-success": seed.diffAdded,
    "--taskchef-error": seed.diffRemoved,
    "--taskchef-skill": seed.skill,
  };
}
