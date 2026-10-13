import { NextTaskDetail } from '../src/mcp-app/react/NextTaskDetail';
import { FilmFrame, ProductBoard } from './Frame';
import { BoardCamera } from './Camera';
import { demoTasks } from './demo';
const noop = () => {};
export function Usage() {
  return <FilmFrame eyebrow="TURN + CHAT USAGE" title="Know the usage behind the work.">
    <BoardCamera poses={[
      { at: 0, x: 230, y: 0, scale: 1.14 }, { at: 1.3, x: 230, y: 0, scale: 1.14 },
      { at: 2.6, x: -1157, y: -636, scale: 2.3 }, { at: 7.2, x: -1157, y: -636, scale: 2.3 },
      { at: 8.7, x: 230, y: 0, scale: 1.14 },
    ]}>
      <ProductBoard phase="review">
        <style>{`.film-product .mantine-Modal-content { max-height: 505px; }`}</style>
        <NextTaskDetail task={demoTasks('review')[0]} opened busy={false} error={null} onClose={noop} onOpenCodex={noop} />
      </ProductBoard>
    </BoardCamera>
    <div className="film-bottom-line">Latest turn and total chat · Tokens + estimated API cost</div>
  </FilmFrame>;
}
