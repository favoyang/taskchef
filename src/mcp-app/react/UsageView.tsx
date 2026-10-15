import { useEffect, useState } from "react";

export interface UsageData {
  start: string; end: string; timeZone: string; samples: number; incomplete: boolean;
  totals: { tokens: number; costUsd: number; inputTokens: number; cachedInputTokens: number; outputTokens: number };
  days: { date: string; tokens: number; costUsd: number; projects: Record<string, number> }[];
  projects: { id: string; name: string; costUsd: number; tokens: number }[];
}
export type UsageRange = "7d" | "30d" | "90d" | "mtd";
export const usageRequest = (range: UsageRange, force = false) => ({ range, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, ...(force ? { force: true } : {}) });
export type UsageResponse = UsageData | { loading: true };
const money = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n > 0 && n < .01 ? 4 : 2 }).format(n);
const count = (n: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const dateLabel = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const colors = ["#6e91ad", "#80ad99", "#b8a0ca", "#c2a06e", "#c78585", "#92979c"];
const left = 64, right = 794, top = 16, bottom = 166;

export function UsageView({ request, refreshKey = 0 }: { request: (args: ReturnType<typeof usageRequest>) => Promise<UsageResponse>; refreshKey?: number }) {
  const [range, setRange] = useState<UsageRange>("mtd");
  const [data, setData] = useState<UsageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [activeDay, setActiveDay] = useState<number | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    setLoading(true); setError(null); setData(null); setActiveDay(null);
    let timer: ReturnType<typeof setTimeout>;
    async function load(force: boolean) {
      if (document.visibilityState === "hidden") { timer = setTimeout(() => { void load(force); }, 1000); return; }
      try {
        const result = await request(usageRequest(range, force));
        if (!current) return;
        if ("loading" in result) timer = setTimeout(() => { void load(false); }, 1000);
        else { setData(result); setLoading(false); }
      } catch (cause) { if (current) { setError(String(cause)); setLoading(false); } }
    }
    void load(true);
    return () => { current = false; clearTimeout(timer); };
  }, [range, request, refreshKey, retry]);
  const project = data?.projects.find(item => item.id === selected);
  const series = data ? (project ? [{ ...project, color: colors[data.projects.indexOf(project) < 5 ? data.projects.indexOf(project) : 5] }]
    : [...data.projects.slice(0, 5).map((item, index) => ({ ...item, color: colors[index] })),
      ...(data.projects.length > 5 ? [{ id: "__other", name: "Other", costUsd: 0, tokens: 0, color: colors[5] }] : [])]) : [];
  const dayWidth = data ? (right - left) / data.days.length : 1;
  const maxCost = Math.max(...(data?.days.map(day => day.costUsd) ?? []), .01);
  const maxTokens = Math.max(...(data?.days.map(day => day.tokens) ?? []), 1);
  const projectCost = (day: UsageData["days"][number], id: string) => id === "__other"
    ? data!.projects.slice(5).reduce((sum, item) => sum + (day.projects[item.id] ?? 0), 0) : day.projects[id] ?? 0;
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
    <div className="usage-heading"><div><h2>Usage</h2><p>Tokens and estimated cost across your Codex work.</p></div></div>
    <div className="usage-ranges" role="group" aria-label="Usage time range">
      {([ ["7d", "7 days"], ["30d", "30 days"], ["90d", "90 days"], ["mtd", "Month to date"] ] as const).map(([value, label]) => <button key={value} aria-pressed={range === value} onClick={() => setRange(value)}>{label}</button>)}
    </div>
    {loading && <p role="status">Reading saved usage… The first read may take a moment.</p>}
    {error && <div role="alert"><p>Usage could not be loaded: {error}</p><button onClick={() => setRetry(value => value + 1)}>Retry</button></div>}
    {data && <>
      <p className="usage-period">{dateLabel(data.start)} – {dateLabel(data.end)} · {data.timeZone} · Daily · Includes archived chats and subagent usage</p>
      {data.incomplete && <p role="status" className="usage-warning">Incomplete coverage: some records, timestamps, or model prices are missing. Totals show only dated, recorded usage and known costs.</p>}
      {!data.samples ? <p role="status">No timestamped usage is available for this period.</p> : <>
        <div className="usage-totals">
          <article><h3>Recorded tokens</h3><strong>{count(data.totals.tokens)}</strong><p>Input {count(data.totals.inputTokens)} · Cached input {count(data.totals.cachedInputTokens)} · Output {count(data.totals.outputTokens)}</p><small>Cached input is included in input tokens.</small></article>
          <article><h3>Estimated cost</h3><strong>{money(data.totals.costUsd)}</strong><p>API-equivalent prices · USD{data.incomplete ? " · Known subtotal" : ""}</p></article>
        </div>
        <article className="usage-panel" aria-label="Tokens and cost over time"><h3>Tokens and cost over time</h3>
          <div className="usage-legend"><span className="usage-token-key">━ Tokens · right axis</span><span><i style={{ background: colors[0] }} /> Estimated cost · left axis</span></div>
          <div className="usage-chart-scroll"><svg viewBox="0 0 860 210" role="img" aria-label="Daily estimated cost bars and token line" className="usage-chart">
            {grid(maxCost)}
            {[0, .5, 1].map(fraction => <text className="usage-token-axis" key={fraction} x={right + 10} y={y(fraction, 1) + 4}>{count(maxTokens * fraction)}</text>)}
            {data.days.map((day, index) => <rect key={day.date} x={x(index) - dayWidth * .3} y={y(day.costUsd, maxCost)} width={dayWidth * .6} height={bottom - y(day.costUsd, maxCost)} fill={colors[0]}><title>{dateLabel(day.date)}: {money(day.costUsd)}, {day.tokens.toLocaleString()} tokens</title></rect>)}
            <polyline className="usage-token-line" points={data.days.map((day, index) => `${x(index)},${y(day.tokens, maxTokens)}`).join(" ")} />
            {data.days.map((day, index) => <g key={day.date} tabIndex={0} role="button" aria-label={`${dateLabel(day.date)}: ${money(day.costUsd)}, ${day.tokens.toLocaleString()} tokens`} onMouseEnter={() => setActiveDay(index)} onFocus={() => setActiveDay(index)} onClick={() => setActiveDay(index)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setActiveDay(index); } }}><rect x={left + index * dayWidth} y={top} width={dayWidth} height={bottom - top} fill="transparent" /><circle cx={x(index)} cy={y(day.tokens, maxTokens)} r={data.days.length > 30 ? 0 : 2.5} className="usage-token-dot" /></g>)}
            {dates()}
          </svg></div>
          <p className="usage-chart-detail" aria-live="polite">{activeDay === null ? "Hover or focus a day to inspect its usage." : `${dateLabel(data.days[activeDay].date)} · ${data.days[activeDay].tokens.toLocaleString()} tokens · ${money(data.days[activeDay].costUsd)}`}</p>
        </article>
        <article className="usage-panel" aria-label="Cost by project over time"><h3>Cost by project over time</h3>
          <p>{project ? `${project.name} · ` : "Top 5 projects + Other · "}Select a project below to isolate its cost.</p>
          <div className="usage-legend"><button aria-pressed={!project} onClick={() => setSelected(null)}>All projects</button>{data.projects.slice(0, 5).map((item, index) => <button key={item.id} aria-pressed={project?.id === item.id} onClick={() => setSelected(project?.id === item.id ? null : item.id)}><i style={{ background: colors[index] }} />{item.name}</button>)}{data.projects.length > 5 && <span><i style={{ background: colors[5] }} />Other</span>}</div>
          <div className="usage-chart-scroll"><svg viewBox="0 0 860 210" role="img" aria-label={`Daily project cost bars: ${project?.name ?? "all projects"}`} className="usage-chart">
            {grid(maxProjectCost)}
            {data.days.map((day, index) => { let accumulated = 0; return <g key={day.date}>{series.map(item => { const cost = projectCost(day, item.id); const start = accumulated; accumulated += cost; return <rect key={item.id} x={x(index) - dayWidth * .3} y={y(accumulated, maxProjectCost)} width={dayWidth * .6} height={(cost / maxProjectCost) * (bottom - top)} fill={item.color}><title>{dateLabel(day.date)} · {item.name}: {money(accumulated - start)}</title></rect>; })}</g>; })}
            {dates()}
          </svg></div>
        </article>
        <article className="usage-panel" aria-label="Top 10 projects"><h3>Top 10 projects</h3><p>By estimated cost in the selected period. Select a row to isolate its project above.</p>
          <div className="usage-ranking"><table><thead><tr><th scope="col">Project</th><th scope="col">Estimated cost</th><th scope="col">Share</th></tr></thead><tbody>{data.projects.slice(0, 10).map((item, index) => <tr key={item.id}><th scope="row"><button aria-pressed={project?.id === item.id} onClick={() => setSelected(project?.id === item.id ? null : item.id)}><span>{index + 1}. {item.name}</span><span className="usage-rank-track" aria-hidden><span style={{ width: `${data.projects[0].costUsd ? item.costUsd / data.projects[0].costUsd * 100 : 0}%`, background: colors[index < 5 ? index : 5] }} /></span></button></th><td>{money(item.costUsd)}</td><td>{data.totals.costUsd ? (item.costUsd / data.totals.costUsd * 100).toFixed(1) : "0.0"}%</td></tr>)}</tbody></table></div>
        </article>
      </>}
      <p className="usage-footnote">Cost is estimated at API-equivalent prices, not your subscription bill or remaining allowance. Missing usage is not zero.</p>
    </>}
  </section>;
}
