import { Easing, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { FilmFrame, ProductBoard } from './Frame';
import { BoardCamera } from './Camera';
export function Review() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const finished = frame >= 5 * fps;
  const progress = interpolate(frame, [5 * fps, 6 * fps], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(.22, 1, .36, 1) });
  return <FilmFrame eyebrow="FROM RUNNING TO REVIEW" title={finished ? 'Ready for your review.' : 'See what is running.'}>
    <BoardCamera poses={[
      { at: 0, x: 230, y: 0, scale: 1.14 }, { at: 1, x: 230, y: 0, scale: 1.14 },
      { at: 2.5, x: -575, y: -140, scale: 2.4 }, { at: 7.5, x: -575, y: -140, scale: 2.4 },
      { at: 9, x: 230, y: 0, scale: 1.14 },
    ]}><ProductBoard phase={finished ? 'review' : 'running'} moveProgress={finished ? progress : undefined} /></BoardCamera>
    <div className="film-bottom-line">{finished ? 'Run finished → Waiting for review' : 'Your Codex chats, across projects.'}</div>
  </FilmFrame>;
}
