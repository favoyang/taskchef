import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
const mark = staticFile('taskchef-dark.svg');
export function Closing() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return <AbsoluteFill className="film film-closing"><div className="film-glow" /><div style={{ opacity: interpolate(frame, [0, .6 * fps], [0, 1], { extrapolateRight: 'clamp' }) }}>
    <Img src={mark} alt="TaskChef" /><h1>TaskChef</h1><p>Keep parallel AI work in view.</p><div className="film-url">taskchef.dev</div>
  </div></AbsoluteFill>;
}
