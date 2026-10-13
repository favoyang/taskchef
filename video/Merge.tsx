import { Easing, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { FilmFrame, ProductBoard } from './Frame';
import { BoardCamera } from './Camera';
export function Merge() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const merged = frame >= 3 * fps;
  const progress = interpolate(frame, [3 * fps, 4 * fps], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(.22, 1, .36, 1) });
  return <FilmFrame eyebrow="PR MERGED" title={merged ? 'Merged. Moved to Done.' : 'Review it. Merge it.'}>
    <BoardCamera poses={[
      { at: 0, x: 230, y: 0, scale: 1.14 }, { at: .8, x: 230, y: 0, scale: 1.14 },
      { at: 1.8, x: -1325, y: -140, scale: 2.4 }, { at: 6, x: -1325, y: -140, scale: 2.4 },
      { at: 7.2, x: 230, y: 0, scale: 1.14 },
    ]}><ProductBoard phase={merged ? 'merged' : 'review'} moveProgress={merged ? progress : undefined} /></BoardCamera>
    <div className="film-bottom-line">{merged ? 'Latest turn PR merged → Done' : 'Build project search · PR #42 · Checks passed'}</div>
  </FilmFrame>;
}
