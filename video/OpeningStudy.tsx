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
  const board = Math.max(0, time - boardStart);
  const focus = interpolate(board, [0, .75, phrase, phrase + .6, phrase * 2 - .2, phrase * 2 + .55, phrase * 4], [0, 0, 0, 1, 1, 0, 0], { ...clamp, easing: Easing.bezier(.65, 0, .2, 1) });
  const reveal = interpolate(board, [0, .75], [0, 1], { ...clamp, easing: ease });
  // Wide shot fits all four lanes and all nine cards. Close-up follows Running.
  const scale = 1.22 + focus * 1.28;
  const x = 179 - focus * 945;
  const y = 20 - focus * 160 + (1 - reveal) * 180;
  return <AbsoluteFill className="film opening-study" style={themeVariables(visualTheme('codex', 'dark'), 'dark') as CSSProperties}>
    <Audio name="Tech House vibes — Mixkit" src={staticFile('tech-house-vibes.mp3')} trimBefore={Math.round(1.52 * fps)} durationInFrames={Math.round(phrase * 6 * fps)} premountFor={fps}
      volume={interpolate(frame, [0, .1 * fps, 11.1 * fps, 11.8 * fps], [0, .8, .8, 0], clamp)} />
    <div className="opening-halo" style={{ translate: `${Math.sin(time * .7) * 90}px ${Math.cos(time * .5) * 35}px`, scale: 1 + Math.sin(time * .8) * .08 }} />
    <div className="opening-brand"><Img src={staticFile('taskchef-dark.svg')} alt="" />TaskChef <span>for Codex</span></div>
    {shot < 2 && <>
      <div className="opening-type" key={shot} style={{ opacity: interpolate(local, [0, .12 * fps, (phrase - .12) * fps, phrase * fps], [0, 1, 1, 0], clamp),
        translate: `0 ${interpolate(local, [0, .45 * fps], [80, 0], { ...clamp, easing: ease })}px`,
        scale: interpolate(local, [0, phrase * fps], [1.06, 1], { ...clamp, easing: ease }) }}>
        {shot === 0 ? <>More<br /><span>projects.</span></> : <>All<br /><span>moving.</span></>}
      </div>
      <div className="opening-projects" style={{ opacity: interpolate(local, [.1 * fps, .35 * fps], [0, 1], clamp), translate: `${interpolate(local, [0, phrase * fps], [60, -30], clamp)}px 0` }}>
        <span>Atlas</span><span>Beacon</span><span>Studio</span>
      </div>
      <div className="opening-rails" style={{ rotate: `${shot === 0 ? -12 : 12}deg`, translate: `${interpolate(local, [0, phrase * fps], [-240, 160], clamp)}px 0` }}><i /><i /><i /></div>
      <FloatingChats time={time} shot={shot} />
    </>}
    <div className="opening-board-mask" style={{ opacity: shot === 2 ? 1 : 0 }}>
      <div className="opening-board-stage" inert style={{ left: x, top: y, scale, rotate: `${(1 - reveal) * -5}deg`, opacity: reveal }}>
        <ProductBoard phase="running" />
      </div>
    </div>
    {shot === 2 && <div className="opening-board-title" style={{ opacity: interpolate(board, [0, .2], [0, 1], clamp), translate: `0 ${interpolate(board, [0, .6], [35, 0], { ...clamp, easing: ease })}px` }}>
      {time < phrase * 3 ? 'One clear view.' : time < phrase * 4 ? 'See what’s running.' : 'Keep your bearings.'}
    </div>}
  </AbsoluteFill>;
}
