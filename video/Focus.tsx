import { useCurrentFrame, useVideoConfig } from 'remotion';
import { FilmFrame, ProductBoard } from './Frame';
export function Focus() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const focused = frame >= 2 * fps;
  return <FilmFrame eyebrow="PROJECT FILTERING" title="One project. Your full attention.">
    <ProductBoard phase="merged" project={focused ? 'atlas' : ''} />
    <div className="film-filter-ring" style={{ opacity: frame >= fps && frame < 3 * fps ? 1 : 0 }} />
    <div className="film-bottom-line">{focused ? 'Atlas · Only the chats for this project.' : 'Choose the project you want to focus on.'}</div>
  </FilmFrame>;
}
