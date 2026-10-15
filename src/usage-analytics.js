// Calendar dates are evaluated in the view's timezone, including DST changes.
export function aggregateUsage(families, { range, timeZone, now = Date.now() }) {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dateKey = time => {
    const parts = Object.fromEntries(format.formatToParts(time).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const end = dateKey(now);
  const startDate = new Date(`${end}T00:00:00Z`);
  if (range === 'mtd') startDate.setUTCDate(1);
  else startDate.setUTCDate(startDate.getUTCDate() - ({ '7d': 6, '30d': 29, '90d': 89 }[range] ?? 29));
  const start = startDate.toISOString().slice(0, 10);
  const days = [];
  for (let cursor = startDate; cursor.toISOString().slice(0, 10) <= end; cursor = new Date(cursor.getTime() + 86400000)) {
    days.push({ date: cursor.toISOString().slice(0, 10), tokens: 0, costUsd: 0, projects: {} });
  }
  const byDate = new Map(days.map(day => [day.date, day]));
  const projects = new Map();
  let incomplete = false, samples = 0;
  const totals = { tokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 };
  for (const { project, usage } of families) {
    // Coverage can be incomplete even when no timestamped records survive.
    incomplete ||= usage.analyticsPartial || usage.partial || false;
    const key = project.id === 'projectless' ? 'unassigned' : project.id || project.path || 'unassigned';
    for (const sample of usage.timeline) {
      if (sample.time > now) continue;
      const day = byDate.get(dateKey(sample.time));
      if (!day) continue;
      let item = projects.get(key);
      if (!item) { item = { id: key, name: key === 'unassigned' ? 'Unassigned' : project.name, tokens: 0, costUsd: 0 }; projects.set(key, item); }
      const tokens = sample.tokens.total_tokens;
      totals.tokens += tokens; totals.inputTokens += sample.tokens.input_tokens;
      totals.cachedInputTokens += sample.tokens.cached_input_tokens; totals.outputTokens += sample.tokens.output_tokens;
      totals.costUsd += sample.costUsd; samples += sample.samples;
      day.tokens += tokens; day.costUsd += sample.costUsd;
      day.projects[key] = (day.projects[key] ?? 0) + sample.costUsd;
      item.tokens += tokens; item.costUsd += sample.costUsd;
      incomplete ||= sample.partial || sample.costPartial;
    }
  }
  return { start, end, timeZone, days, totals, samples, incomplete,
    projects: [...projects.values()].sort((a, b) => b.costUsd - a.costUsd || a.name.localeCompare(b.name)) };
}
