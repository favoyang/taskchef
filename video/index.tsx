import { Composition, Folder, registerRoot } from 'remotion';
import { themeVariables, visualTheme } from '../src/mcp-app/react/themes';
import { Launch } from './Launch';
import { Opening } from './Opening';
import { Review } from './Review';
import { Usage } from './Usage';
import { Merge } from './Merge';
import { Focus } from './Focus';
import { Closing } from './Closing';
import { OpeningStudy } from './OpeningStudy';
import '@mantine/core/styles.css';
import '../src/ui/styles.css';
import '../src/mcp-app/react/styles.css';
import './film.css';
// Match the native app's palette setup so its theme selectors also apply.
document.documentElement.dataset.taskchefTheme = 'dark';
document.documentElement.dataset.taskchefPalette = 'codex';
for (const [key, value] of Object.entries(themeVariables(visualTheme('codex', 'dark'), 'dark'))) {
  document.documentElement.style.setProperty(key, value);
}

registerRoot(() => <>
  <Composition id="TaskChefLaunch" component={Launch} durationInFrames={1090} fps={30} width={1920} height={1080} />
  <Folder name="Drafts">
    <Composition id="TaskChefOpening" component={OpeningStudy} durationInFrames={336} fps={30} width={1920} height={1080} />
    <Composition id="ParallelProjects" component={Opening} durationInFrames={180} fps={30} width={1920} height={1080} />
    <Composition id="RunningToReview" component={Review} durationInFrames={330} fps={30} width={1920} height={1080} />
    <Composition id="TurnAndChatUsage" component={Usage} durationInFrames={300} fps={30} width={1920} height={1080} />
    <Composition id="MergedToDone" component={Merge} durationInFrames={240} fps={30} width={1920} height={1080} />
    <Composition id="ProjectFocus" component={Focus} durationInFrames={180} fps={30} width={1920} height={1080} />
    <Composition id="Closing" component={Closing} durationInFrames={120} fps={30} width={1920} height={1080} />
  </Folder>
</>);
