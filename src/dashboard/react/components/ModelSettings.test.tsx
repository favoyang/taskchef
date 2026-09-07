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
    Select: ({ 'aria-label': label, data = [], disabled, onChange, value }: { 'aria-label': string; data?: Array<string | { value: string; label: string }>; disabled?: boolean; onChange: (value: string | null) => void; value: string | null }) => createElement('select', { 'aria-label': label, disabled, value: value ?? '', onChange: (event: { currentTarget: { value: string } }) => onChange(event.currentTarget.value) }, [createElement('option', { key: '', value: '' }), ...data.map((item) => typeof item === 'string' ? createElement('option', { key: item, value: item }, item) : createElement('option', { key: item.value, value: item.value }, item.label))]),
    Alert: ({ children }: { children?: import('react').ReactNode }) => createElement('div', { role: 'alert' }, children),
    ActionIcon: ({ children, loading, onClick, 'aria-label': label }: { children?: import('react').ReactNode; loading: boolean; onClick: () => void; 'aria-label': string }) => createElement('button', { disabled: loading, onClick, 'aria-label': label }, children),
  };
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('refresh shows configuration failures and does not label them honored', async () => {
  const role = { role: 'reviewer', source: '/fixture/reviewer.toml', effectiveSource: '/fixture/reviewer.toml', model: 'fixture', effort: 'low', status: 'configured', availability: 'not checked', fallback: 'inherit parent settings', problems: [] as string[] };
  const profile = { id: 'personal', project: 'Personal', roles: [role], problems: [], catalogSource: null };
  const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ profiles: [profile] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ profiles: [{ ...profile, roles: [{ ...role, status: 'invalid', problems: ['Unsupported effort'] }] }] }) });
  vi.stubGlobal('fetch', fetchMock);
  render(<MantineProvider><ModelSettings /></MantineProvider>);
  expect(await screen.findByText('configured')).toBeInTheDocument();
  const refresh = screen.getByRole('button', { name: 'Refresh' });
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
  await waitFor(() => expect(apiMocks.updateModelRole).toHaveBeenCalledWith('planner', 'gpt-two', 'medium'));
  expect(await screen.findByText('Source: ~/.codex/agents/planner.toml')).toBeInTheDocument();
});
