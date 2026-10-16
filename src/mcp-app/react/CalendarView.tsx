import { useEffect, useState } from "react";
import type { Task } from "../../ui/types";

export interface CalendarSegment { start: string; end: string; resumed: boolean; }
export interface CalendarData { month: string; timeZone: string; chats: { id: string; incomplete: boolean; segments: CalendarSegment[] }[]; }
export type CalendarRequest = (args: { month: string; timeZone: string }) => Promise<CalendarData>;
const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const addDays = (key: string, days: number) => new Date(Date.parse(`${key}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const statusLabels = { working: "Running", needs_input: "Waiting for review", completed: "Done", failed: "Failed", scheduled: "Scheduled", interrupted: "Interrupted", archived: "Archived" };
const projectHue = (task: Task) => [...(task.project.id || task.project.path || task.project.name)].reduce((hash, c) => (hash * 31 + c.charCodeAt(0)) % 360, 0);

export function CalendarView({ request, tasks, refreshKey, onOpenDetail, showProject = true }: { request: CalendarRequest; tasks: Task[]; refreshKey: string; showProject?: boolean; onOpenDetail: (task: Task) => void }) {
  const [month, setMonth] = useState(() => dateKey(new Date()).slice(0, 7));
  const [data, setData] = useState<CalendarData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [expanded, setExpanded] = useState<string[]>([]);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  useEffect(() => {
    let current = true;
    setError(null);
    void request({ month, timeZone }).then(value => { if (current) setData(value); })
      .catch(cause => { if (current) { setData(null); setError(String(cause)); } });
    return () => { current = false; };
  }, [month, timeZone, request, refreshKey, retry]);
  function navigate(delta: number) {
    const date = new Date(`${month}-01T12:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + delta);
    setMonth(date.toISOString().slice(0, 7)); setData(null); setExpanded([]);
  }
  const first = `${month}-01`;
  const offset = (new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7;
  const gridStart = addDays(first, -offset);
  const daysInMonth = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  const weeks = Math.ceil((offset + daysInMonth) / 7);
  const label = new Date(`${first}T12:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
  const byId = new Map(tasks.map(task => [task.id, task]));
  const chats = data?.month === month ? data.chats.filter(chat => byId.has(chat.id)) : [];
  const bars = chats.flatMap(chat => chat.segments.map(segment => ({ ...segment, task: byId.get(chat.id)! })));
  const today = dateKey(new Date());
  return <section className="calendar-view" aria-label="Chat work calendar">
    <nav className="calendar-navigation" aria-label="Month navigation">
      <button aria-label="Previous month" onClick={() => navigate(-1)}>‹</button>
      <h2 aria-live="polite">{label}</h2>
      <button aria-label="Next month" onClick={() => navigate(1)}>›</button>
    </nav>
    {error && <div role="alert">Calendar could not be loaded: {error} <button onClick={() => setRetry(value => value + 1)}>Retry</button></div>}
    {!data && !error && <p role="status">Reading recorded work…</p>}
    {chats.some(chat => chat.incomplete) && <p role="status">Some turn dates or durations are missing. Only known dates are shown; gaps may reflect incomplete history.</p>}
    <div className="calendar-scroll" tabIndex={0} aria-label="Month calendar; scroll horizontally on narrow screens">
      <div className="calendar-month">
        <div className="calendar-weekdays">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(day => <div key={day}>{day}</div>)}</div>
        {Array.from({ length: weeks }, (_, week) => {
          const start = addDays(gridStart, week * 7), end = addDays(start, 6);
          const weekBars = bars.filter(bar => bar.start <= end && bar.end >= start).sort((a, b) => a.start.localeCompare(b.start) || b.end.localeCompare(a.end) || a.task.title.localeCompare(b.task.title) || a.task.id.localeCompare(b.task.id));
          const lanes: string[] = [];
          const placed = weekBars.map(bar => {
            const left = bar.start < start ? start : bar.start, right = bar.end > end ? end : bar.end;
            let lane = lanes.findIndex(last => last < left);
            if (lane < 0) lane = lanes.length;
            lanes[lane] = right;
            return { ...bar, left, right, lane };
          });
          const open = expanded.includes(start);
          const visible = placed.filter(bar => open || bar.lane < 3);
          const hidden = placed.length - visible.length;
          return <div className="calendar-week" key={start}>
            <div className="calendar-week-grid" style={{ gridTemplateRows: `30px repeat(${Math.max(3, open ? lanes.length : Math.min(3, lanes.length))}, 28px)` }}>
              <div className="calendar-day-backgrounds" aria-hidden>{Array.from({ length: 7 }, (_, col) => <div className={col > 4 ? "calendar-weekend" : ""} key={col} />)}</div>
              {Array.from({ length: 7 }, (_, col) => {
                const day = addDays(start, col);
                return <div key={day} className={`calendar-day${day.slice(0, 7) !== month ? " calendar-outside" : ""}${day === today ? " calendar-today" : ""}`} style={{ gridColumn: col + 1, gridRow: 1 }}><time dateTime={day}>{Number(day.slice(-2))}</time></div>;
              })}
              {visible.map(bar => {
                const col = Math.round((Date.parse(bar.left) - Date.parse(start)) / 86400000);
                const span = Math.round((Date.parse(bar.right) - Date.parse(bar.left)) / 86400000) + 1;
                const title = showProject ? `${bar.task.project.name} · ${bar.task.title}` : bar.task.title;
                return <button key={`${bar.task.id}:${bar.start}`} className="calendar-bar" style={{ gridColumn: `${col + 1} / span ${span}`, gridRow: bar.lane + 2, borderColor: `hsl(${projectHue(bar.task)} 45% 55%)`, backgroundColor: `hsl(${projectHue(bar.task)} 45% 55% / .17)` }} title={`${title}\n${bar.start} – ${bar.end}${bar.resumed ? ' · Resumed' : ''}\nCurrent status: ${bar.task.status ? statusLabels[bar.task.status] : 'Unverified'}`} onClick={() => onOpenDetail(bar.task)}>
                  {bar.start < start ? "← " : bar.resumed ? "↩ " : ""}{title}{bar.end > end ? " →" : ""}
                </button>;
              })}
            </div>
            {(hidden > 0 || open) && <button className="calendar-more" onClick={() => setExpanded(value => open ? value.filter(item => item !== start) : [...value, start])}>{open ? "Show fewer" : `+${hidden} more this week`}</button>}
          </div>;
        })}
      </div>
    </div>
    {data && !error && !bars.length && <p role="status">No recorded work matches this month and these filters.</p>}
  </section>;
}
