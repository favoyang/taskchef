import { afterEach, expect, test } from "vitest";
import { VISUAL_THEMES, visualTheme, savedVisualTheme, themeVariables, contrastRatio } from "./themes";
afterEach(() => localStorage.clear());
test("native presets retain their supported appearances", () => {
  expect(VISUAL_THEMES).toHaveLength(30);
  expect(Object.keys(visualTheme("codex", "light").variants)).toEqual(["light", "dark"]);
  expect(visualTheme("dracula", "light").id).toBe("chatgpt");
  expect(visualTheme("proof", "dark").id).toBe("chatgpt");
  expect(visualTheme("unknown", "dark").id).toBe("chatgpt");
});
test("each appearance restores its own palette with a safe default", () => {
  localStorage.setItem("taskchef.app.visualTheme", "default");
  expect(savedVisualTheme("light")).toBe("chatgpt");
  localStorage.setItem("taskchef.app.visualTheme.light", "catppuccin");
  localStorage.setItem("taskchef.app.visualTheme.dark", "nord");
  expect(savedVisualTheme("light")).toBe("catppuccin");
  expect(savedVisualTheme("dark")).toBe("nord");
});
test("all shipped variants supply readable text and links on every UI surface", () => {
  for (const theme of VISUAL_THEMES) for (const appearance of ["light", "dark"] as const) {
    if (!theme.variants[appearance]) continue;
    const values = themeVariables(theme, appearance);
    for (const role of ["text", "muted", "link"]) for (const surface of ["page", "surface", "surface-muted", "elevated"]) {
      expect(contrastRatio(values[`--taskchef-${role}`], values[`--taskchef-${surface}`]), `${theme.id}/${appearance}/${role}/${surface}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(values["--taskchef-surface"]).toBe(theme.variants[appearance]!.surface);
  }
});

test("native font overrides retain system fallbacks", () => {
  expect(themeVariables(visualTheme("matrix", "dark"), "dark")["--taskchef-font"]).toContain("ui-monospace");
  expect(themeVariables(visualTheme("linear", "light"), "light")["--taskchef-font"]).toContain('Inter, -apple-system');
  expect(themeVariables(visualTheme("vercel", "dark"), "dark")["--taskchef-code-font"]).toContain('"Geist Mono"');
});
