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

function hourPhrase(milliseconds, direction) {
  const hours = Math.floor(milliseconds / HOUR_MS);
  const minutes = Math.floor((milliseconds % HOUR_MS) / MINUTE_MS);
  const hourText = hours === 1 ? "1 hour" : `${hours} hours`;
  const detail = hours < 6 && minutes > 0 ? ` ${minutes} minutes` : "";
  return direction === "future"
    ? `in ${hourText}${detail}`
    : `${hourText}${detail} ago`;
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
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone,
  }).format(parsed.date);
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
