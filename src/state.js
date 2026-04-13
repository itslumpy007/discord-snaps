const fs = require("node:fs");
const path = require("node:path");

function createEmptyState() {
  return {
    guilds: {},
    members: {},
    currentDrops: {},
  };
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

function ensureStateShape(state) {
  const next = state && typeof state === "object" ? cloneState(state) : createEmptyState();

  next.guilds = next.guilds && typeof next.guilds === "object" ? next.guilds : {};
  next.members = next.members && typeof next.members === "object" ? next.members : {};
  next.currentDrops =
    next.currentDrops && typeof next.currentDrops === "object" ? next.currentDrops : {};

  return next;
}

class StateStore {
  constructor(filePath, defaults) {
    this.filePath = filePath;
    this.defaults = defaults;
    this.state = createEmptyState();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      this.state = ensureStateShape(JSON.parse(raw));
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }

      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.state = createEmptyState();
      this.save();
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  getState() {
    return this.state;
  }

  getGuild(guildId) {
    if (!this.state.guilds[guildId]) {
      this.state.guilds[guildId] = {
        snapsChannelId: null,
        snapsRoleId: null,
        enabled: true,
        nextScheduledDropTs: null,
        lastScheduledForDate: null,
        dropDurationMinutes: this.defaults.dropDurationMinutes,
        timeZone: this.defaults.defaultTimeZone,
        dailyWindowStartHourLocal: this.defaults.dailyWindowStartHourLocal,
        dailyWindowEndHourLocal: this.defaults.dailyWindowEndHourLocal,
        reminderMinutesBeforeEnd: [...this.defaults.reminderMinutesBeforeEnd],
        weeklyRecapEnabled: true,
        lastWeeklyRecapWeekKey: null,
        rewardRoleId: null,
        rewardThreshold: this.defaults.rewardThreshold,
        joinRoleId: null,
        lastClosedDrop: null,
      };
      this.save();
    }

    const guild = this.state.guilds[guildId];
    guild.enabled = guild.enabled !== false;
    guild.nextScheduledDropTs = guild.nextScheduledDropTs ?? null;
    guild.lastScheduledForDate = guild.lastScheduledForDate ?? null;
    guild.timeZone = guild.timeZone || this.defaults.defaultTimeZone;
    guild.dropDurationMinutes =
      Number.isInteger(guild.dropDurationMinutes) && guild.dropDurationMinutes > 0
        ? guild.dropDurationMinutes
        : this.defaults.dropDurationMinutes;
    guild.dailyWindowStartHourLocal =
      Number.isInteger(guild.dailyWindowStartHourLocal) &&
      guild.dailyWindowStartHourLocal >= 0 &&
      guild.dailyWindowStartHourLocal <= 23
        ? guild.dailyWindowStartHourLocal
        : Number.isInteger(guild.dailyWindowStartHourUtc)
          ? guild.dailyWindowStartHourUtc
          : this.defaults.dailyWindowStartHourLocal;
    guild.dailyWindowEndHourLocal =
      Number.isInteger(guild.dailyWindowEndHourLocal) &&
      guild.dailyWindowEndHourLocal >= 0 &&
      guild.dailyWindowEndHourLocal <= 23
        ? guild.dailyWindowEndHourLocal
        : Number.isInteger(guild.dailyWindowEndHourUtc)
          ? guild.dailyWindowEndHourUtc
          : this.defaults.dailyWindowEndHourLocal;
    guild.reminderMinutesBeforeEnd = Array.isArray(guild.reminderMinutesBeforeEnd)
      ? guild.reminderMinutesBeforeEnd.filter((value) => Number.isInteger(value) && value > 0).sort((a, b) => b - a)
      : [...this.defaults.reminderMinutesBeforeEnd];
    guild.weeklyRecapEnabled = guild.weeklyRecapEnabled !== false;
    guild.lastWeeklyRecapWeekKey = guild.lastWeeklyRecapWeekKey ?? null;
    guild.rewardRoleId = guild.rewardRoleId ?? null;
    guild.joinRoleId = guild.joinRoleId ?? null;
    guild.rewardThreshold =
      Number.isInteger(guild.rewardThreshold) && guild.rewardThreshold > 0
        ? guild.rewardThreshold
        : this.defaults.rewardThreshold;
    guild.lastClosedDrop = guild.lastClosedDrop ?? null;

    return guild;
  }

  updateGuild(guildId, updates) {
    const guild = this.getGuild(guildId);
    Object.assign(guild, updates);
    this.save();
    return guild;
  }

  getCurrentDrop(guildId) {
    return this.state.currentDrops[guildId] || null;
  }

  setCurrentDrop(guildId, drop) {
    this.state.currentDrops[guildId] = drop;
    this.save();
  }

  clearCurrentDrop(guildId) {
    delete this.state.currentDrops[guildId];
    this.save();
  }

  getMemberKey(guildId, userId) {
    return `${guildId}:${userId}`;
  }

  getMember(guildId, userId, displayName = "Unknown User") {
    const key = this.getMemberKey(guildId, userId);

    if (!this.state.members[key]) {
      this.state.members[key] = {
        guildId,
        userId,
        displayName,
        streak: 0,
        bestStreak: 0,
        lastOnTimeDate: null,
        lastAnyDate: null,
        totalOnTime: 0,
        totalLate: 0,
        totalMissed: 0,
      };
      this.save();
    }

    const member = this.state.members[key];
    member.displayName = displayName || member.displayName;
    member.bestStreak = member.bestStreak || 0;
    member.totalMissed = member.totalMissed || 0;
    return member;
  }

  upsertMember(guildId, userId, displayName, updater) {
    const member = this.getMember(guildId, userId, displayName);
    updater(member);
    this.save();
    return member;
  }

  listGuildMembers(guildId) {
    return Object.values(this.state.members).filter((member) => member.guildId === guildId);
  }

  resetGuild(guildId) {
    delete this.state.guilds[guildId];
    delete this.state.currentDrops[guildId];

    for (const key of Object.keys(this.state.members)) {
      if (this.state.members[key]?.guildId === guildId) {
        delete this.state.members[key];
      }
    }

    this.save();
  }
}

module.exports = {
  StateStore,
};
