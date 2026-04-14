const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { buildBaseEmbed, ensureDropThread, mentionRole } = require("./discord-utils");
const {
  unixNow,
  utcDateKeyFromUnix,
  formatRelativeDuration,
  getNextWeeklyRecapTime,
  getNextWindowSchedule,
  getWeekKeyFromUnix,
} = require("./time");

class SnapManager {
  constructor(client, store) {
    this.client = client;
    this.store = store;
    this.activeTimers = new Map();
    this.reminderTimers = new Map();
  }

  scheduleExistingDrops() {
    for (const [guildId, drop] of Object.entries(this.store.getState().currentDrops)) {
      if (drop?.active) {
        this.queueDropExpiration(guildId, drop);
        this.queueReminders(guildId, drop);
      }
    }
  }

  ensureScheduledDrop(guildId) {
    const guild = this.store.getGuild(guildId);

    if (!guild.enabled || !guild.snapsChannelId) {
      return guild;
    }

    const todayKey = utcDateKeyFromUnix(unixNow());
    const scheduledCount = Array.isArray(guild.scheduledDropHistory)
      ? guild.scheduledDropHistory.filter((key) => key === todayKey).length
      : 0;

    if (scheduledCount >= guild.dropsPerDay) {
      return this.store.updateGuild(guildId, {
        nextScheduledDropTs: null,
      });
    }

    if (guild.lastScheduledForDate === todayKey && guild.nextScheduledDropTs) {
      return guild;
    }

    const nextScheduledDropTs = getNextWindowSchedule(
      new Date(),
      guild.dailyWindowStartHourLocal,
      guild.dailyWindowEndHourLocal,
      guild.timeZone
    );

    return this.store.updateGuild(guildId, {
      nextScheduledDropTs,
      lastScheduledForDate: utcDateKeyFromUnix(nextScheduledDropTs),
      scheduledDropHistory: [...(guild.scheduledDropHistory || []), utcDateKeyFromUnix(nextScheduledDropTs)].slice(-30),
    });
  }

  async tickScheduler() {
    const allGuildIds = Object.keys(this.store.getState().guilds);

    for (const guildId of allGuildIds) {
      const guild = this.ensureScheduledDrop(guildId);

      if (!guild.enabled || !guild.snapsChannelId || !guild.nextScheduledDropTs) {
        continue;
      }

      if (this.store.getCurrentDrop(guildId)?.active) {
        continue;
      }

      if (guild.nextScheduledDropTs <= unixNow()) {
        await this.startDrop(guildId, {
          forcedByUserId: null,
          isScheduled: true,
        });
      }

      if (guild.weeklyRecapEnabled) {
        await this.maybeSendWeeklyRecap(guildId);
      }
    }
  }

  async startDrop(guildId, options = {}) {
    const guildConfig = this.store.getGuild(guildId);
    const guild = await this.client.guilds.fetch(guildId).catch(() => null);

    if (!guild) {
      throw new Error("Guild is not available to the bot.");
    }

    if (!guildConfig.snapsChannelId) {
      throw new Error("Snaps channel is not configured.");
    }

    const channel = await guild.channels.fetch(guildConfig.snapsChannelId).catch(() => null);

    if (!channel || !channel.isTextBased()) {
      throw new Error("Configured snaps channel is missing or not text-based.");
    }

    const existingDrop = this.store.getCurrentDrop(guildId);
    if (existingDrop?.active) {
      return existingDrop;
    }

    const startTs = unixNow();
    const endTs = startTs + guildConfig.dropDurationMinutes * 60;
    const roleText = mentionRole(guildConfig.snapsRoleId);

    const embed = buildBaseEmbed("Time to BeReal")
      .setDescription(
        `${roleText} it's time to post.\n\nDrop one real photo or video in the thread before <t:${endTs}:R>.`
      )
      .addFields(
        { name: "BeReal Window", value: `${guildConfig.dropDurationMinutes} minute(s)`, inline: true },
        {
          name: "Moment",
          value: options.isScheduled ? "Random daily drop" : "Manual drop",
          inline: true,
        }
      );
    const controls = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("snap:snooze").setLabel("Snooze").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("snap:mystats").setLabel("My Stats").setStyle(ButtonStyle.Primary)
    );

    const announcement = await channel.send({
      content: roleText,
      embeds: [embed],
      components: [controls],
      allowedMentions: guildConfig.snapsRoleId ? { roles: [guildConfig.snapsRoleId] } : undefined,
    });

    const thread = await ensureDropThread(channel, announcement, `snap-drop-${startTs}`);
    const drop = {
      id: `${guildId}-${startTs}`,
      guildId,
      active: true,
      startTs,
      endTs,
      channelId: channel.id,
      messageId: announcement.id,
      threadId: thread.id,
      roleId: guildConfig.snapsRoleId,
      forcedByUserId: options.forcedByUserId || null,
      submissions: {},
      skipped: [],
      snoozed: [],
    };

    this.store.setCurrentDrop(guildId, drop);
    this.store.updateGuild(guildId, {
      nextScheduledDropTs: null,
    });
    this.queueDropExpiration(guildId, drop);
    this.queueReminders(guildId, drop);

    return drop;
  }

  queueDropExpiration(guildId, drop) {
    if (this.activeTimers.has(guildId)) {
      clearTimeout(this.activeTimers.get(guildId));
    }

    const delay = Math.max(0, drop.endTs * 1000 - Date.now());
    const timer = setTimeout(() => {
      this.finalizeDrop(guildId).catch((error) => {
        console.error(`Failed to finalize drop for guild ${guildId}:`, error);
      });
    }, delay);

    this.activeTimers.set(guildId, timer);
  }

  clearReminderTimers(guildId) {
    if (!this.reminderTimers.has(guildId)) {
      return;
    }

    for (const timer of this.reminderTimers.get(guildId)) {
      clearTimeout(timer);
    }

    this.reminderTimers.delete(guildId);
  }

  queueReminders(guildId, drop) {
    this.clearReminderTimers(guildId);
    const guildConfig = this.store.getGuild(guildId);
    const timers = [];

    for (const minutes of guildConfig.reminderMinutesBeforeEnd) {
      const delay = drop.endTs * 1000 - Date.now() - minutes * 60 * 1000;
      if (delay <= 0) {
        continue;
      }

      const timer = setTimeout(() => {
        this.sendReminder(guildId, drop.id, minutes).catch((error) => {
          console.error(`Failed to send reminder for guild ${guildId}:`, error);
        });
      }, delay);
      timers.push(timer);
    }

    this.reminderTimers.set(guildId, timers);
  }

  async sendReminder(guildId, dropId, minutes) {
    const drop = this.store.getCurrentDrop(guildId);
    if (!drop || !drop.active || drop.id !== dropId) {
      return;
    }

    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    const thread = guild ? await guild.channels.fetch(drop.threadId).catch(() => null) : null;
    if (!thread || !thread.isTextBased()) {
      return;
    }

    await thread.send({
      embeds: [
        buildBaseEmbed("BeReal Reminder")
          .setDescription(`There ${minutes === 1 ? "is" : "are"} **${minutes} minute${minutes === 1 ? "" : "s"}** left to post your BeReal.`),
      ],
    }).catch(() => {});
  }

  async finalizeDrop(guildId) {
    const drop = this.store.getCurrentDrop(guildId);
    if (!drop || !drop.active) {
      return null;
    }

    if (this.activeTimers.has(guildId)) {
      clearTimeout(this.activeTimers.get(guildId));
      this.activeTimers.delete(guildId);
    }
    this.clearReminderTimers(guildId);

    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    const thread = guild ? await guild.channels.fetch(drop.threadId).catch(() => null) : null;
    const submittedIds = new Set(Object.keys(drop.submissions || {}));

    if (drop.roleId && guild) {
      const role = await guild.roles.fetch(drop.roleId).catch(() => null);
      if (role) {
        for (const member of role.members.values()) {
          if (!submittedIds.has(member.id) && !(drop.snoozed || []).includes(member.id)) {
            if (!(drop.skipped || []).includes(member.id)) {
              drop.skipped.push(member.id);
            }

            this.store.upsertMember(guildId, member.id, member.displayName, (entry) => {
              entry.streak = 0;
              entry.totalMissed += 1;
              entry.lastAnyDate = utcDateKeyFromUnix(drop.endTs);
            });
          }
        }
      }
    }

    drop.active = false;
    this.store.updateGuild(guildId, { lastClosedDrop: drop });
    this.store.clearCurrentDrop(guildId);
    this.ensureScheduledDrop(guildId);

    if (thread && thread.isTextBased()) {
      const embed = buildBaseEmbed("BeReal Window Closed")
        .setDescription("Today's BeReal window has ended.")
        .addFields(
          { name: "Submitted", value: `${Object.keys(drop.submissions || {}).length}`, inline: true },
          { name: "Skipped", value: `${(drop.skipped || []).length}`, inline: true },
          { name: "Snoozed", value: `${(drop.snoozed || []).length}`, inline: true }
        );

      await thread.send({ embeds: [embed] }).catch(() => {});
      await thread.setArchived(true).catch(() => {});
      await thread.setLocked(true).catch(() => {});
    }

    return drop;
  }

  async recordSubmission(message) {
    if (!message.guild || message.author.bot) {
      return false;
    }

    const drop = this.store.getCurrentDrop(message.guild.id);
    if (!drop || !drop.active) {
      return false;
    }

    if (message.channel.id !== drop.threadId && message.channel.id !== drop.channelId) {
      return false;
    }

    if (message.attachments.size === 0) {
      await message.reply("Attach at least one photo or video for your BeReal.").catch(() => {});
      return true;
    }

    if (drop.submissions[message.author.id]) {
      await message.reply("You already posted for this BeReal moment.").catch(() => {});
      return true;
    }

    const isLate = unixNow() > drop.endTs;
    const displayName = message.member?.displayName || message.author.username;
    const dayKey = utcDateKeyFromUnix(drop.endTs);

    drop.submissions[message.author.id] = {
      messageId: message.id,
      submittedAtTs: unixNow(),
      displayName,
      late: isLate,
    };
    drop.skipped = (drop.skipped || []).filter((userId) => userId !== message.author.id);
    drop.snoozed = (drop.snoozed || []).filter((userId) => userId !== message.author.id);
    this.store.setCurrentDrop(message.guild.id, drop);

    this.store.upsertMember(message.guild.id, message.author.id, displayName, (entry) => {
      entry.lastAnyDate = dayKey;

      if (isLate) {
        entry.totalLate += 1;
        entry.streak = 0;
        return;
      }

      entry.totalOnTime += 1;
      if (!entry.lastOnTimeDate) {
        entry.streak = 1;
      } else if (entry.lastOnTimeDate === utcDateKeyFromUnix(drop.endTs - 86400)) {
        entry.streak += 1;
      } else if (entry.lastOnTimeDate !== dayKey) {
        entry.streak = 1;
      }

      entry.lastOnTimeDate = dayKey;
      entry.bestStreak = Math.max(entry.bestStreak || 0, entry.streak);
    });

    await this.syncRewardRole(message.guild.id, message.author.id).catch(() => {});

    if (!isLate) {
      await this.maybeCelebrateMilestone(message, message.guild.id, message.author.id).catch(() => {});
    }

    const timeLeftMs = Math.max(0, drop.endTs * 1000 - Date.now());
    await message
      .reply(
        isLate
          ? "Logged as a late BeReal."
          : `BeReal locked in with ${formatRelativeDuration(timeLeftMs)} left in the window.`
      )
      .catch(() => {});

    return true;
  }

  async snoozeMember(interaction) {
    const drop = this.store.getCurrentDrop(interaction.guildId);
    if (!drop || !drop.active) {
      throw new Error("There is no active drop to snooze.");
    }

    if (!drop.snoozed.includes(interaction.user.id)) {
      drop.snoozed.push(interaction.user.id);
      this.store.setCurrentDrop(interaction.guildId, drop);
    }
  }

  async extendDrop(guildId, minutes) {
    const drop = this.store.getCurrentDrop(guildId);
    if (!drop || !drop.active) {
      throw new Error("There is no active drop to extend.");
    }

    drop.endTs += minutes * 60;
    this.store.setCurrentDrop(guildId, drop);
    this.queueDropExpiration(guildId, drop);
    this.queueReminders(guildId, drop);
    return drop;
  }

  async reopenLastClosedDrop(guildId) {
    const guildConfig = this.store.getGuild(guildId);
    const lastDrop = guildConfig.lastClosedDrop;

    if (!lastDrop) {
      throw new Error("There is no recently closed drop to reopen.");
    }

    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
      throw new Error("Guild is not available to the bot.");
    }

    const thread = await guild.channels.fetch(lastDrop.threadId).catch(() => null);
    if (thread) {
      await thread.setArchived(false).catch(() => {});
      await thread.setLocked(false).catch(() => {});
      await thread.send({ embeds: [buildBaseEmbed("BeReal Reopened").setDescription("This BeReal moment has been reopened by an admin.")] }).catch(() => {});
    }

    const reopened = {
      ...lastDrop,
      active: true,
      endTs: unixNow() + 5 * 60,
      skipped: [],
      snoozed: [],
    };
    this.store.setCurrentDrop(guildId, reopened);
    this.queueDropExpiration(guildId, reopened);
    this.queueReminders(guildId, reopened);
    return reopened;
  }

  async maybeCelebrateMilestone(message, guildId, userId) {
    const member = this.store.getMember(guildId, userId);
    const milestones = [3, 7, 14, 30];

    if (!milestones.includes(member.streak)) {
      return;
    }

    await message.channel
      .send({
        embeds: [
          buildBaseEmbed("BeReal Streak")
            .setDescription(`<@${userId}> just hit a **${member.streak}-day** on-time streak.`),
        ],
      })
      .catch(() => {});
  }

  async syncRewardRole(guildId, userId) {
    const guildConfig = this.store.getGuild(guildId);
    if (!guildConfig.rewardRoleId) {
      return;
    }

    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
      return;
    }

    const role = await guild.roles.fetch(guildConfig.rewardRoleId).catch(() => null);
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!role || !member) {
      return;
    }

    const stats = this.store.getMember(guildId, userId, member.displayName);
    const qualifies = stats.streak >= guildConfig.rewardThreshold;

    if (qualifies && !member.roles.cache.has(role.id)) {
      await member.roles.add(role).catch(() => {});
    }

    if (!qualifies && member.roles.cache.has(role.id)) {
      await member.roles.remove(role).catch(() => {});
    }
  }

  async maybeSendWeeklyRecap(guildId, force = false) {
    const guildConfig = this.store.getGuild(guildId);
    if (!guildConfig.weeklyRecapEnabled || !guildConfig.snapsChannelId) {
      return;
    }

    const nextRecapTs = getNextWeeklyRecapTime(
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      guildConfig.timeZone
    );

    if (!force && unixNow() < nextRecapTs) {
      return;
    }

    const currentWeekKey = getWeekKeyFromUnix(unixNow(), guildConfig.timeZone);
    if (!force && guildConfig.lastWeeklyRecapWeekKey === currentWeekKey) {
      return;
    }

    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    const channel = guild ? await guild.channels.fetch(guildConfig.snapsChannelId).catch(() => null) : null;
    if (!channel || !channel.isTextBased()) {
      return false;
    }

    const members = this.store
      .listGuildMembers(guildId)
      .sort((a, b) => (b.totalOnTime || 0) - (a.totalOnTime || 0))
      .slice(0, 5);

    await channel.send({
      embeds: [
        buildBaseEmbed("Weekly BeReal Recap").setDescription(
          members.length > 0
            ? members
                .map(
                  (member, index) =>
                    `**${index + 1}.** ${member.displayName} - on-time ${member.totalOnTime || 0}, best streak ${member.bestStreak || 0}`
                )
                .join("\n")
            : "No snap activity recorded yet."
        ),
      ],
    }).catch(() => {});

    this.store.updateGuild(guildId, {
      lastWeeklyRecapWeekKey: currentWeekKey,
    });
    return true;
  }

  resetGuildState(guildId) {
    if (this.activeTimers.has(guildId)) {
      clearTimeout(this.activeTimers.get(guildId));
      this.activeTimers.delete(guildId);
    }

    this.clearReminderTimers(guildId);
    this.store.resetGuild(guildId);
  }
}

module.exports = {
  SnapManager,
};
