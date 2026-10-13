import { interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { FilmFrame, ProductBoard } from './Frame';
export function Opening() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return <FilmFrame eyebrow="PARALLEL AI WORK" title="More projects. More moving parts.">
    <div style={{ opacity: interpolate(frame, [.5 * fps, 1.4 * fps], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }), translate: `0 ${interpolate(frame, [0, 1.4 * fps], [40, 0], { extrapolateRight: 'clamp' })}px` }}><ProductBoard phase="running" /></div>
    <div className="film-bottom-line">Keep parallel AI work in view.</div>
  </FilmFrame>;
}
