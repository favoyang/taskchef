import { usePreference } from "./preferences";
import { useEffect, useRef, useState } from "react";

interface WeeklyLimit { id: string; name: string | null; date?: string; time: number; remainingPercent: number; resetsAt: number }
export interface UsageData {
  updatedAt?: string; refreshing?: boolean; refreshError?: string; progress?: ScanProgress;
  start: string; end: string; timeZone: string; samples: number; incomplete: boolean;
  totals: { tokens: number; costUsd: number; inputTokens: number; cachedInputTokens: number; outputTokens: number };
  days: { date: string; tokens: number; costUsd: number; projects: Record<string, number>; projectTokens: Record<string, number> }[];
  weeklyLimits?: WeeklyLimit[];
  currentWeeklyLimit?: WeeklyLimit | null;
  projects: { id: string; name: string; costUsd: number; tokens: number }[];
}
interface ScanProgress { completed: number; total: number; }
export type UsageRange = "7d" | "30d" | "90d" | "mtd" | "last-month";
export const usageRequest = (range: UsageRange, force = false, rescan = false) => ({ range, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, ...(force ? { force: true } : {}), ...(rescan ? { rescan: true } : {}) });
export type UsageResponse = UsageData | { loading: true; progress?: ScanProgress };
const money = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n > 0 && n < .01 ? 4 : 2 }).format(n);
const count = (n: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const dateLabel = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const colors = ["#6e91ad", "#80ad99", "#b8a0ca", "#c2a06e", "#c78585", "#7caeb5", "#a9af78", "#bb8caa", "#b28b6f", "#8e97c5", "#92979c"];
const left = 64, right = 794, top = 16, bottom = 166;

export function UsageView({ request, refreshKey = 0 }: { request: (args: ReturnType<typeof usageRequest>) => Promise<UsageResponse>; refreshKey?: number }) {
  const [range, setRange] = usePreference("usage.range");
  const [data, setData] = useState<UsageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const lastRequest = useRef({ refreshKey, retry: 0, rescan: 0 });
  const [selected, setSelected] = useState<string | null>(null);
  const [activeDay, setActiveDay] = useState<number | null>(null);
  const [activeProjectDay, setActiveProjectDay] = useState<number | null>(null);
  const [retry, setRetry] = useState(0);
  const [rescan, setRescan] = useState(0);
  useEffect(() => {
    let current = true;
    const force = refreshKey !== lastRequest.current.refreshKey || retry !== lastRequest.current.retry;
    const rebuild = rescan !== lastRequest.current.rescan;
    lastRequest.current = { refreshKey, retry, rescan };
    setLoading(true); setError(null); setProgress(null); setActiveDay(null); setActiveProjectDay(null); setHighlighted(null);
    if (!force && !rebuild) setData(null);
    let timer: ReturnType<typeof setTimeout>;
    async function load(force: boolean, rebuild = false) {
      if (document.visibilityState === "hidden") { timer = setTimeout(() => { void load(force, rebuild); }, 1000); return; }
      try {
        const result = await request(usageRequest(range, force, rebuild));
        if (!current) return;
        setProgress(result.progress ?? null);
        if ("loading" in result) timer = setTimeout(() => { void load(false); }, 250);
        else {
          setData(result); setLoading(false);
          if (result.refreshing) timer = setTimeout(() => { void load(false); }, 250);
        }
      } catch (cause) { if (current) { setError(String(cause)); setLoading(false); } }
    }
    void load(force, rebuild);
    return () => { current = false; clearTimeout(timer); };
  }, [range, request, refreshKey, retry, rescan]);
  const today = data ? new Intl.DateTimeFormat("en-CA", { timeZone: data.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()) : "";
  const unfinished = (date: string) => date === today;
  const barStyle = (date: string, color: string) => unfinished(date) ? { fillOpacity: .35, stroke: color, strokeWidth: 1.5, strokeDasharray: "4 3" } : {};
  const project = data?.projects.find(item => item.id === selected);
  const series = data ? (project ? [{ ...project, color: colors[data.projects.indexOf(project) < 10 ? data.projects.indexOf(project) : 10] }]
    : [...data.projects.slice(0, 10).map((item, index) => ({ ...item, color: colors[index] })),
      ...(data.projects.length > 10 ? [{ id: "__other", name: "Other", costUsd: 0, tokens: 0, color: colors[10] }] : [])]) : [];
  const activeHighlight = series.some(item => item.id === highlighted) ? highlighted : null;
  const dayWidth = data ? (right - left) / data.days.length : 1;
  const maxCost = Math.max(...(data?.days.map(day => day.costUsd) ?? []), .01);
  const maxTokens = Math.max(...(data?.days.map(day => day.tokens) ?? []), 1);
  const projectCost = (day: UsageData["days"][number], id: string) => id === "__other"
    ? data!.projects.slice(10).reduce((sum, item) => sum + (day.projects[item.id] ?? 0), 0) : day.projects[id] ?? 0;
  const projectTokens = (day: UsageData["days"][number], id: string) => id === "__other"
    ? data!.projects.slice(10).reduce((sum, item) => sum + (day.projectTokens?.[item.id] ?? 0), 0) : day.projectTokens?.[id] ?? 0;
  const maxProjectTokens = Math.max(...(data?.days.map(day => series.reduce((sum, item) => sum + projectTokens(day, item.id), 0)) ?? []), 1);
  const maxProjectCost = Math.max(...(data?.days.map(day => series.reduce((sum, item) => sum + projectCost(day, item.id), 0)) ?? []), .01);
  const x = (index: number) => left + (index + .5) * dayWidth;
  const y = (value: number, max: number) => bottom - value / max * (bottom - top);
  function grid(max: number, tokens = false) {
    return [0, .5, 1].map(fraction => <g key={fraction}>
      <line x1={left} x2={right} y1={y(fraction, 1)} y2={y(fraction, 1)} className="usage-grid" />
      <text x={left - 10} y={y(fraction, 1) + 4} textAnchor="end">{tokens ? count(max * fraction) : money(max * fraction)}</text>
    </g>);
  }
  function dates() {
    return data!.days.map((day, index) => index === 0 || index === data!.days.length - 1 || index % Math.ceil(data!.days.length / 5) === 0
      ? <text key={day.date} x={x(index)} y={bottom + 25} textAnchor="middle">{dateLabel(day.date)}</text> : null);
  }
  return <section className="usage-view" aria-label="Usage analytics">
    <div className="usage-heading"><div><h2>Usage</h2><p>Tokens and estimated cost across your Codex work.</p></div><button disabled={loading || data?.refreshing} onClick={() => setRescan(value => value + 1)}>Rescan</button></div>
    <div className="usage-ranges" role="group" aria-label="Usage time range">
      {([ ["7d", "7 days"], ["30d", "30 days"], ["90d", "90 days"], ["mtd", "This month"], ["last-month", "Last month"] ] as const).map(([value, label]) => <button key={value} aria-pressed={range === value} onClick={() => setRange(value)}>{label}</button>)}
    </div>
    {(loading || data?.refreshing) && !error && <div className="usage-progress" role="status">
      <p>{data ? "Updating saved usage…" : "Reading saved usage…"} {progress?.total ? `${progress.completed} of ${progress.total} chats` : "Preparing history…"}</p>
      <progress aria-label="Usage scan progress" max={progress?.total || 1} value={progress?.total ? progress.completed : undefined} />
    </div>}
    {error && <div role="alert"><p>Usage could not be loaded: {error}</p><button onClick={() => setRetry(value => value + 1)}>Retry</button></div>}
    {data && <>
      {data.refreshError && <p role="alert">{data.refreshError} <button onClick={() => setRetry(value => value + 1)}>Retry</button></p>}
      <p className="usage-period">{dateLabel(data.start)} – {dateLabel(data.end)} · {data.timeZone} · Daily · All chat sources · Includes archived chats and subagent usage{data.updatedAt && <> · Updated {new Date(data.updatedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</>}</p>
      <div className="usage-totals">
          <article><h3>Recorded tokens</h3><strong>{count(data.totals.tokens)}</strong><p>Input {count(data.totals.inputTokens)} · Cached input {count(data.totals.cachedInputTokens)} · Output {count(data.totals.outputTokens)}</p></article>
          <article><h3>Estimated cost</h3><strong>{money(data.totals.costUsd)}</strong><p>API-equivalent prices · USD</p></article>
          <WeeklyLimits data={data} />
        </div>
      {!data.samples ? <p role="status">No timestamped usage is available for this period.</p> : <>
        <article className="usage-panel" aria-label="Tokens and cost"><h3>Tokens and cost</h3>
          <div className="usage-legend"><span className="usage-token-key">━ Tokens</span><span><i style={{ background: colors[0] }} /> Estimated cost</span></div>
          <div className="usage-chart-scroll"><svg viewBox="0 0 860 210" role="img" aria-label="Daily estimated cost bars and token line" className="usage-chart">
            {grid(maxCost)}
            {[0, .5, 1].map(fraction => <text className="usage-token-axis" key={fraction} x={right + 10} y={y(fraction, 1) + 4}>{count(maxTokens * fraction)}</text>)}
            {data.days.map((day, index) => <rect key={day.date} x={x(index) - dayWidth * .3} y={y(day.costUsd, maxCost)} width={dayWidth * .6} height={bottom - y(day.costUsd, maxCost)} fill={colors[0]} {...barStyle(day.date, colors[0])}><title>{dateLabel(day.date)}{unfinished(day.date) ? " (in progress)" : ""}: {money(day.costUsd)}, {day.tokens.toLocaleString()} tokens</title></rect>)}
            <polyline className="usage-token-line" points={data.days.map((day, index) => unfinished(day.date) ? null : `${x(index)},${y(day.tokens, maxTokens)}`).filter(Boolean).join(" ")} />
            {data.days.map((day, index) => unfinished(day.date) && index > 0 ? <polyline key={day.date} className="usage-token-line" strokeDasharray="5 4" points={`${x(index - 1)},${y(data.days[index - 1].tokens, maxTokens)} ${x(index)},${y(day.tokens, maxTokens)}`} /> : null)}
            {data.days.map((day, index) => <g key={day.date} tabIndex={0} role="button" aria-label={`${dateLabel(day.date)}: ${money(day.costUsd)}, ${day.tokens.toLocaleString()} tokens${unfinished(day.date) ? " (in progress)" : ""}`} onMouseEnter={() => setActiveDay(index)} onFocus={() => setActiveDay(index)} onClick={() => setActiveDay(index)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setActiveDay(index); } }}><rect x={left + index * dayWidth} y={top} width={dayWidth} height={bottom - top} fill="transparent" /><circle cx={x(index)} cy={y(day.tokens, maxTokens)} r={data.days.length > 30 ? 0 : 2.5} className="usage-token-dot" /></g>)}
            {dates()}
          </svg></div>
          <p className="usage-chart-detail" aria-live="polite">{activeDay === null ? "" : `${dateLabel(data.days[activeDay].date)} · ${data.days[activeDay].tokens.toLocaleString()} tokens · ${money(data.days[activeDay].costUsd)}`}</p>
        </article>
        <article className="usage-panel" aria-label="Tokens and cost by project"><h3>Tokens and cost by project</h3>
          <div className="usage-legend"><button aria-pressed={!project} onMouseEnter={() => setHighlighted(null)} onFocus={() => setHighlighted(null)} onClick={() => setSelected(null)}>All projects</button>{data.projects.slice(0, 10).map((item, index) => <button key={item.id} aria-pressed={project?.id === item.id} onMouseEnter={() => setHighlighted(item.id)} onMouseLeave={() => setHighlighted(null)} onFocus={() => setHighlighted(item.id)} onBlur={() => setHighlighted(null)} onClick={() => setSelected(project?.id === item.id ? null : item.id)}><i style={{ background: colors[index] }} />{item.name}</button>)}{data.projects.length > 10 && <span tabIndex={0} onMouseEnter={() => setHighlighted("__other")} onMouseLeave={() => setHighlighted(null)} onFocus={() => setHighlighted("__other")} onBlur={() => setHighlighted(null)}><i style={{ background: colors[10] }} />Other</span>}</div>
          <h4>Estimated cost</h4>
          <div className="usage-chart-scroll"><svg viewBox="0 0 860 210" role="img" aria-label={`Daily project cost bars: ${project?.name ?? "all projects"}`} className="usage-chart">
            {grid(maxProjectCost)}
            {data.days.map((day, index) => { let accumulated = 0; return <g key={day.date}>{series.map(item => { const cost = projectCost(day, item.id); const start = accumulated; accumulated += cost; return <rect key={item.id} x={x(index) - dayWidth * .3} y={y(accumulated, maxProjectCost)} width={dayWidth * .6} height={(cost / maxProjectCost) * (bottom - top)} fill={item.color} {...barStyle(day.date, item.color)} data-project={item.id} opacity={activeHighlight && activeHighlight !== item.id ? .2 : 1}><title>{dateLabel(day.date)}{unfinished(day.date) ? " (in progress)" : ""} · {item.name}: {money(accumulated - start)}</title></rect>; })}</g>; })}
            {dates()}
          </svg></div>
          <h4>Tokens</h4>
          <div className="usage-chart-scroll"><svg viewBox="0 0 860 210" role="img" aria-label={`Daily project token stack: ${project?.name ?? "all projects"}`} className="usage-chart">
            {grid(maxProjectTokens, true)}
            {series.map((item, seriesIndex) => {
              const lower = data.days.map(day => series.slice(0, seriesIndex).reduce((sum, preceding) => sum + projectTokens(day, preceding.id), 0));
              const upper = data.days.map((day, index) => lower[index] + projectTokens(day, item.id));
              const finished = data.days.map((day, index) => ({ day, index })).filter(({ day }) => !unfinished(day.date));
              return <g key={item.id} data-project={item.id} opacity={activeHighlight && activeHighlight !== item.id ? .2 : 1}>
                <polygon fill={item.color} fillOpacity=".3" points={[...data.days.map((_, index) => `${x(index)},${y(upper[index], maxProjectTokens)}`), ...data.days.map((_, index) => `${x(index)},${y(lower[index], maxProjectTokens)}`).reverse()].join(" ")} />
                <polyline fill="none" stroke={item.color} strokeWidth="2" points={finished.map(({ index }) => `${x(index)},${y(upper[index], maxProjectTokens)}`).join(" ")} />
                {data.days.map((day, index) => unfinished(day.date) && index > 0 ? <polyline key={day.date} fill="none" stroke={item.color} strokeWidth="2" strokeDasharray="5 4" points={`${x(index - 1)},${y(upper[index - 1], maxProjectTokens)} ${x(index)},${y(upper[index], maxProjectTokens)}`} /> : null)}
                {data.days.map((day, index) => <circle key={day.date} cx={x(index)} cy={y(upper[index], maxProjectTokens)} r="2.5" fill={item.color}><title>{dateLabel(day.date)} · {item.name}: {projectTokens(day, item.id).toLocaleString()} tokens</title></circle>)}
              </g>;
            })}
            {data.days.map((day, index) => <g key={day.date} tabIndex={0} role="button" aria-label={`${dateLabel(day.date)} project usage`} onMouseEnter={() => setActiveProjectDay(index)} onFocus={() => setActiveProjectDay(index)} onClick={() => setActiveProjectDay(index)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setActiveProjectDay(index); } }}><rect x={left + index * dayWidth} y={top} width={dayWidth} height={bottom - top} fill="transparent" /></g>)}
            {dates()}
          </svg></div>
          <p className="usage-chart-detail" aria-live="polite">{activeProjectDay === null ? "" : `${dateLabel(data.days[activeProjectDay].date)} · ${series.map(item => `${item.name}: ${projectTokens(data.days[activeProjectDay], item.id).toLocaleString()} tokens, ${money(projectCost(data.days[activeProjectDay], item.id))}`).join(" · ")}`}</p>
        </article>
        <article className="usage-panel" aria-label="Top 10 projects"><h3>Top 10 projects</h3>
          <div className="usage-ranking"><table><thead><tr><th scope="col">Project</th><th scope="col">Estimated cost</th><th scope="col">Share</th></tr></thead><tbody>{data.projects.slice(0, 10).map((item, index) => <tr key={item.id}><th scope="row"><button aria-pressed={project?.id === item.id} onClick={() => setSelected(project?.id === item.id ? null : item.id)}><span>{index + 1}. {item.name}</span><span className="usage-rank-track" aria-hidden><span style={{ width: `${data.projects[0].costUsd ? item.costUsd / data.projects[0].costUsd * 100 : 0}%`, background: colors[index < 10 ? index : 10] }} /></span></button></th><td>{money(item.costUsd)}</td><td>{data.totals.costUsd ? (item.costUsd / data.totals.costUsd * 100).toFixed(1) : "0.0"}%</td></tr>)}</tbody></table></div>
        </article>
      </>}
      <p className="usage-footnote">Cost is estimated at API-equivalent prices, not your subscription bill or remaining allowance.</p>
    </>}
  </section>;
}

function WeeklyLimits({ data }: { data: UsageData }) {
  const [now, setNow] = useState(Date.now);
  const resetsAt = data.currentWeeklyLimit?.resetsAt;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    function update() {
      const time = Date.now();
      setNow(time);
      if (resetsAt && resetsAt > time) timer = setTimeout(update, Math.min(resetsAt - time, 2_147_483_647));
    }
    update();
    return () => clearTimeout(timer);
  }, [resetsAt]);
  const samples = (data.weeklyLimits ?? []).filter(sample => sample.id === "codex").sort((a, b) => a.time - b.time);
  const current = data.currentWeeklyLimit && data.currentWeeklyLimit.resetsAt > now ? data.currentWeeklyLimit : null;
  const dateTime = (time: number) => new Date(time).toLocaleString(undefined, { timeZone: data.timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  const dayIndex = new Map(data.days.map((day, index) => [day.date, index]));
  const position = (time: number) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: data.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(time).map(part => [part.type, part.value]));
    const index = dayIndex.get(`${parts.year}-${parts.month}-${parts.day}`) ?? 0;
    return 30 + (index + (Number(parts.hour) + Number(parts.minute) / 60) / 24) / data.days.length * 264;
  };
  const y = (value: number) => 72 - value / 100 * 60;
  const points: string[] = [];
  samples.forEach((sample, index) => {
    const previous = samples[index - 1];
    if (previous && previous.resetsAt <= sample.time && previous.resetsAt > previous.time) {
      // Preserve the observed allowance until its known reset, then refill.
      points.push(`${position(previous.resetsAt)},${y(previous.remainingPercent)}`, `${position(previous.resetsAt)},${y(100)}`);
    }
    points.push(`${position(sample.time)},${y(sample.remainingPercent)}`);
  });
  return <article className="usage-weekly" aria-label="Weekly limits">
    <h3>Weekly limits{current && ` · ${current.remainingPercent.toFixed(0)}% left`}</h3>
    <p className="usage-weekly-reset">{current ? `Resets ${dateTime(current.resetsAt)}` : "Current allowance unavailable"}</p>
    {!samples.length ? <p>No weekly limit readings for this period.</p> : <svg viewBox="0 0 300 96" role="img" aria-label="Recorded weekly allowance remaining by day" className="usage-weekly-chart">
      <title>Recorded allowance snapshots from Codex session logs; lines connect observations and show known resets.</title>
      {[0, 50, 100].map(value => <g key={value}><line x1="30" x2="294" y1={y(value)} y2={y(value)} className="usage-grid" /><text x="24" y={y(value) + 3} textAnchor="end">{value}%</text></g>)}
      <polyline fill="none" stroke={colors[0]} strokeWidth="2" points={points.join(" ")} />
      {samples.map(sample => <circle key={sample.time} cx={position(sample.time)} cy={y(sample.remainingPercent)} r="2.5" fill={colors[0]}><title>{dateTime(sample.time)} · {sample.remainingPercent.toFixed(1)}% left · Resets {dateTime(sample.resetsAt)}</title></circle>)}
      <text x="30" y="90">{dateLabel(data.start)}</text><text x="294" y="90" textAnchor="end">{dateLabel(data.end)}</text>
    </svg>}
  </article>;
}
