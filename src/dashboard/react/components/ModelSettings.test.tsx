import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ModelSettings } from './ModelSettings';

vi.mock('@mantine/core', async () => {
  const { createElement } = await import('react');
  const block = ({ children }: { children?: import('react').ReactNode }) => createElement('div', null, children);
  return {
    MantineProvider: block, Badge: block, Group: block, Paper: block, Stack: block, Text: block, Title: block,
    Select: () => null,
    Alert: ({ children }: { children?: import('react').ReactNode }) => createElement('div', { role: 'alert' }, children),
    Button: ({ children, loading, onClick }: { children?: import('react').ReactNode; loading: boolean; onClick: () => void }) => createElement('button', { disabled: loading, onClick }, children),
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
  const refresh = screen.getByText('Refresh').closest('button')!;
  await waitFor(() => expect(refresh).toBeEnabled());
  await act(async () => { fireEvent.click(refresh); });
  expect(await screen.findByText('Unsupported effort')).toBeInTheDocument();
  expect(screen.queryByText(/Requested effective settings/)).not.toBeInTheDocument();
});

test('request failure remains visible and can be retried', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true, json: async () => ({ profiles: [] }) }));
  render(<MantineProvider><ModelSettings /></MantineProvider>);
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
  const refresh = screen.getByText('Refresh').closest('button')!;
  await waitFor(() => expect(refresh).toBeEnabled());
  await act(async () => { fireEvent.click(refresh); });
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
});


test('non-string TOML values show diagnostics without crashing settings', async () => {
  const role = { role: 'reviewer', source: '/fixture/reviewer.toml', model: { slug: 'bad' }, effort: ['bad'], status: 'invalid', availability: 'not checked', fallback: 'inherit parent settings', problems: ['model must be a nonempty string'] };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ profiles: [{ id: 'personal', project: 'Personal', roles: [role], problems: [], catalogSource: null }] }) }));
  render(<MantineProvider><ModelSettings /></MantineProvider>);
  expect(await screen.findByText(/Invalid model value/)).toBeInTheDocument();
  expect(screen.getByText(/Invalid effort value/)).toBeInTheDocument();
  expect(screen.getByText('model must be a nonempty string')).toBeInTheDocument();
});
