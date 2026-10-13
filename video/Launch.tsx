import type { CSSProperties, ReactNode } from 'react';
import { Audio } from '@remotion/media';
import { AbsoluteFill, Easing, Img, Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { NextTaskDetail } from '../src/mcp-app/react/NextTaskDetail';
import { themeVariables, visualTheme } from '../src/mcp-app/react/themes';
import { ProductBoard } from './Frame';
import { FloatingChats } from './OpeningStudy';
import { demoTasks, usage } from './demo';

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const ease = Easing.bezier(.65, 0, .2, 1);
const noop = () => {};

function ChapterTitle({ children }: { children: ReactNode }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return <div className="opening-section-title launch-title" style={{
    opacity: interpolate(frame / fps, [0, .15, 2.1, 2.45], [0, 1, 1, 0], clamp),
    translate: `${interpolate(frame / fps, [0, .4, 2.1, 2.45], [35, 0, 0, -100], { ...clamp, easing: ease })}px 0`,
  }}>{children}</div>;
}

export function Launch() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const time = frame / fps;
  // One camera and one board preserve spatial continuity across chapters.
  const times = [2, 4.2, 4.8, 5.6, 6.8, 8.1, 8.7, 10.7, 11.5, 13.2, 13.8, 15.6, 16.4, 18.2, 19, 20.7, 21.5, 23.2, 23.7, 25.6, 26.4, 28.2, 28.7, 29.2, 29.9, 31];
  const scales = [.62, .62, 1.22, 1.22, .62, .62, 3, 3, .62, .62, 2.4, 2.4, .62, .62, 2.3, 2.3, .62, .62, 2.4, 2.4, .62, .62, 2.8, 2.8, 1.22, 1.22];
  const xs = [1050, 1050, 179, 179, 1050, 1050, -470, -470, 1050, 1050, -575, -575, 1050, 1050, -1157, -1157, 1050, 1050, -1325, -1325, 1050, 1050, 3, 3, 179, 179];
  const ys = [320, 320, 240, 240, 320, 320, 30, 30, 320, 320, 80, 80, 320, 320, -422, -422, 320, 320, 80, 80, 320, 320, 220, 220, 240, 240];
  const pose = (values: number[]) => interpolate(time, times, values, { ...clamp, easing: ease });
  const phase = time >= 23.8 ? 'merged' : time >= 14 ? 'review' : 'running';
  const move = phase === 'review' && time < 14.7 ? interpolate(time, [14, 14.7], [0, 1], { ...clamp, easing: ease })
    : phase === 'merged' && time < 24.5 ? interpolate(time, [23.8, 24.5], [0, 1], { ...clamp, easing: ease }) : undefined;
  const live = interpolate(time, [8.3, 10.7], [0, 1], clamp);
  const liveUsage = usage(Math.round(600_000 + live * 640_000), .4 + live * .46);
  const selected = time >= 28.6;
  const filter = interpolate(time, [28.6, 29.2], [0, 1], { ...clamp, easing: ease });
  const fadeOther = interpolate(time, [28.25, 28.6], [1, 0], clamp);
  const detail = time >= 18.2 && time < 20.9;
  const usageRow = time < 19.9 ? 1 : 2;
  return <AbsoluteFill className="film opening-study launch-film" style={themeVariables(visualTheme('codex', 'dark'), 'dark') as CSSProperties}>
    <Audio name="Tech House vibes — Mixkit" src={staticFile('tech-house-vibes.mp3')} trimBefore={Math.round(1.52 * fps)} durationInFrames={34 * fps} premountFor={fps}
      volume={interpolate(time, [0, .1, 32.8, 34], [0, .8, .8, 0], clamp)} />
    <div className="opening-halo" style={{ translate: `${Math.sin(time * .7) * 90}px ${Math.cos(time * .5) * 35}px` }} />
    {time >= 2 && time < 31 && <div className="opening-brand"><Img src={staticFile('taskchef-dark.svg')} alt="" />TaskChef <span>Dashboard for Codex</span></div>}
    <Sequence name="Product identity" from={0} durationInFrames={2 * fps} premountFor={fps}>
      <div className="opening-type"><div className="opening-identity"><div><Img src={staticFile('taskchef-dark.svg')} alt="" /><span>TaskChef</span></div><p>Dashboard for Codex</p></div></div>
      <div className="opening-rails" style={{ rotate: '-12deg', translate: `${time * 180 - 240}px 0` }}><i /><i /><i /></div>
      <FloatingChats time={time} heroUsage={usage(600_000, .4)} />
    </Sequence>
    {time >= 2 && time < 31 && <div className="opening-board-mask">
      <div className="opening-board-stage" inert style={{ left: pose(xs), top: pose(ys) - 220, scale: pose(scales) }}>
        <ProductBoard phase={phase} moveProgress={move} project={selected ? 'atlas' : ''} heroUsage={phase === 'running' ? liveUsage : undefined} filterProgress={selected ? filter : undefined} highlightProject={time >= 28 && time < 29.3}>
          <style>{`.launch-film .film-product .mantine-Modal-content { max-height: 505px; }
            .launch-film .taskchef-detail-usage tbody tr:nth-child(${usageRow}) { background: #8cc9ff20; }
            ${demoTasks('merged').filter(task => task.project.id !== 'atlas').map(task => `.launch-film [data-chat-id="${task.id}"] { opacity: ${time >= 28.25 ? fadeOther : 1}; }`).join('\n')}`}</style>
          {detail && <NextTaskDetail task={demoTasks('review')[0]} opened busy={false} error={null} onClose={noop} onOpenCodex={noop} />}
        </ProductBoard>
      </div>
    </div>}
    <Sequence name="Full board" from={2 * fps} durationInFrames={2.5 * fps} premountFor={fps}><ChapterTitle>Keep every<br />project<br /><span>in view.</span></ChapterTitle></Sequence>
    <Sequence name="Running and live usage" from={6 * fps} durationInFrames={2.5 * fps} premountFor={fps}><ChapterTitle>See what’s<br /><span>running.</span></ChapterTitle></Sequence>
    <Sequence name="Finished chat moves to review" from={11 * fps} durationInFrames={2.5 * fps} premountFor={fps}><ChapterTitle>Ready for<br /><span>your review.</span></ChapterTitle></Sequence>
    <Sequence name="Turn and chat usage" from={16 * fps} durationInFrames={2.5 * fps} premountFor={fps}><ChapterTitle>Usage,<br /><span>turn by turn.</span></ChapterTitle></Sequence>
    <Sequence name="Merged PR moves to Done" from={21 * fps} durationInFrames={2.5 * fps} premountFor={fps}><ChapterTitle>Merged.<br /><span>Done.</span></ChapterTitle></Sequence>
    <Sequence name="Project filtering" from={26 * fps} durationInFrames={2.5 * fps} premountFor={fps}><ChapterTitle>Focus on<br /><span>one project.</span></ChapterTitle></Sequence>
    <Sequence name="TaskChef closing" from={31 * fps} durationInFrames={3 * fps} premountFor={fps}>
      <AbsoluteFill className="film film-closing"><div className="film-glow" /><div><Img src={staticFile('taskchef-dark.svg')} alt="" /><h1>TaskChef</h1><p>Dashboard for Codex</p><div className="film-url">taskchef.dev</div></div></AbsoluteFill>
    </Sequence>
  </AbsoluteFill>;
}
