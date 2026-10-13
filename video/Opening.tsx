import { interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { FilmFrame, ProductBoard } from './Frame';
import { BoardCamera } from './Camera';
export function Opening() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return <FilmFrame eyebrow="PARALLEL AI WORK" title="More projects. More moving parts.">
    <BoardCamera poses={[{ at: 0, x: 282, y: 24, scale: 1.06 }, { at: 1.8, x: 230, y: 0, scale: 1.14 }]}>
      <div style={{ opacity: interpolate(frame, [.3 * fps, 1.2 * fps], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) }}><ProductBoard phase="running" /></div>
    </BoardCamera>
    <div className="film-bottom-line">Keep parallel AI work in view.</div>
  </FilmFrame>;
}
