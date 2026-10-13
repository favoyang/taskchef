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
  return <div className="launch-title-overlay" style={{
    opacity: interpolate(frame / fps, [0, .15, 2.1, 2.45], [0, 1, 1, 0], clamp),
    translate: `${interpolate(frame / fps, [0, .4, 2.1, 2.45], [35, 0, 0, -100], { ...clamp, easing: ease })}px 0`,
  }}><div className="launch-title">{children}</div></div>;
}

export function Launch() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const elapsed = frame / fps;
  // Cut the opening by 20 frames and the overview pause by 45 frames.
  const time = elapsed + (frame >= 115 ? 65 / 30 : 20 / 30);
  const themeScene = frame >= 865 && frame < 1030;
  const themeTime = (frame - 865) / fps;
  const themeId = !themeScene || themeTime < 1.8 || themeTime >= 4.05 ? 'codex' : themeTime < 2.55 ? 'chatgpt' : themeTime < 3.3 ? 'catppuccin' : 'dracula';
  const appearance = 'dark';
  // One camera and one board preserve spatial continuity across chapters.
  const times = [2, 6.7, 7.6, 11.7, 12.7, 15.7, 17.1, 18.2, 19, 20.9, 22.2, 25.8, 27, 28, 28.7, 29.2, 30, 31];
  const scales = [1.12, 1.12, 3, 3, 2.4, 2.4, 1.12, 1.12, 2.3, 2.3, 2.4, 2.4, 1.12, 1.12, 2.8, 2.8, 1.12, 1.12];
  const xs = [243, 243, -470, -470, -575, -575, 243, 243, -1157, -1157, -1325, -1325, 243, 243, 3, 3, 243, 243];
  const ys = [220, 220, 30, 30, 80, 80, 220, 220, -505, -505, 80, 80, 220, 220, 220, 220, 220, 220];
  const pose = (values: number[]) => interpolate(time, times, values, { ...clamp, easing: ease });
  const phase = time >= 23.8 ? 'merged' : time >= 14 ? 'review' : 'running';
  const move = phase === 'review' && time < 14.7 ? interpolate(time, [14, 14.7], [0, 1], { ...clamp, easing: ease })
    : phase === 'merged' && time < 24.5 ? interpolate(time, [23.8, 24.5], [0, 1], { ...clamp, easing: ease }) : undefined;
  const live = interpolate(time, [8.3, 10.7], [0, 1], clamp);
  const liveUsage = usage(Math.round(600_000 + live * 640_000), .4 + live * .46);
  const selected = time >= 28.6 && !themeScene;
  const filter = interpolate(time, [28.6, 29.2], [0, 1], { ...clamp, easing: ease });
  const fadeOther = interpolate(time, [28.25, 28.6], [1, 0], clamp);
  const detail = time >= 18.2 && time < 20.9;
  const usageRow = time < 19.9 ? 1 : 2;
  return <AbsoluteFill className="film opening-study launch-film" style={themeVariables(visualTheme('codex', 'dark'), 'dark') as CSSProperties}>
    <Audio name="Tech House vibes — Mixkit" src={staticFile('tech-house-vibes.mp3')} trimBefore={Math.round(1.52 * fps)} durationInFrames={1120} premountFor={fps}
      volume={interpolate(elapsed, [0, .1, 36.1, 1120 / fps], [0, .8, .8, 0], clamp)} />
    <div className="opening-halo" style={{ translate: `${Math.sin(time * .7) * 90}px ${Math.cos(time * .5) * 35}px` }} />
    {frame >= 40 && frame < 1030 && <div className="opening-brand"><Img src={staticFile('taskchef-dark.svg')} alt="" />TaskChef <span>Dashboard for Codex</span></div>}
    <Sequence name="Product identity" from={0} durationInFrames={40} premountFor={fps}>
      <div className="opening-type"><div className="opening-identity"><div><Img src={staticFile('taskchef-dark.svg')} alt="" /><span>TaskChef</span></div><p>Dashboard for Codex</p></div></div>
      <div className="opening-rails" style={{ rotate: '-12deg', translate: `${time * 180 - 220}px 0` }}><i /><i /><i /></div>
      <FloatingChats time={elapsed} heroUsage={usage(600_000, .4)} />
    </Sequence>
    {frame >= 40 && frame < 1030 && <div className="opening-board-mask">
      <div className="opening-board-stage" inert style={{ left: themeScene ? interpolate(themeTime, [0, 1.5, 2, 5, 5.5], [243, 243, -160, -160, 243], { ...clamp, easing: ease }) : pose(xs), top: (themeScene ? interpolate(themeTime, [0, 1.5, 2, 5, 5.5], [220, 220, 200, 200, 220], { ...clamp, easing: ease }) : pose(ys)) - 220, scale: themeScene ? interpolate(themeTime, [0, 1.5, 2, 5, 5.5], [1.12, 1.12, 1.6, 1.6, 1.12], { ...clamp, easing: ease }) : pose(scales) }}>
        <ProductBoard themeId={themeId} appearance={appearance} showThemePanel={themeScene} phase={phase} moveProgress={move} project={selected ? 'atlas' : ''} heroUsage={phase === 'running' ? liveUsage : undefined} filterProgress={selected ? filter : undefined} highlightProject={time >= 28 && time < 29.3}>
          <style>{`.launch-film .film-product .mantine-Modal-content { max-height: 505px; }
            .launch-film .taskchef-detail-usage tbody tr:nth-child(${usageRow}) { background: #8cc9ff20; }
            ${demoTasks('merged').filter(task => task.project.id !== 'atlas').map(task => `.launch-film [data-chat-id="${task.id}"] { opacity: ${!themeScene && time >= 28.25 ? fadeOther : 1}; }`).join('\n')}`}</style>
          {detail && <NextTaskDetail task={demoTasks('review')[0]} opened busy={false} error={null} onClose={noop} onOpenCodex={noop} />}
        </ProductBoard>
      </div>
    </div>}
    <Sequence name="Full board" from={40} durationInFrames={2.5 * fps} premountFor={fps}><ChapterTitle>Keep every project <span>in view.</span></ChapterTitle></Sequence>
    <Sequence name="Running and live usage" from={115} durationInFrames={2.5 * fps} premountFor={fps}><ChapterTitle>See what’s <span>running.</span></ChapterTitle></Sequence>
    <Sequence name="Finished chat moves to review" from={265} durationInFrames={2.5 * fps} premountFor={fps}><ChapterTitle>Ready for <span>your review.</span></ChapterTitle></Sequence>
    <Sequence name="Turn and chat usage" from={415} durationInFrames={2.5 * fps} premountFor={fps}><ChapterTitle>Usage, <span>turn by turn.</span></ChapterTitle></Sequence>
    <Sequence name="Merged PR moves to Done" from={565} durationInFrames={2.5 * fps} premountFor={fps}><ChapterTitle>Merged. <span>Done.</span></ChapterTitle></Sequence>
    <Sequence name="Project filtering" from={715} durationInFrames={2.5 * fps} premountFor={fps}><ChapterTitle>Focus on <span>one project.</span></ChapterTitle></Sequence>
    <Sequence name="Theme switching" from={865} durationInFrames={2.5 * fps} premountFor={fps}><ChapterTitle>Choose <span>your theme.</span></ChapterTitle></Sequence>
    <Sequence name="TaskChef closing" from={1030} durationInFrames={3 * fps} premountFor={fps}>
      <AbsoluteFill className="film film-closing"><div className="film-glow" /><div><Img src={staticFile('taskchef-dark.svg')} alt="" /><h1>TaskChef</h1><p>Dashboard for Codex</p><div className="film-url">taskchef.dev</div></div></AbsoluteFill>
    </Sequence>
  </AbsoluteFill>;
}
