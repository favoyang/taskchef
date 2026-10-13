import { useCurrentFrame, useVideoConfig } from 'remotion';
import { FilmFrame, ProductBoard } from './Frame';
import { BoardCamera } from './Camera';
export function Focus() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const focused = frame >= 2 * fps;
  return <FilmFrame eyebrow="PROJECT FILTERING" title="One project. Your full attention.">
    <BoardCamera poses={[
      { at: 0, x: 230, y: 0, scale: 1.14 }, { at: .6, x: 230, y: 0, scale: 1.14 },
      { at: 1.4, x: 3, y: 0, scale: 2.8 }, { at: 2.7, x: 3, y: 0, scale: 2.8 },
      { at: 4, x: 230, y: 0, scale: 1.14 },
    ]}><ProductBoard phase="merged" project={focused ? 'atlas' : ''} highlightProject={frame >= fps && frame < 3 * fps} /></BoardCamera>
    <div className="film-bottom-line">{focused ? 'Atlas · Only the chats for this project.' : 'Choose the project you want to focus on.'}</div>
  </FilmFrame>;
}
