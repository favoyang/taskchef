import type { CSSProperties, ReactNode } from 'react';
import { AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { ActionIcon, Group, MantineProvider, Select, SegmentedControl, TextInput, Title, createTheme } from '@mantine/core';
import { IconCheck, IconRefresh, IconSearch, IconSettings } from '@tabler/icons-react';
import { TaskBoard } from '../src/ui/components/TaskBoard';
import { turnUsageLabel } from '../src/ui/components/SavedUsageFormat';
import { RelativeTimeProvider } from '../src/ui/components/RelativeTime';
import { ProjectPicker } from '../src/mcp-app/react/ProjectPicker';
import { AppearancePicker } from '../src/mcp-app/react/AppearancePicker';
import { themeVariables, visualTheme, type Appearance } from '../src/mcp-app/react/themes';
const mark = staticFile('taskchef-dark.svg');
import { DEMO_NOW, HERO_ID, LANES, PROJECTS, demoTasks, usage, type Phase } from './demo';
import type { SavedUsage } from '../src/ui/types';

const theme = createTheme({ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', headings: { fontFamily: 'inherit' }, colors: { dark: ['#dcdcdc', '#cdcdcd', '#afafaf', '#808080', '#414141', '#353535', '#282828', '#212121', '#181818', '#131313'] },
  components: { Modal: { defaultProps: { withinPortal: false, lockScroll: false, transitionProps: { duration: 0 } } } } });
const palette = themeVariables(visualTheme('codex', 'dark'), 'dark');
const noop = () => {};
const loadDemoImage = async (_task: unknown, url?: string) => url ?? null;

// Frame-controlled presentation of the native appearance panel and its controls.
function FilmThemePanel({ themeId, appearance }: { themeId: string; appearance: Appearance }) {
  return <section className="next-appearance-panel" aria-label="Appearance settings">
    <h2>Appearance</h2>
    <SegmentedControl key={appearance} transitionDuration={0} fullWidth value={appearance} onChange={noop} data={[{ value: 'light', label: 'DAY' }, { value: 'dark', label: 'NIGHT' }, { value: 'system', label: 'SYSTEM' }]} size="xs" />
    <h3>Theme</h3><div className="next-theme-list" role="radiogroup" aria-label="Theme">
      {['chatgpt', 'catppuccin', 'dracula', 'codex'].map((id, index) => {
        const item = visualTheme(id, appearance);
        const colors = themeVariables(item, appearance);
        return <div key={id}>{index === 1 && <div className="next-theme-group">Codex themes</div>}
          <button className="next-appearance-theme" role="radio" aria-checked={id === themeId}>
            <span className="next-appearance-preview" style={{ background: colors['--taskchef-surface'], color: colors['--taskchef-link'], borderColor: colors['--taskchef-border-heavy'] }}>Aa</span>
            <span>{item.label}</span>{id === themeId && <IconCheck size={16} />}
          </button></div>;
      })}
    </div>
  </section>;
}

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

export function ProductBoard({ phase, project = '', moveProgress, children, highlightProject = false, heroUsage, filterProgress, themeId = 'codex', appearance = 'dark', showThemePanel = false }: { phase: Phase; project?: string; moveProgress?: number; children?: ReactNode; highlightProject?: boolean; heroUsage?: SavedUsage; filterProgress?: number; themeId?: string; appearance?: Appearance; showThemePanel?: boolean }) {
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
  return <div style={themeVariables(visualTheme(themeId, appearance), appearance) as CSSProperties} className={`film-product${highlightProject ? " film-product-highlight-project" : ""}`}>
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
    <MantineProvider theme={theme} forceColorScheme={appearance}>
      <RelativeTimeProvider now={DEMO_NOW}>
        <div className="taskchef-app-shell">
          <header className="taskchef-app-header">
            <Group className="taskchef-app-brand" gap="xs"><Img className="taskchef-app-mark" src={mark} alt="" /><Title order={1}>TaskChef</Title></Group>
            <Group className="taskchef-app-filters" gap="xs" wrap="nowrap">
              <ProjectPicker data={PROJECTS} value={project} onChange={noop} />
              <Select className="taskchef-app-date" aria-label="Updated" data={[{ label: "All time", value: "all" }]} value="all" onChange={noop} size="xs" /><TextInput className="taskchef-app-search" aria-label="Search Chats" placeholder="Search Chats" type="search" leftSection={<IconSearch size={14} />} value="" onChange={noop} size="xs" />
            </Group>
            <Group className="taskchef-app-actions" gap="xs"><div className="next-appearance"><AppearancePicker value={appearance} appearance={appearance} visualThemeId={themeId} onChange={noop} onVisualThemeChange={noop} />{showThemePanel && <FilmThemePanel themeId={themeId} appearance={appearance} />}</div><ActionIcon aria-label="Settings" variant="subtle"><IconSettings size={17} /></ActionIcon><ActionIcon aria-label="Refresh" variant="subtle"><IconRefresh size={17} /></ActionIcon></Group>
          </header>
          <main className="taskchef-app-main"><TaskBoard loadImage={loadDemoImage} tasks={tasks} lanes={LANES} completedLimit={5} groupInterruptedWithWaiting onMoreCompleted={noop} onOpenCodex={noop} onOpenDetail={noop} /></main>
        </div>
        {children}
      </RelativeTimeProvider>
    </MantineProvider>
  </div>;
}
