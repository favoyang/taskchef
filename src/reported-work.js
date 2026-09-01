const LIFECYCLE_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

export function durationBetween(startedAt, endedAt) {
  const start = parseLifecycleTimestamp(startedAt);
  const end = parseLifecycleTimestamp(endedAt);
  if (start === null || end === null) return null;
  const duration = end - start;
  return duration >= 0 ? duration : null;
}

export function terminalTurnDuration(turn) {
  const duration = durationBetween(turn.startedAt, turn.result?.updatedAt);
  return duration === 0 ? null : duration;
}

export function reportedWorkSummary(turns) {
  const terminalTurns = turns.filter((turn) => turn.result !== null);
  const durations = terminalTurns
    .map(terminalTurnDuration)
    .filter((duration) => duration !== null);
  const totalMilliseconds = durations.length === 0
    ? terminalTurns.length === 0 ? 0 : null
    : durations.reduce((total, duration) => total + duration, 0);
  return Object.freeze({
    terminalTurns: terminalTurns.length,
    validTurns: durations.length,
    totalMilliseconds: totalMilliseconds === null || Number.isSafeInteger(totalMilliseconds)
      ? totalMilliseconds
      : null,
  });
}

function parseLifecycleTimestamp(value) {
  if (typeof value !== "string") return null;
  const match = value.match(LIFECYCLE_TIMESTAMP_PATTERN);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const zoneHour = zone === "Z" ? 0 : Number(zone.slice(1, 3));
  const zoneMinute = zone === "Z" ? 0 : Number(zone.slice(4, 6));
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1
    || month > 12
    || day < 1
    || day > daysInMonth[month - 1]
    || hour > 23
    || minute > 59
    || second > 59
    || zoneHour > 23
    || zoneMinute > 59
  ) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
