import { NextTaskDetail } from '../src/mcp-app/react/NextTaskDetail';
import { FilmFrame, ProductBoard } from './Frame';
import { demoTasks } from './demo';
const noop = () => {};
export function Usage() {
  return <FilmFrame eyebrow="TURN + CHAT USAGE" title="Know the usage behind the work.">
    <ProductBoard phase="review" style={{ left: 285, top: 230, height: 535, transform: "scale(1.35)" }}>
      <style>{`.film-product .mantine-Modal-content { max-height: 505px; }`}</style>
      <NextTaskDetail task={demoTasks('review')[0]} opened busy={false} error={null} onClose={noop} onOpenCodex={noop} />
    </ProductBoard>
    <div className="film-bottom-line">Latest turn and total chat · Tokens + estimated API cost</div>
  </FilmFrame>;
}
