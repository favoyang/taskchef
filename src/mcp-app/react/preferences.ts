import { useEffect, useState } from "react";

type Preferences = {
  "filter.project": string;
  "filter.search": string;
  "filter.updated": string;
  "filter.pinned": boolean;
  "calendar.scheduled": boolean;
  "usage.range": "7d" | "30d" | "90d" | "mtd" | "last-month";
};
const defaults: Preferences = {
  "filter.project": "", "filter.search": "", "filter.updated": "all",
  "filter.pinned": false, "calendar.scheduled": true, "usage.range": "30d",
};
function readPreference<K extends keyof Preferences>(key: K): Preferences[K] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(`taskchef.app.${key}`) ?? "null");
    if (typeof value !== typeof defaults[key]) return defaults[key];
    if (key === "filter.updated" && !["all", "24h", "7d"].includes(value as string)) return defaults[key];
    if (key === "usage.range" && !["7d", "30d", "90d", "mtd", "last-month"].includes(value as string)) return defaults[key];
    return value as Preferences[K];
  } catch { return defaults[key]; }
}

// The six view preferences share the same local storage behavior as Appearance.
// Unavailable storage leaves controls usable for the current mounted view.
export function usePreference<K extends keyof Preferences>(key: K) {
  const [value, setValue] = useState<Preferences[K]>(() => readPreference(key));
  useEffect(() => {
    try { window.localStorage.setItem(`taskchef.app.${key}`, JSON.stringify(value)); }
    catch { /* Keep the user's current choice in memory. */ }
  }, [key, value]);
  return [value, setValue] as const;
}
