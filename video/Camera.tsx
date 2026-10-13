import type { ReactNode } from 'react';
import { Easing, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';

type Pose = { at: number; x: number; y: number; scale: number };
export function BoardCamera({ poses, children }: { poses: Pose[]; children: ReactNode }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const times = poses.map(pose => pose.at * fps);
  const options = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(.4, 0, .2, 1) } as const;
  return <div className="film-camera-window">
    <div className="film-camera-stage" inert style={{
      left: interpolate(frame, times, poses.map(pose => pose.x), options),
      top: interpolate(frame, times, poses.map(pose => pose.y), options),
      transform: `scale(${interpolate(frame, times, poses.map(pose => pose.scale), options)})`,
    }}>{children}</div>
  </div>;
}
