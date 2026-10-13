import { Sequence, useVideoConfig } from 'remotion';
import { Opening } from './Opening';
import { Review } from './Review';
import { Usage } from './Usage';
import { Merge } from './Merge';
import { Focus } from './Focus';
import { Closing } from './Closing';
export function Launch() {
  const { fps } = useVideoConfig();
  return <>
    <Sequence name="Parallel projects" from={0} durationInFrames={6 * fps} premountFor={fps}><Opening /></Sequence>
    <Sequence name="Running to review" from={6 * fps} durationInFrames={11 * fps} premountFor={fps}><Review /></Sequence>
    <Sequence name="Turn and chat usage" from={17 * fps} durationInFrames={10 * fps} premountFor={fps}><Usage /></Sequence>
    <Sequence name="PR merged to Done" from={27 * fps} durationInFrames={8 * fps} premountFor={fps}><Merge /></Sequence>
    <Sequence name="Project focus" from={35 * fps} durationInFrames={6 * fps} premountFor={fps}><Focus /></Sequence>
    <Sequence name="TaskChef" from={41 * fps} durationInFrames={4 * fps} premountFor={fps}><Closing /></Sequence>
  </>;
}
