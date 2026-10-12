import type { SVGProps } from "react";

type Props = Omit<SVGProps<SVGSVGElement>, "stroke"> & { size?: number; stroke?: number };
type Shape = "open" | "status" | "draft" | "merged" | "closed";

// Drawn on a 20px grid to match Codex's branch layout and node sizes.
// The status dot replaces the right node; it is not an external badge.
function PrGlyph({ shape, size = 15, stroke: _stroke, ...props }: Props & { shape: Shape }) {
  return <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.33} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx={5.42} cy={5} r={1.875} />
    <path d="M5.42 6.875V13.125" />
    <circle cx={5.42} cy={15} r={1.875} />
    {shape === "merged" ? <>
      <path d="M6.2 6.6C7.1 10.2 9.3 11.9 12.71 12.5" />
      <circle cx={14.58} cy={12.5} r={1.875} />
    </> : shape === "draft" ? <>
      <circle cx={14.58} cy={5} r={1} fill="currentColor" stroke="none" />
      <circle cx={14.58} cy={9.25} r={1} fill="currentColor" stroke="none" />
      <circle cx={14.58} cy={15} r={1.875} />
    </> : shape === "closed" ? <>
      <path d="M12.92 3.33L16.25 6.67M16.25 3.33L12.92 6.67M14.58 9.58V13.125" />
      <circle cx={14.58} cy={15} r={1.875} />
    </> : <>
      <path d="M11.67 3.33L10 5L11.67 6.67M10 5H13.33Q15 5 15 6.67V9.17" />
      {shape === "status" ? <circle cx={15.14} cy={15.14} r={3.14} fill="var(--taskchef-pr-dot-color, currentColor)" stroke="none" />
        : <path d="M15 12.5V16.67M12.92 14.58H17.08" />}
    </>}
  </svg>;
}

export function PrOpenIcon(props: Props) { return <PrGlyph {...props} shape="open" />; }
export function PrStatusIcon(props: Props) { return <PrGlyph {...props} shape="status" />; }
export function PrDraftIcon(props: Props) { return <PrGlyph {...props} shape="draft" />; }
export function PrMergedIcon(props: Props) { return <PrGlyph {...props} shape="merged" />; }
export function PrClosedIcon(props: Props) { return <PrGlyph {...props} shape="closed" />; }
