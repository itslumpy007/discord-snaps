const { isValidTimeZone } = require("./time");

function sortMembers(members) {
  return [...members].sort((a, b) => {
    if ((b.bestStreak || 0) !== (a.bestStreak || 0)) {
      return (b.bestStreak || 0) - (a.bestStreak || 0);
    }

    return (b.totalOnTime || 0) - (a.totalOnTime || 0);
  });
}

class DashboardService {
  constructor(client, store, manager) {
    this.client = client;
    this.store = store;
    this.manager = manager;
  }

  listBotGuilds() {
    return [...this.client.guilds.cache.values()].map((guild) => ({
      id: guild.id,
      name: guild.name,
      iconURL: guild.iconURL(),
    }));
  }

  getManageableGuilds(userGuilds) {
    const botGuildIds = new Set(this.client.guilds.cache.keys());
    return userGuilds
      .filter((guild) => guild.canManage && botGuildIds.has(guild.id))
      .map((guild) => ({
        id: guild.id,
        name: guild.name,
        iconURL: guild.iconURL || null,
        config: this.store.getGuild(guild.id),
      }));
  }

  async getGuildOverview(guildId) {
    const guild = await this.client.guilds.fetch(guildId);
    const config = this.store.getGuild(guildId);
    const currentDrop = this.store.getCurrentDrop(guildId);
    const members = sortMembers(this.store.listGuildMembers(guildId));
    const channels = guild.channels.cache
      .filter((channel) => channel.isTextBased())
      .map((channel) => ({ id: channel.id, name: channel.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const roles = guild.roles.cache
      .filter((role) => role.name !== "@everyone")
      .map((role) => ({ id: role.id, name: role.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      guild: {
        id: guild.id,
        name: guild.name,
        iconURL: guild.iconURL(),
      },
      config,
      currentDrop,
      channels,
      roles,
      stats: {
        totalMembersTracked: members.length,
        totalOnTime: members.reduce((sum, member) => sum + (member.totalOnTime || 0), 0),
        totalLate: members.reduce((sum, member) => sum + (member.totalLate || 0), 0),
        totalMissed: members.reduce((sum, member) => sum + (member.totalMissed || 0), 0),
      },
      leaderboard: members.slice(0, 10),
      recentMembers: members.slice(0, 25),
      health: this.getHealthChecks(config, guild),
    };
  }

  getHealthChecks(config, guild) {
    const checks = [];

    checks.push({
      key: "channel",
      ok: Boolean(config.snapsChannelId && guild.channels.cache.has(config.snapsChannelId)),
      label: config.snapsChannelId ? "Snap channel configured" : "Snap channel missing",
    });
    checks.push({
      key: "role",
      ok: Boolean(config.snapsRoleId && guild.roles.cache.has(config.snapsRoleId)),
      label: config.snapsRoleId ? "Snap role configured" : "Snap role missing",
    });
    checks.push({
      key: "timezone",
      ok: isValidTimeZone(config.timeZone),
      label: config.timeZone ? `Timezone: ${config.timeZone}` : "Timezone missing",
    });
    checks.push({
      key: "schedule",
      ok: config.nextScheduledDropTs !== null || config.enabled === false,
      label: config.enabled ? "Next scheduled drop is set" : "Automation disabled",
    });

    return checks;
  }

  async updateGuildConfig(guildId, updates) {
    const next = {};

    if (updates.snapsChannelId !== undefined) {
      next.snapsChannelId = updates.snapsChannelId || null;
    }

    if (updates.snapsRoleId !== undefined) {
      next.snapsRoleId = updates.snapsRoleId || null;
    }

    if (updates.rewardRoleId !== undefined) {
      next.rewardRoleId = updates.rewardRoleId || null;
    }

    if (updates.timeZone !== undefined) {
      if (!isValidTimeZone(updates.timeZone)) {
        throw new Error("Invalid timezone.");
      }
      next.timeZone = updates.timeZone;
      next.nextScheduledDropTs = null;
      next.lastScheduledForDate = null;
    }

    if (updates.dailyWindowStartHourLocal !== undefined) {
      next.dailyWindowStartHourLocal = this.parseHour(updates.dailyWindowStartHourLocal, "Start hour");
      next.nextScheduledDropTs = null;
      next.lastScheduledForDate = null;
    }

    if (updates.dailyWindowEndHourLocal !== undefined) {
      next.dailyWindowEndHourLocal = this.parseHour(updates.dailyWindowEndHourLocal, "End hour");
      next.nextScheduledDropTs = null;
      next.lastScheduledForDate = null;
    }

    if (updates.dropDurationMinutes !== undefined) {
      next.dropDurationMinutes = this.parseRange(
        updates.dropDurationMinutes,
        "Drop duration",
        1,
        180
      );
    }

    if (updates.rewardThreshold !== undefined) {
      next.rewardThreshold = this.parseRange(updates.rewardThreshold, "Reward threshold", 1, 365);
    }

    if (updates.enabled !== undefined) {
      next.enabled = Boolean(updates.enabled);
      if (next.enabled) {
        next.nextScheduledDropTs = null;
        next.lastScheduledForDate = null;
      }
    }

    if (updates.weeklyRecapEnabled !== undefined) {
      next.weeklyRecapEnabled = Boolean(updates.weeklyRecapEnabled);
    }

    if (updates.reminderMinutesBeforeEnd !== undefined) {
      next.reminderMinutesBeforeEnd = this.parseReminders(updates.reminderMinutesBeforeEnd);
    }

    const updated = this.store.updateGuild(guildId, next);
    if (updated.enabled) {
      this.manager.ensureScheduledDrop(guildId);
    }

    return updated;
  }

  parseHour(value, label) {
    return this.parseRange(value, label, 0, 23);
  }

  parseRange(value, label, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      throw new Error(`${label} must be between ${min} and ${max}.`);
    }

    return parsed;
  }

  parseReminders(values) {
    const normalized = Array.isArray(values) ? values : String(values).split(",");
    const parsed = normalized
      .map((value) => Number.parseInt(String(value).trim(), 10))
      .filter((value) => Number.isInteger(value) && value > 0)
      .sort((a, b) => b - a);

    if (parsed.length === 0) {
      throw new Error("At least one reminder minute is required.");
    }

    return parsed;
  }

  async runAction(guildId, action, payload = {}) {
    if (action === "manual-drop") {
      return this.manager.startDrop(guildId, {
        forcedByUserId: payload.userId || null,
        isScheduled: false,
      });
    }

    if (action === "close-drop") {
      const currentDrop = this.store.getCurrentDrop(guildId);
      if (!currentDrop?.active) {
        throw new Error("There is no active drop to close.");
      }

      currentDrop.endTs = Math.floor(Date.now() / 1000);
      this.store.setCurrentDrop(guildId, currentDrop);
      return this.manager.finalizeDrop(guildId);
    }

    if (action === "extend-drop") {
      return this.manager.extendDrop(guildId, this.parseRange(payload.minutes, "Extension", 1, 60));
    }

    if (action === "reopen-drop") {
      return this.manager.reopenLastClosedDrop(guildId);
    }

    if (action === "reroll-drop") {
      this.store.updateGuild(guildId, {
        nextScheduledDropTs: null,
        lastScheduledForDate: null,
      });

      return this.manager.ensureScheduledDrop(guildId);
    }

    if (action === "post-recap") {
      const sent = await this.manager.maybeSendWeeklyRecap(guildId, true);
      return { sent };
    }

    throw new Error("Unknown action.");
  }

  exportGuildData(guildId) {
    return {
      exportedAt: new Date().toISOString(),
      guildId,
      config: this.store.getGuild(guildId),
      currentDrop: this.store.getCurrentDrop(guildId),
      members: this.store.listGuildMembers(guildId),
    };
  }
}

module.exports = {
  DashboardService,
};
