export const RELATIVE_TIME_REFRESH_MS = 30_000;
export const RELATIVE_DATE_LIMIT_DAYS = 30;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function parsedTimestamp(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return {
    date: new Date(milliseconds),
    iso: new Date(milliseconds).toISOString(),
    milliseconds,
  };
}

export function formatExactTime(value, { locale, timeZone } = {}) {
  const parsed = parsedTimestamp(value);
  if (!parsed) return "—";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(parsed.date);
}

// Compare calendar days in the user's local timezone, independent of DST hours.
export function formatCardTime(value, { now = Date.now() } = {}) {
  const parsed = parsedTimestamp(value);
  if (!parsed) return "—";
  const date = parsed.date;
  const current = new Date(now);
  const dayKey = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const days = (dayKey(current) - dayKey(date)) / DAY_MS;
  if (days === 0) return new Intl.DateTimeFormat("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true,
  }).format(date).replace(/\s/g, "");
  if (days === 1) return "Yesterday";
  const day = date.getDate();
  const suffix = day % 100 >= 11 && day % 100 <= 13 ? "th"
    : ({ 1: "st", 2: "nd", 3: "rd" }[day % 10] ?? "th");
  const month = new Intl.DateTimeFormat("en-US", { month: "short" }).format(date);
  return `${month} ${day}${suffix}${date.getFullYear() === current.getFullYear() ? "" : `, ${date.getFullYear()}`}`;
}

// Compact card age; clamp clock skew to now and use 30-day months.
export function formatCardAge(value, { now = Date.now() } = {}) {
  const parsed = parsedTimestamp(value);
  if (!parsed) return "—";
  const elapsed = Math.max(0, now - parsed.milliseconds);
  if (elapsed < MINUTE_MS) return "<1m";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h`;
  if (elapsed < 30 * DAY_MS) return `${Math.floor(elapsed / DAY_MS)}d`;
  return `${Math.floor(elapsed / (30 * DAY_MS))}mo`;
}

export function formatWorkedDuration(durationMs) {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return "—";
  const totalMinutes = Math.floor(durationMs / MINUTE_MS);
  if (totalMinutes < 1) return "<1m";
  const hours = Math.floor(totalMinutes / 60);
  return `${hours ? `${hours}h ` : ""}${totalMinutes % 60}m`;
}

function hourPhrase(milliseconds, direction) {
  const hours = Math.floor(milliseconds / HOUR_MS);
  const hourText = hours === 1 ? "1 hour" : `${hours} hours`;
  return direction === "future"
    ? `in ${hourText}`
    : `${hourText} ago`;
}

export function formatRelativeTime(value, {
  now = Date.now(),
  locale,
  timeZone,
} = {}) {
  const parsed = parsedTimestamp(value);
  if (!parsed) return "—";
  const difference = now - parsed.milliseconds;
  const future = difference < 0;
  const elapsed = Math.abs(difference);
  if (elapsed < MINUTE_MS) return "just now";
  if (elapsed < 2 * MINUTE_MS) return future ? "in 1 minute" : "1 minute ago";
  if (elapsed < HOUR_MS) {
    const minutes = future
      ? Math.ceil(elapsed / MINUTE_MS)
      : Math.floor(elapsed / MINUTE_MS);
    return future ? `in ${minutes} minutes` : `${minutes} minutes ago`;
  }
  if (elapsed < 2 * HOUR_MS) return future ? "in 1 hour" : "1 hour ago";
  if (elapsed < DAY_MS) return hourPhrase(elapsed, future ? "future" : "past");
  if (elapsed < 2 * DAY_MS) return future ? "in 1 day" : "1 day ago";
  if (elapsed < RELATIVE_DATE_LIMIT_DAYS * DAY_MS) {
    const days = future
      ? Math.ceil(elapsed / DAY_MS)
      : Math.floor(elapsed / DAY_MS);
    return future ? `in ${days} days` : `${days} days ago`;
  }
  const months = future
    ? Math.ceil(elapsed / (RELATIVE_DATE_LIMIT_DAYS * DAY_MS))
    : Math.floor(elapsed / (RELATIVE_DATE_LIMIT_DAYS * DAY_MS));
  const monthText = months === 1 ? "1 month" : `${months} months`;
  return future ? `in ${monthText}` : `${monthText} ago`;
}

export function timestampPresentation(value, {
  exact = false,
  now = Date.now(),
  locale,
  timeZone,
} = {}) {
  const parsed = parsedTimestamp(value);
  if (!parsed) return { valid: false, label: "—", iso: null };
  return {
    exact,
    iso: parsed.iso,
    label: exact
      ? formatExactTime(value, { locale, timeZone })
      : formatRelativeTime(value, { now, locale, timeZone }),
    valid: true,
  };
}

export class RelativeTimeController {
  constructor({
    now = () => Date.now(),
    setIntervalFn = (...args) => globalThis.setInterval(...args),
    clearIntervalFn = (...args) => globalThis.clearInterval(...args),
    refreshEveryMs = RELATIVE_TIME_REFRESH_MS,
  } = {}) {
    this.now = now;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.refreshEveryMs = refreshEveryMs;
    this.entries = new Map();
    this.exactKeys = new Set();
    this.timer = null;
  }

  register(key, value, render, { isActive = () => true } = {}) {
    const token = Symbol(key);
    this.entries.set(token, { isActive, key, render, value });
    this.renderEntry(this.entries.get(token));
    if (this.timer === null) {
      this.timer = this.setIntervalFn(() => this.refresh(), this.refreshEveryMs);
    }
    return () => this.entries.delete(token);
  }

  renderEntry(entry) {
    entry.render(timestampPresentation(entry.value, {
      exact: this.exactKeys.has(entry.key),
      now: this.now(),
    }));
  }

  toggle(key) {
    if (this.exactKeys.has(key)) this.exactKeys.delete(key);
    else this.exactKeys.add(key);
    for (const entry of this.entries.values()) {
      if (entry.key === key) this.renderEntry(entry);
    }
  }

  refresh() {
    for (const [token, entry] of this.entries) {
      if (!entry.isActive()) {
        this.entries.delete(token);
        continue;
      }
      if (!this.exactKeys.has(entry.key)) this.renderEntry(entry);
    }
  }

  stop() {
    if (this.timer !== null) this.clearIntervalFn(this.timer);
    this.timer = null;
    this.entries.clear();
  }
}
