import { Audio } from '@remotion/media';
import { AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import type { CSSProperties } from 'react';
import { ProductBoard } from './Frame';
import { themeVariables, visualTheme } from '../src/mcp-app/react/themes';

// Four-beat phrases from the chosen track; no change to the full film yet.
const phrase = 240 / 122;
const ease = Easing.bezier(.16, 1, .3, 1);
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

function FloatingChats({ time }: { time: number }) {
  return <div className="opening-floating-chats" inert>
    {[1, 2, 3].map((id, index) => <div key={id} className={`opening-fragment opening-fragment-${id}`} style={{
      top: 235 + index * 225,
      left: 1280 + (index === 1 ? 70 : 0),
      rotate: `${[-7, 5, -4][index] + Math.sin(time * 1.7 + index) * 1.5}deg`,
      translate: `${Math.sin(time * 1.2 + index) * 18 + 30}px ${Math.cos(time * 1.5 + index) * 12}px`,
      opacity: 1,
    }}><ProductBoard phase="running" /></div>)}
  </div>;
}

export function OpeningStudy() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const time = frame / fps;
  const intro = time < phrase;
  const boardStart = phrase;
  // Title → full board → Running, then one continuous pull-back into Review.
  const cameraTimes = [boardStart, 4, 4.75, 5.5, 6.05, 6.7, 7.7, 9.4, 10.1, 11.2];
  const cameraEase = { ...clamp, easing: Easing.bezier(.65, 0, .2, 1) };
  const scale = interpolate(time, cameraTimes, [.62, .62, 1.22, 1.22, 3, 3, .62, .62, 2.4, 2.4], cameraEase);
  const x = interpolate(time, cameraTimes, [1050, 1050, 179, 179, -470, -470, 1050, 1050, -575, -575], cameraEase);
  const y = interpolate(time, cameraTimes, [320, 320, 240, 240, 30, 30, 320, 320, 80, 80], cameraEase);
  const review = time >= 10.1;
  const move = interpolate(time, [10.1, 10.7], [0, 1], { ...clamp, easing: ease });
  const nextTitle = time >= 7.45;
  const titleTime = time - (nextTitle ? 7.45 : boardStart);
  return <AbsoluteFill
    className="film opening-study"
    style={themeVariables(visualTheme('codex', 'dark'), 'dark') as CSSProperties}
  >
    <Audio
      name="Tech House vibes — Mixkit"
      src={staticFile('tech-house-vibes.mp3')}
      trimBefore={Math.round(1.52 * fps)}
      durationInFrames={Math.round(11.2 * fps)}
      premountFor={fps}
      volume={interpolate(frame, [0, .1 * fps, 10.5 * fps, 11.2 * fps], [0, .8, .8, 0], clamp)}
    />
    <div className="opening-halo" style={{ translate: `${Math.sin(time * .7) * 90}px ${Math.cos(time * .5) * 35}px`, scale: 1 + Math.sin(time * .8) * .08 }} />
    {!intro && <div className="opening-brand"><Img src={staticFile('taskchef-dark.svg')} alt="" />TaskChef <span>Dashboard for Codex</span></div>}
    {intro && <>
      <div className="opening-type" style={{ opacity: interpolate(time, [phrase - .15, phrase], [1, 0], clamp) }}>
        <div className="opening-identity"><div><Img src={staticFile('taskchef-dark.svg')} alt="" /><span>TaskChef</span></div><p>Dashboard for Codex</p></div>
      </div>
      <div className="opening-rails" style={{ rotate: '-12deg', translate: `${interpolate(time, [0, phrase], [-240, 160], clamp)}px 0` }}><i /><i /><i /></div>
      <FloatingChats time={time} />
    </>}
    <div className="opening-board-mask" style={{ opacity: !intro ? 1 : 0 }}>
      <div className="opening-board-stage" inert style={{ left: x, top: y - 220, scale, rotate: `${interpolate(time, [4, 4.75], [-4, 0], { ...clamp, easing: ease })}deg` }}>
        <ProductBoard phase={review ? 'review' : 'running'} moveProgress={review ? move : undefined} />
      </div>
    </div>
    {!intro && <div className="opening-section-title" style={{ opacity: interpolate(titleTime, [0, .15, nextTitle ? 1.95 : 2.03, nextTitle ? 2.3 : 2.4], [0, 1, 1, 0], clamp),
      translate: `${interpolate(titleTime, [0, .4, nextTitle ? 1.95 : 2.03, nextTitle ? 2.3 : 2.4], [40, 0, 0, -110], { ...clamp, easing: ease })}px 0` }}>
      {nextTitle ? <>Ready for<br /><span>review.</span></> : <>Keep every<br />project<br /><span>in view.</span></>}
    </div>}
  </AbsoluteFill>;
}
