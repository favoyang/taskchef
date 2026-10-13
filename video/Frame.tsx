import type { CSSProperties, ReactNode } from 'react';
import { AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { ActionIcon, Group, MantineProvider, Select, TextInput, Title, createTheme } from '@mantine/core';
import { IconRefresh, IconSearch, IconSettings } from '@tabler/icons-react';
import { TaskBoard } from '../src/ui/components/TaskBoard';
import { turnUsageLabel } from '../src/ui/components/SavedUsageFormat';
import { RelativeTimeProvider } from '../src/ui/components/RelativeTime';
import { ProjectPicker } from '../src/mcp-app/react/ProjectPicker';
import { themeVariables, visualTheme } from '../src/mcp-app/react/themes';
const mark = staticFile('taskchef-dark.svg');
import { DEMO_NOW, HERO_ID, LANES, PROJECTS, demoTasks, usage, type Phase } from './demo';
import type { SavedUsage } from '../src/ui/types';

const theme = createTheme({ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', headings: { fontFamily: 'inherit' }, colors: { dark: ['#dcdcdc', '#cdcdcd', '#afafaf', '#808080', '#414141', '#353535', '#282828', '#212121', '#181818', '#131313'] },
  components: { Modal: { defaultProps: { withinPortal: false, lockScroll: false, transitionProps: { duration: 0 } } } } });
const palette = themeVariables(visualTheme('codex', 'dark'), 'dark');
const noop = () => {};

export function FilmFrame({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const fade = interpolate(frame, [0, .5 * fps], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return <AbsoluteFill className="film" style={palette as CSSProperties}>
    <div className="film-glow" />
    <div className="film-heading" style={{ opacity: fade, translate: `0 ${interpolate(frame, [0, .6 * fps], [14, 0], { extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) })}px` }}>
      <div className="film-eyebrow">{eyebrow}</div><h1>{title}</h1>
    </div>
    {children}
    <div className="film-signature"><Img src={mark} alt="" /> TaskChef <span>for Codex</span></div>
  </AbsoluteFill>;
}

export function ProductBoard({ phase, project = '', moveProgress, children, highlightProject = false, heroUsage, filterProgress }: { phase: Phase; project?: string; moveProgress?: number; children?: ReactNode; highlightProject?: boolean; heroUsage?: SavedUsage; filterProgress?: number }) {
  const frame = useCurrentFrame();
  const tasks = demoTasks(phase, project);
  if (heroUsage) {
    const hero = tasks.find(task => task.id === HERO_ID);
    if (hero) {
      hero.turnUsage = heroUsage;
      if (hero.sessionUsage) hero.sessionUsage = { ...hero.sessionUsage, latest: heroUsage, total: usage(4_080_000 + heroUsage.tokens.total_tokens, 2.86 + heroUsage.costUsd) };
    }
  }
  // Fix wall-clock labels and suppress the product's real-time FLIP animation.
  // The same destination card moves by a frame-driven transform in this film.
  const transform = moveProgress == null ? 'none' : `translate(${-312 * (1 - moveProgress)}px, ${-10 * Math.sin(Math.PI * moveProgress)}px)`;
  return <div className={`film-product${highlightProject ? " film-product-highlight-project" : ""}`}>
    <style>{`
      .film-product .taskchef-board-card { transform: none !important; }
      .film-product [data-chat-id="${HERO_ID}"] { transform: ${transform} !important; position: relative; z-index: 5; ${moveProgress != null && moveProgress < 1 ? 'box-shadow: 0 16px 35px #0008; border-color: #75b8ff;' : ''} }
      ${filterProgress == null ? '' : `.film-product [data-chat-id="00000000-0000-7000-8000-000000000003"] { transform: translateY(${176 * (1 - filterProgress)}px) !important; }`}
      ${moveProgress == null ? '' : tasks.filter(task => task.id !== HERO_ID).map(task => {
        const offset = phase === 'review'
          ? task.status === 'working' ? 176 : task.status === 'needs_input' ? -176 : 0
          : task.status === 'needs_input' ? 176 : task.status === 'completed' ? -176 : 0;
        return `.film-product [data-chat-id="${task.id}"] { transform: translateY(${offset * (1 - moveProgress)}px) !important; }`;
      }).join('\n')}
      .film-product [aria-label^="Elapsed time"] .taskchef-time-label { font-size: 0; }
      .film-product [aria-label^="Elapsed time"] .taskchef-time-label::after { content: "4m"; font-size: 12px; }
      ${tasks.filter(task => task.status === 'working').map(task => `.film-product [data-chat-id="${task.id}"] .taskchef-card-turn-usage { font-size: 0; } .film-product [data-chat-id="${task.id}"] .taskchef-card-turn-usage::after { content: ${JSON.stringify(turnUsageLabel(task.turnUsage!))}; font-size: 12px; }`).join('\n')}
      .film-product .taskchef-running-spinner { animation: none; transform: rotate(${frame * 8}deg); }
    `}</style>
    <MantineProvider theme={theme} forceColorScheme="dark">
      <RelativeTimeProvider now={DEMO_NOW}>
        <div className="taskchef-app-shell">
          <header className="taskchef-app-header">
            <Group className="taskchef-app-brand" gap="xs"><Img className="taskchef-app-mark" src={mark} alt="" /><Title order={1}>TaskChef</Title></Group>
            <Group className="taskchef-app-filters" gap="xs" wrap="nowrap">
              <ProjectPicker data={PROJECTS} value={project} onChange={noop} />
              <Select className="taskchef-app-date" aria-label="Updated" data={[{ label: "All time", value: "all" }]} value="all" onChange={noop} size="xs" /><TextInput className="taskchef-app-search" aria-label="Search Chats" placeholder="Search Chats" type="search" leftSection={<IconSearch size={14} />} value="" onChange={noop} size="xs" />
            </Group>
            <Group className="taskchef-app-actions" gap="xs"><ActionIcon aria-label="Settings" variant="subtle"><IconSettings size={17} /></ActionIcon><ActionIcon aria-label="Refresh" variant="subtle"><IconRefresh size={17} /></ActionIcon></Group>
          </header>
          <main className="taskchef-app-main"><TaskBoard tasks={tasks} lanes={LANES} completedLimit={5} groupInterruptedWithWaiting onMoreCompleted={noop} onOpenCodex={noop} onOpenDetail={noop} /></main>
        </div>
        {children}
      </RelativeTimeProvider>
    </MantineProvider>
  </div>;
}
