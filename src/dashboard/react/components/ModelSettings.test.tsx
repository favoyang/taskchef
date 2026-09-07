import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ModelSettings } from './ModelSettings';

const apiMocks = vi.hoisted(() => ({ updateModelRole: vi.fn() }));
vi.mock('../api', () => apiMocks);

vi.mock('@mantine/core', async () => {
  const { createElement } = await import('react');
  const block = ({ children }: { children?: import('react').ReactNode }) => createElement('div', null, children);
  return {
    MantineProvider: block, Tooltip: block, Badge: block, Group: block, Paper: block, SimpleGrid: block, Stack: block, Text: block, Title: block,
    Select: ({ 'aria-busy': busy, 'aria-label': label, data = [], disabled, onChange, readOnly, value }: { 'aria-busy'?: boolean; 'aria-label': string; data?: Array<string | { value: string; label: string }>; disabled?: boolean; onChange: (value: string | null) => void; readOnly?: boolean; value: string | null }) => createElement('select', { 'aria-busy': busy, 'aria-label': label, disabled, 'aria-readonly': readOnly, value: value ?? '', onChange: (event: { currentTarget: { value: string } }) => onChange(event.currentTarget.value) }, [createElement('option', { key: '', value: '' }), ...data.map((item) => typeof item === 'string' ? createElement('option', { key: item, value: item }, item) : createElement('option', { key: item.value, value: item.value }, item.label))]),
    Alert: ({ children }: { children?: import('react').ReactNode }) => createElement('div', { role: 'alert' }, children),
    ActionIcon: ({ children, loading, onClick, 'aria-label': label, ...props }: { children?: import('react').ReactNode; loading?: boolean; onClick: () => void; 'aria-label': string; className?: string }) => createElement('button', { ...props, disabled: loading, onClick, 'aria-label': label }, children),
  };
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

test('shows the version reported by the active usage provider', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      profiles: [],
      usageProvider: { provider: 'ccusage', status: 'available', version: '20.0.21' },
    }),
  }));
  render(<MantineProvider><ModelSettings /></MantineProvider>);
  expect(await screen.findByText('ccusage 20.0.21')).toBeInTheDocument();
  expect(screen.getByText('Usage provider')).toBeInTheDocument();
  expect(screen.getByText(/Version reported by the executable/)).toBeInTheDocument();
});

test('refresh shows configuration failures and does not label them honored', async () => {
  const role = { role: 'reviewer', source: '/fixture/reviewer.toml', effectiveSource: '/fixture/reviewer.toml', model: 'fixture', effort: 'low', status: 'configured', availability: 'not checked', fallback: 'inherit parent settings', problems: [] as string[] };
  const profile = { id: 'personal', project: 'Personal', roles: [role], problems: [], catalogSource: null };
  const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ profiles: [profile] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ profiles: [{ ...profile, roles: [{ ...role, status: 'invalid', problems: ['Unsupported effort'] }] }] }) });
  vi.stubGlobal('fetch', fetchMock);
  render(<MantineProvider><ModelSettings /></MantineProvider>);
  expect(await screen.findByText('configured')).toBeInTheDocument();
  const refresh = screen.getByRole('button', { name: 'Refresh' });
  expect(refresh).toHaveClass('taskchef-icon-button');
  await waitFor(() => expect(refresh).toBeEnabled());
  await act(async () => { fireEvent.click(refresh); });
  expect(await screen.findByText('Unsupported effort')).toBeInTheDocument();
  expect(screen.queryByText(/Requested effective settings/)).not.toBeInTheDocument();
});

test('request failure remains visible and can be retried', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true, json: async () => ({ profiles: [] }) }));
  render(<MantineProvider><ModelSettings /></MantineProvider>);
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
  const refresh = screen.getByRole('button', { name: 'Refresh' });
  await waitFor(() => expect(refresh).toBeEnabled());
  await act(async () => { fireEvent.click(refresh); });
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
});


test('non-string TOML values show diagnostics without crashing settings', async () => {
  const role = { role: 'reviewer', source: '/fixture/reviewer.toml', model: { slug: 'bad' }, effort: ['bad'], status: 'invalid', availability: 'not checked', fallback: 'inherit parent settings', problems: ['model must be a nonempty string'] };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ profiles: [{ id: 'personal', project: 'Personal', roles: [role], problems: [], catalogSource: null }] }) }));
  render(<MantineProvider><ModelSettings /></MantineProvider>);
  expect(await screen.findByText('model must be a nonempty string')).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'reviewer model' })).toHaveValue('');
  expect(screen.getByRole('combobox', { name: 'reviewer reasoning effort' })).toBeDisabled();
});

test('saves dropdown changes and displays a home-relative agent source', async () => {
  const role = { role: 'planner', source: '/Users/example/.codex/agents/planner.toml', displaySource: '~/.codex/agents/planner.toml', model: 'gpt-one', effort: 'low', status: 'configured', problems: [] as string[] };
  const profile = { id: 'personal', roles: [role], problems: [], modelOptions: [
    { value: 'gpt-one', label: 'GPT One', efforts: ['low', 'high'] },
    { value: 'gpt-two', label: 'GPT Two', efforts: ['medium'] },
  ] };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ profiles: [profile] }) }));
  apiMocks.updateModelRole.mockResolvedValue({ profile: { ...profile, roles: [{ ...role, model: 'gpt-two', effort: 'medium' }] } });
  render(<MantineProvider><ModelSettings /></MantineProvider>);
  const model = await screen.findByRole('combobox', { name: 'planner model' });
  fireEvent.change(model, { target: { value: 'gpt-two' } });
  expect(model).toHaveValue('gpt-two');
  expect(model).toHaveAttribute('aria-readonly', 'true');
  expect(screen.queryByText('Saving…')).not.toBeInTheDocument();
  await waitFor(() => expect(apiMocks.updateModelRole).toHaveBeenCalledWith('planner', 'gpt-two', 'medium'));
  expect(await screen.findByText('Source: ~/.codex/agents/planner.toml')).toBeInTheDocument();
});

test('serializes role saves so an older response cannot replace a newer selection', async () => {
  const planner = { role: 'planner', source: null, model: 'gpt-one', effort: 'low', status: 'configured', problems: [] as string[] };
  const reviewer = { ...planner, role: 'reviewer' };
  const profile = { id: 'personal', roles: [planner, reviewer], problems: [], modelOptions: [
    { value: 'gpt-one', label: 'GPT One', efforts: ['low'] },
    { value: 'gpt-two', label: 'GPT Two', efforts: ['medium'] },
  ] };
  let resolveFirst!: (value: { profile: typeof profile }) => void;
  apiMocks.updateModelRole.mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ profiles: [profile] }) }));
  render(<MantineProvider><ModelSettings /></MantineProvider>);
  const plannerModel = await screen.findByRole('combobox', { name: 'planner model' });
  const reviewerModel = screen.getByRole('combobox', { name: 'reviewer model' });
  fireEvent.change(plannerModel, { target: { value: 'gpt-two' } });
  fireEvent.change(reviewerModel, { target: { value: 'gpt-two' } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(apiMocks.updateModelRole).toHaveBeenCalledTimes(1);
  expect(apiMocks.updateModelRole).toHaveBeenCalledWith('planner', 'gpt-two', 'medium');
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => resolveFirst({ profile: { ...profile, roles: [{ ...planner, model: 'gpt-two', effort: 'medium' }, reviewer] } }));
  await waitFor(() => expect(reviewerModel).toHaveAttribute('aria-readonly', 'false'));
  apiMocks.updateModelRole.mockResolvedValueOnce({ profile: { ...profile, roles: [{ ...planner, model: 'gpt-two', effort: 'medium' }, { ...reviewer, model: 'gpt-two', effort: 'medium' }] } });
  fireEvent.change(reviewerModel, { target: { value: 'gpt-two' } });
  await waitFor(() => expect(apiMocks.updateModelRole).toHaveBeenCalledTimes(2));
});
