import { Audio } from '@remotion/media';
import { AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import type { CSSProperties } from 'react';
import { ProductBoard } from './Frame';
import { themeVariables, visualTheme } from '../src/mcp-app/react/themes';

// Four-beat phrases from the chosen track; no change to the full film yet.
const phrase = 240 / 122;
const ease = Easing.bezier(.16, 1, .3, 1);
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

function FloatingChats({ time, shot }: { time: number; shot: number }) {
  return <div className="opening-floating-chats" inert>
    {[1, 2, 3].map((id, index) => <div key={id} className={`opening-fragment opening-fragment-${id}`} style={{
      top: 235 + index * 225,
      left: 1280 + (index === 1 ? 70 : 0),
      rotate: `${[-7, 5, -4][index] + Math.sin(time * 1.7 + index) * 1.5}deg`,
      translate: `${Math.sin(time * 1.2 + index) * 18 + (shot === 0 ? 30 : -25)}px ${Math.cos(time * 1.5 + index) * 12}px`,
      opacity: interpolate(time, [.15 + index * .12, .5 + index * .12], [0, 1], clamp),
    }}><ProductBoard phase="running" /></div>)}
  </div>;
}

export function OpeningStudy() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const time = frame / fps;
  const shot = time < phrase ? 0 : time < phrase * 2 ? 1 : 2;
  const local = frame - shot * phrase * fps;
  const boardStart = phrase * 2;
  // Title → full board → detail. At nine seconds, carry into the review chapter.
  const cameraTimes = [boardStart, 4.75, 6.05, 6.65, 7.5, 8.1, 8.85, 9.65, 10.1, 10.65, 11.8];
  const cameraEase = { ...clamp, easing: Easing.bezier(.65, 0, .2, 1) };
  const scale = interpolate(time, cameraTimes, [.62, 1.22, 1.22, 2.5, 2.5, 1.22, 1.22, .62, .62, 2.4, 2.4], cameraEase);
  const x = interpolate(time, cameraTimes, [1050, 179, 179, -766, -766, 179, 179, 1050, 1050, -575, -575], cameraEase);
  const y = interpolate(time, cameraTimes, [320, 240, 240, 80, 80, 240, 240, 320, 320, 80, 80], cameraEase);
  const review = time >= 10.65;
  const move = interpolate(time, [10.65, 11.25], [0, 1], { ...clamp, easing: ease });
  const nextTitle = time >= 8.85;
  const titleTime = time - (nextTitle ? 8.85 : boardStart);
  return <AbsoluteFill className="film opening-study" style={themeVariables(visualTheme('codex', 'dark'), 'dark') as CSSProperties}>
    <Audio
      name="Tech House vibes — Mixkit"
      src={staticFile('tech-house-vibes.mp3')}
      trimBefore={Math.round(1.52 * fps)}
      durationInFrames={Math.round(phrase * 6 * fps)}
      premountFor={fps}
      volume={interpolate(frame, [0, .1 * fps, 11.1 * fps, 11.8 * fps], [0, .8, .8, 0], clamp)}
    />
    <div className="opening-halo" style={{ translate: `${Math.sin(time * .7) * 90}px ${Math.cos(time * .5) * 35}px`, scale: 1 + Math.sin(time * .8) * .08 }} />
    {shot !== 0 && <div className="opening-brand"><Img src={staticFile('taskchef-dark.svg')} alt="" />TaskChef <span>Dashboard for Codex</span></div>}
    {shot < 2 && <>
      <div className="opening-type" key={shot} style={{ opacity: interpolate(local, [0, .12 * fps, (phrase - .12) * fps, phrase * fps], [0, 1, 1, 0], clamp),
        translate: `0 ${interpolate(local, [0, .45 * fps], [80, 0], { ...clamp, easing: ease })}px`,
        scale: interpolate(local, [0, phrase * fps], [1.06, 1], { ...clamp, easing: ease }) }}>
        {shot === 0 ? <div className="opening-identity"><div><Img src={staticFile('taskchef-dark.svg')} alt="" /><span>TaskChef</span></div><p>Dashboard for Codex</p></div> : <>Every project.<br /><span>In view.</span></>}
      </div>
      <div className="opening-rails" style={{ rotate: `${shot === 0 ? -12 : 12}deg`, translate: `${interpolate(local, [0, phrase * fps], [-240, 160], clamp)}px 0` }}><i /><i /><i /></div>
      <FloatingChats time={time} shot={shot} />
    </>}
    <div className="opening-board-mask" style={{ opacity: shot === 2 ? 1 : 0 }}>
      <div className="opening-board-stage" inert style={{ left: x, top: y, scale, rotate: `${interpolate(time, [boardStart, 4.75], [-4, 0], { ...clamp, easing: ease })}deg` }}>
        <ProductBoard phase={review ? 'review' : 'running'} moveProgress={review ? move : undefined} />
      </div>
    </div>
    {shot === 2 && <div className="opening-section-title" style={{ opacity: interpolate(titleTime, [0, .15, nextTitle ? 1.05 : .55, nextTitle ? 1.45 : 1], [0, 1, 1, 0], clamp),
      translate: `${interpolate(titleTime, [0, .4, nextTitle ? 1.05 : .55, nextTitle ? 1.45 : 1], [40, 0, 0, -110], { ...clamp, easing: ease })}px 0` }}>
      {nextTitle ? <>Ready for<br /><span>review.</span></> : <>See what’s<br /><span>running.</span></>}
    </div>}
  </AbsoluteFill>;
}
