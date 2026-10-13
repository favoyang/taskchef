import { Easing, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { FilmFrame, ProductBoard } from './Frame';
export function Merge() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const merged = frame >= 3 * fps;
  const progress = interpolate(frame, [3 * fps, 4 * fps], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(.22, 1, .36, 1) });
  return <FilmFrame eyebrow="PR MERGED" title={merged ? 'Merged. Moved to Done.' : 'Review it. Merge it.'}>
    <ProductBoard phase={merged ? 'merged' : 'review'} moveProgress={merged ? progress : undefined} />
    <div className="film-bottom-line">{merged ? 'Latest turn PR merged → Done' : 'Build project search · PR #42 · Checks passed'}</div>
  </FilmFrame>;
}
