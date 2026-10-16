// Date-only arithmetic uses UTC; recorded instants are first converted to the
// viewer's timezone. This keeps full idle days consistent across DST changes.
const nextDay = date => new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
export function calendarSegments(turns, { month, timeZone, now = Date.now(), latestTurnId }) {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const day = time => {
    const parts = Object.fromEntries(format.formatToParts(time).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  let incomplete = false;
  const intervals = [];
  for (const turn of turns) {
    const start = turn.started_at * 1000;
    if (!Number.isFinite(start) || turn.started_at == null || start <= 0 || start > now) { incomplete = true; continue; }
    const running = turn.status === 'inProgress' && turn.turn_id === latestTurnId;
    const hasDuration = Number.isFinite(turn.duration_ms) && turn.duration_ms >= 0;
    if (!running && !hasDuration) incomplete = true;
    const end = running ? now : Math.min(now, start + (hasDuration ? turn.duration_ms : 0));
    // A turn ending exactly at midnight did not work on the following day.
    intervals.push({ start: day(start), end: day(Math.max(start, end - 1)) });
  }
  intervals.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  const segments = [];
  for (const interval of intervals) {
    const previous = segments.at(-1);
    if (previous && interval.start <= nextDay(previous.end)) previous.end = previous.end > interval.end ? previous.end : interval.end;
    else segments.push({ ...interval, resumed: segments.length > 0 });
  }
  return { incomplete, segments: segments.filter(segment => segment.start.slice(0, 7) <= month && segment.end.slice(0, 7) >= month) };
}
