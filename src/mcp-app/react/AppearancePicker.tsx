import { useEffect, useRef, useState } from "react";
import { SegmentedControl } from "@mantine/core";
import { IconCheck, IconPalette } from "@tabler/icons-react";

const VISUAL_THEME_KEY = "taskchef.app.visualTheme";
export function AppearancePicker({ value, onChange }: { value: "light" | "dark" | "system"; onChange: (value: string) => void }) {
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
  function selectDefault() {
    // Default is the only available visual theme. Keep its selection separate from appearance.
    try { window.localStorage.setItem(VISUAL_THEME_KEY, "default"); } catch { /* Default remains selected when storage is unavailable. */ }
  }
  useEffect(() => { selectDefault(); return cancelClose; }, []);
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
      <div role="radiogroup" aria-label="Theme">
        <button role="radio" aria-checked="true" className="next-appearance-theme" onClick={selectDefault}>
          <span className="next-appearance-preview" aria-hidden="true"><i /><i /><i /></span><span>Default</span><IconCheck size={16} aria-hidden="true" />
        </button>
      </div>
    </section>}
  </div>;
}
