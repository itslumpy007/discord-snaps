function unixNow() {
  return Math.floor(Date.now() / 1000);
}

function isValidTimeZone(timeZone) {
  try {
    Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function utcDateKeyFromUnix(unixTs) {
  return new Date(unixTs * 1000).toISOString().slice(0, 10);
}

function getZonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  });

  const parts = formatter.formatToParts(date);
  const lookup = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const weekdayMap = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour: Number(lookup.hour),
    minute: Number(lookup.minute),
    second: Number(lookup.second),
    weekday: weekdayMap[lookup.weekday],
  };
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = getZonedParts(date, timeZone);
  const utcGuess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    0
  );

  return utcGuess - date.getTime();
}

function zonedTimeToUtcMs(timeZone, year, month, day, hour, minute = 0, second = 0) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  const offset = getTimeZoneOffsetMs(new Date(utcGuess), timeZone);
  const adjusted = utcGuess - offset;
  const secondOffset = getTimeZoneOffsetMs(new Date(adjusted), timeZone);
  return utcGuess - secondOffset;
}

function getWeekKeyFromUnix(unixTs, timeZone) {
  const date = new Date(unixTs * 1000);
  const parts = getZonedParts(date, timeZone);
  const utcFromLocalMidnight = zonedTimeToUtcMs(timeZone, parts.year, parts.month, parts.day, 0, 0, 0);
  const weekday = parts.weekday ?? 0;
  const mondayUtc = utcFromLocalMidnight - ((weekday + 6) % 7) * 86400000;
  return new Date(mondayUtc).toISOString().slice(0, 10);
}

function formatRelativeDuration(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

function randomIntInclusive(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getNextWindowSchedule(
  now = new Date(),
  startHourLocal,
  endHourLocal,
  timeZone = "America/New_York"
) {
  const start = Number.isInteger(startHourLocal) ? startHourLocal : 18;
  const end = Number.isInteger(endHourLocal) ? endHourLocal : 23;
  const currentParts = getZonedParts(now, timeZone);
  const minHour = Math.min(start, end);
  const maxHour = Math.max(start, end);
  let targetYear = currentParts.year;
  let targetMonth = currentParts.month;
  let targetDay = currentParts.day;

  if (
    currentParts.hour > maxHour ||
    (currentParts.hour === maxHour &&
      (currentParts.minute > 55 || (currentParts.minute === 55 && currentParts.second > 0)))
  ) {
    const tomorrow = new Date(
      zonedTimeToUtcMs(timeZone, currentParts.year, currentParts.month, currentParts.day, 12, 0, 0) +
        86400000
    );
    const tomorrowParts = getZonedParts(tomorrow, timeZone);
    targetYear = tomorrowParts.year;
    targetMonth = tomorrowParts.month;
    targetDay = tomorrowParts.day;
  }

  let hour = randomIntInclusive(minHour, maxHour);
  let minute = randomIntInclusive(0, 59);
  let second = randomIntInclusive(0, 59);
  let scheduledMs = zonedTimeToUtcMs(timeZone, targetYear, targetMonth, targetDay, hour, minute, second);

  if (scheduledMs <= now.getTime()) {
    const nextDay = new Date(
      zonedTimeToUtcMs(timeZone, targetYear, targetMonth, targetDay, 12, 0, 0) + 86400000
    );
    const nextDayParts = getZonedParts(nextDay, timeZone);
    hour = randomIntInclusive(minHour, maxHour);
    minute = randomIntInclusive(0, 59);
    second = randomIntInclusive(0, 59);
    scheduledMs = zonedTimeToUtcMs(
      timeZone,
      nextDayParts.year,
      nextDayParts.month,
      nextDayParts.day,
      hour,
      minute,
      second
    );
  }

  return Math.floor(scheduledMs / 1000);
}

function getNextWeeklyRecapTime(
  now = new Date(),
  timeZone = "America/New_York",
  recapWeekday = 1,
  recapHour = 9
) {
  const currentParts = getZonedParts(now, timeZone);
  const daysAhead = (recapWeekday - currentParts.weekday + 7) % 7;
  let candidate = zonedTimeToUtcMs(
    timeZone,
    currentParts.year,
    currentParts.month,
    currentParts.day,
    recapHour,
    0,
    0
  );

  candidate += daysAhead * 86400000;
  if (candidate <= now.getTime()) {
    candidate += 7 * 86400000;
  }

  return Math.floor(candidate / 1000);
}

module.exports = {
  unixNow,
  isValidTimeZone,
  utcDateKeyFromUnix,
  getWeekKeyFromUnix,
  getZonedParts,
  getNextWeeklyRecapTime,
  zonedTimeToUtcMs,
  formatRelativeDuration,
  getNextWindowSchedule,
};
