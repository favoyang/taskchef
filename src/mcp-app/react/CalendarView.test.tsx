import { afterEach, expect, test, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CalendarView, type CalendarData } from "./CalendarView";
import type { Task } from "../../ui/types";
afterEach(() => { cleanup(); vi.useRealTimers(); });
const month = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const task = (id: string): Task => ({ id, title: `Chat ${id}`, project: { id: 'project', name: 'Project', path: '/repo', githubRepos: [] }, status: 'needs_input', instruction: '', createdAt: '', updatedAt: '', summary: '', threadId: null, turnRef: null, turnId: null, lastResult: null, latestTurn: null });
function data(count = 1): CalendarData { return { month: month(), timeZone: 'UTC', chats: Array.from({ length: count }, (_, i) => ({ id: String(i), incomplete: false, segments: [{ start: `${month()}-05`, end: `${month()}-05`, resumed: false }, { start: `${month()}-26`, end: `${month()}-26`, resumed: true }] })) }; }
test('paused and resumed segments open the same chat; navigation has no Today control', async () => {
  const onOpenDetail = vi.fn(), request = vi.fn(async () => data());
  render(<CalendarView request={request} tasks={[task('0')]} refreshKey="1" onOpenDetail={onOpenDetail} />);
  const bars = await screen.findAllByRole('button', { name: /Project · Chat 0/ });
  expect(bars).toHaveLength(2);
  expect(bars[1]).toHaveTextContent('↩');
  fireEvent.click(bars[0]); fireEvent.click(bars[1]);
  expect(onOpenDetail).toHaveBeenNthCalledWith(1, task('0'));
  expect(onOpenDetail).toHaveBeenNthCalledWith(2, task('0'));
  expect(screen.queryByRole('button', { name: 'Today' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Next month' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
  expect(request).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(request.mock.calls[1]).not.toEqual(request.mock.calls[0]);
  expect(screen.getByRole('button', { name: 'Next month' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  expect(request.mock.calls[2]).toEqual(request.mock.calls[0]);
  expect(screen.getByRole('button', { name: 'Next month' })).toBeDisabled();
});
test('crowded weeks expand and filters remove nonmatching chats', async () => {
  const props = { request: vi.fn(async () => data(5)), tasks: Array.from({ length: 5 }, (_, i) => task(String(i))), refreshKey: '1', onOpenDetail: vi.fn() };
  const { rerender } = render(<CalendarView {...props} />);
  const more = await screen.findAllByRole('button', { name: /more this week/ });
  fireEvent.click(more[0]);
  expect(screen.getByRole('button', { name: 'Show fewer' })).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: /Project · Chat 4/ }).length).toBeGreaterThan(0);
  rerender(<CalendarView {...props} tasks={[]} />);
  expect(screen.queryByRole('button', { name: /Project · Chat/ })).not.toBeInTheDocument();
  expect(screen.getByText(/No recorded work matches/)).toBeInTheDocument();
});
test('failed requests show retry without adding a missing-history notice', async () => {
  const result = data(); result.chats[0].incomplete = true;
  const request = vi.fn().mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValue(result);
  render(<CalendarView request={request} tasks={[task('0')]} refreshKey="1" onOpenDetail={vi.fn()} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findAllByRole('button', { name: /Project · Chat 0/ })).toHaveLength(2);
  expect(screen.queryByText(/Some turn dates or durations are missing/)).not.toBeInTheDocument();
});

test('a selected project hides bar prefixes and persistent helper captions are absent', async () => {
  render(<CalendarView request={async () => data()} tasks={[task('0')]} refreshKey="1" showProject={false} onOpenDetail={vi.fn()} />);
  expect(await screen.findByRole('button', { name: 'Chat 0' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '↩ Chat 0' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Project ·/ })).not.toBeInTheDocument();
  expect(screen.queryByText(/Recorded work ·|Selected Codex history only/)).not.toBeInTheDocument();
});

test('hover highlights a chat across continued and resumed weeks, and clears on leave', async () => {
  const result = data(2);
  result.chats[0].segments[0].end = `${month()}-19`;
  render(<CalendarView request={async () => result} tasks={[task('0'), task('1')]} refreshKey="1" onOpenDetail={vi.fn()} />);
  const bars = await screen.findAllByRole('button', { name: /Project · Chat 0/ });
  const otherBars = screen.getAllByRole('button', { name: /Project · Chat 1/ });
  expect(bars.length).toBeGreaterThan(3);
  for (const bar of [bars[0], bars[bars.length - 1]]) {
    fireEvent.mouseEnter(bar);
    for (const segment of bars) expect(segment).toHaveClass('calendar-bar-highlighted');
    for (const segment of otherBars) expect(segment).not.toHaveClass('calendar-bar-highlighted');
    fireEvent.mouseLeave(bar);
    for (const segment of bars) expect(segment).not.toHaveClass('calendar-bar-highlighted');
  }
  fireEvent.mouseEnter(otherBars[0]);
  for (const segment of otherBars) expect(segment).toHaveClass('calendar-bar-highlighted');
  for (const segment of bars) expect(segment).not.toHaveClass('calendar-bar-highlighted');
});
