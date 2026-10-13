import { Easing, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { FilmFrame, ProductBoard } from './Frame';
export function Review() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const finished = frame >= 5 * fps;
  const progress = interpolate(frame, [5 * fps, 6 * fps], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(.22, 1, .36, 1) });
  return <FilmFrame eyebrow="FROM RUNNING TO REVIEW" title={finished ? 'Ready for your review.' : 'See what is running.'}>
    <ProductBoard phase={finished ? 'review' : 'running'} moveProgress={finished ? progress : undefined} />
    <div className="film-bottom-line">{finished ? 'Run finished → Waiting for review' : 'Your Codex chats, across projects.'}</div>
  </FilmFrame>;
}
