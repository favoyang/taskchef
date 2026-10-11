import { useEffect, useRef, useState } from "react";
import { SegmentedControl } from "@mantine/core";
import { IconCheck, IconPalette } from "@tabler/icons-react";

import { VISUAL_THEMES, themeVariables, type Appearance } from "./themes";
export function AppearancePicker({ value, onChange, visualThemeId = "chatgpt", appearance = "dark", onVisualThemeChange }: { value: "light" | "dark" | "system"; onChange: (value: string) => void; visualThemeId?: string; appearance?: Appearance; onVisualThemeChange?: (id: string) => void }) {
  const [opened, setOpened] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClose = () => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; };
  const close = () => { cancelClose(); setOpened(false); };
  const open = () => { cancelClose(); setOpened(true); };
  const enter = (event: React.PointerEvent) => { if (event.pointerType !== "touch") open(); };
  const leave = (event: React.PointerEvent) => {
    if (event.pointerType === "touch") return;
    cancelClose();
    timer.current = setTimeout(close, 200);
  };
  useEffect(() => cancelClose, []);
  useEffect(() => {
    if (!opened) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { close(); button.current?.focus(); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [opened]);
  return <div className="next-appearance" ref={root}>
    <button ref={button} className="next-icon-button" aria-label="Appearance" title="Appearance" aria-expanded={opened} aria-controls="next-appearance-panel" onPointerEnter={enter} onPointerLeave={leave} onClick={open}><IconPalette size={18} /></button>
    {opened && <section id="next-appearance-panel" className="next-appearance-panel" aria-label="Appearance settings" onPointerEnter={enter} onPointerLeave={leave}>
      <h2>Appearance</h2>
      <SegmentedControl fullWidth aria-label="Light and dark appearance" value={value} onChange={onChange} data={[{ value: "light", label: "DAY" }, { value: "dark", label: "NIGHT" }, { value: "system", label: "SYSTEM" }]} size="xs" />
      <h3>Theme</h3>
      <div className="next-theme-list" role="radiogroup" aria-label="Theme" onKeyDown={event => {
        if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="radio"]'));
        const current = buttons.indexOf(event.target as HTMLButtonElement);
        if (current < 0) return;
        event.preventDefault();
        const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[index].focus(); buttons[index].click();
      }}>
        {VISUAL_THEMES.filter(item => item.variants[appearance]).sort((a, b) => a.id === "chatgpt" ? -1 : b.id === "chatgpt" ? 1 : a.label.localeCompare(b.label)).map((item, index) => {
          const colors = themeVariables(item, appearance);
          return <div key={item.id}>
            {index === 1 && <div className="next-theme-group">Codex themes</div>}
            <button role="radio" tabIndex={visualThemeId === item.id ? 0 : -1} aria-checked={visualThemeId === item.id} className="next-appearance-theme" onClick={() => onVisualThemeChange?.(item.id)}>
              <span className="next-appearance-preview" style={{ background: colors["--taskchef-page"], borderColor: colors["--taskchef-border"] }} aria-hidden="true">
                {[0, 1, 2].map(value => <i key={value} style={{ background: colors["--taskchef-surface"], borderColor: colors["--taskchef-border"] }} />)}
              </span><span>{item.label}</span>{visualThemeId === item.id && <IconCheck size={16} aria-hidden="true" />}
            </button>
          </div>;
        })}
      </div>
    </section>}
  </div>;
}
