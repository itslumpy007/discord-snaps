const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { DEFAULTS } = require("../src/config");
const { StateStore } = require("../src/state");

test("state store creates and normalizes guild defaults", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discord-snaps-"));
  const filePath = path.join(tempDir, "state.json");
  const store = new StateStore(filePath, DEFAULTS);

  store.load();
  const guild = store.getGuild("guild-1");

  assert.equal(guild.timeZone, DEFAULTS.defaultTimeZone);
  assert.deepEqual(guild.reminderMinutesBeforeEnd, DEFAULTS.reminderMinutesBeforeEnd);
  assert.equal(guild.weeklyRecapEnabled, true);
  assert.equal(guild.rewardThreshold, DEFAULTS.rewardThreshold);
});

test("member upserts persist streak fields", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discord-snaps-"));
  const filePath = path.join(tempDir, "state.json");
  const store = new StateStore(filePath, DEFAULTS);

  store.load();
  store.upsertMember("guild-1", "user-1", "Test User", (member) => {
    member.streak = 4;
    member.bestStreak = 5;
    member.totalOnTime = 7;
  });

  const member = store.getMember("guild-1", "user-1", "Test User");
  assert.equal(member.streak, 4);
  assert.equal(member.bestStreak, 5);
  assert.equal(member.totalOnTime, 7);
});
