const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getNextWeeklyRecapTime,
  getNextWindowSchedule,
  getWeekKeyFromUnix,
  getZonedParts,
  isValidTimeZone,
} = require("../src/time");

test("validates IANA timezones", () => {
  assert.equal(isValidTimeZone("America/New_York"), true);
  assert.equal(isValidTimeZone("Mars/Olympus"), false);
});

test("schedules next window in the future using local time", () => {
  const now = new Date("2026-04-12T15:00:00.000Z");
  const scheduled = getNextWindowSchedule(now, 12, 18, "America/New_York");
  assert.ok(scheduled > Math.floor(now.getTime() / 1000));

  const parts = getZonedParts(new Date(scheduled * 1000), "America/New_York");
  assert.ok(parts.hour >= 12 && parts.hour <= 18);
});

test("builds stable week keys in local time", () => {
  const ts = Math.floor(new Date("2026-04-13T14:00:00.000Z").getTime() / 1000);
  assert.equal(getWeekKeyFromUnix(ts, "America/New_York"), "2026-04-13");
});

test("calculates next weekly recap in the future", () => {
  const now = new Date("2026-04-12T15:00:00.000Z");
  const recapTs = getNextWeeklyRecapTime(now, "America/New_York");
  assert.ok(recapTs > Math.floor(now.getTime() / 1000));
});
