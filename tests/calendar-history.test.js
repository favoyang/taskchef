import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarSegments } from '../src/calendar-history.js';
const turn = (start, duration = 60000, status = 'completed', id = start) => ({ started_at: Date.parse(start) / 1000, duration_ms: duration, status, turn_id: id });
const options = { month: '2026-10', timeZone: 'UTC', now: Date.parse('2026-11-01T12:00:00Z') };
test('one full idle day splits a chat; adjacent workdays merge; weekends have no exception', () => {
  const turns = ['2026-10-05', '2026-10-06', '2026-10-26', '2026-10-27'].map(day => turn(`${day}T10:00:00Z`));
  assert.deepEqual(calendarSegments(turns, options).segments, [
    { start: '2026-10-05', end: '2026-10-06', resumed: false }, { start: '2026-10-26', end: '2026-10-27', resumed: true }]);
  assert.equal(calendarSegments([turn('2026-10-09T10:00:00Z'), turn('2026-10-12T10:00:00Z')], options).segments.length, 2);
  assert.equal(calendarSegments([turn('2026-10-05T10:00:00Z'), turn('2026-10-07T10:00:00Z')], options).segments.length, 2);
});
test('intervals cross midnight, but an exact midnight end does not occupy another day', () => {
  assert.deepEqual(calendarSegments([turn('2026-10-05T23:00:00Z', 3600000)], options).segments, [{ start: '2026-10-05', end: '2026-10-05', resumed: false }]);
  assert.equal(calendarSegments([turn('2026-10-05T23:00:00Z', 3600001)], options).segments[0].end, '2026-10-06');
});
test('resumed flag survives month boundaries and overlapping turns do not duplicate bars', () => {
  const turns = [turn('2026-09-01T10:00:00Z'), turn('2026-10-05T10:00:00Z'), turn('2026-10-05T10:01:00Z')];
  assert.deepEqual(calendarSegments(turns, options).segments, [{ start: '2026-10-05', end: '2026-10-05', resumed: true }]);
});
test('running work extends to now; a finished chat does not extend through review waits', () => {
  const now = Date.parse('2026-10-08T10:00:00Z');
  assert.equal(calendarSegments([turn('2026-10-05T10:00:00Z', null, 'inProgress', 'run')], { ...options, now, latestTurnId: 'run' }).segments[0].end, '2026-10-08');
  assert.equal(calendarSegments([turn('2026-10-05T10:00:00Z')], { ...options, now }).segments[0].end, '2026-10-05');
});
test('local calendar days, including DST changes, determine adjacency', () => {
  const result = calendarSegments([turn('2026-11-01T03:30:00Z'), turn('2026-11-02T04:30:00Z')], { ...options, month: '2026-11', timeZone: 'America/New_York', now: Date.parse('2026-11-04T00:00:00Z') });
  assert.deepEqual(result.segments, [{ start: '2026-10-31', end: '2026-11-01', resumed: false }]);
});
test('missing dates are reported and missing durations show only the known start day', () => {
  const result = calendarSegments([{ started_at: null }, turn('2026-10-05T10:00:00Z', null)], options);
  assert.equal(result.incomplete, true);
  assert.deepEqual(result.segments, [{ start: '2026-10-05', end: '2026-10-05', resumed: false }]);
});
