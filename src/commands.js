const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require("discord.js");
const { buildBaseEmbed } = require("./discord-utils");
const { formatRelativeDuration, isValidTimeZone, unixNow } = require("./time");

function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName("snapsetup")
      .setDescription("Configure the snap channel, role, timezone, and schedule for this server")
      .addChannelOption((option) =>
        option.setName("channel").setDescription("Channel where drops should be posted").setRequired(false)
      )
      .addRoleOption((option) =>
        option.setName("role").setDescription("Role to ping for each drop").setRequired(false)
      )
      .addStringOption((option) =>
        option.setName("timezone").setDescription("IANA timezone like America/New_York").setRequired(false)
      )
      .addIntegerOption((option) =>
        option.setName("start_hour").setDescription("Local start hour (0-23)").setRequired(false)
      )
      .addIntegerOption((option) =>
        option.setName("end_hour").setDescription("Local end hour (0-23)").setRequired(false)
      )
      .addIntegerOption((option) =>
        option.setName("duration_minutes").setDescription("Drop duration in minutes").setRequired(false)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName("snapwindow")
      .setDescription("Set the local-time daily window used for automatic drops")
      .addIntegerOption((option) =>
        option.setName("start_hour").setDescription("Local start hour (0-23)").setRequired(true)
      )
      .addIntegerOption((option) =>
        option.setName("end_hour").setDescription("Local end hour (0-23)").setRequired(true)
      )
      .addIntegerOption((option) =>
        option.setName("duration_minutes").setDescription("Drop duration in minutes").setRequired(false)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName("snaptimezone")
      .setDescription("Set the server timezone used for scheduling and recaps")
      .addStringOption((option) =>
        option.setName("timezone").setDescription("IANA timezone like America/Chicago").setRequired(true)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName("snapreminders")
      .setDescription("Set reminder times in minutes before a drop closes")
      .addStringOption((option) =>
        option.setName("minutes").setDescription("Comma-separated values like 10,5,1").setRequired(true)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName("snaptoggle")
      .setDescription("Enable or disable automatic snap drops")
      .addBooleanOption((option) =>
        option.setName("enabled").setDescription("Whether automatic drops are enabled").setRequired(true)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName("snapdrop")
      .setDescription("Start a manual snap drop right now")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName("snapclose")
      .setDescription("Close the current snap drop early")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName("snapextend")
      .setDescription("Extend the active drop by a few minutes")
      .addIntegerOption((option) =>
        option.setName("minutes").setDescription("Minutes to add").setRequired(true)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName("snapreopen")
      .setDescription("Reopen the most recently closed drop for 5 minutes")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName("snapreroll")
      .setDescription("Reroll the next automatic drop time")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName("snaprewardrole")
      .setDescription("Configure a streak reward role")
      .addRoleOption((option) =>
        option.setName("role").setDescription("Role to award on qualifying streaks").setRequired(true)
      )
      .addIntegerOption((option) =>
        option.setName("threshold").setDescription("Minimum streak needed").setRequired(true)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName("snapjoinrole")
      .setDescription("Configure the opt-in join role for members")
      .addRoleOption((option) =>
        option.setName("role").setDescription("Role members receive with /snapjoin").setRequired(true)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName("snapconfig")
      .setDescription("View the current server snap configuration"),
    new SlashCommandBuilder()
      .setName("snapstats")
      .setDescription("View your snap stats or another member's")
      .addUserOption((option) =>
        option.setName("user").setDescription("User to inspect").setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("snapleaderboard")
      .setDescription("Show the top snap streaks in this server"),
    new SlashCommandBuilder()
      .setName("snapjoin")
      .setDescription("Join the snap role for this server"),
    new SlashCommandBuilder()
      .setName("snapleave")
      .setDescription("Leave the snap role for this server"),
    new SlashCommandBuilder()
      .setName("snapsnooze")
      .setDescription("Mark yourself snoozed for the currently active drop"),
    new SlashCommandBuilder()
      .setName("snapexport")
      .setDescription("Export this server's snap stats as JSON")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName("snaprecap")
      .setDescription("Post a weekly recap immediately")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName("snapreset")
      .setDescription("Reset this server's snap bot state")
      .addStringOption((option) =>
        option
          .setName("confirm")
          .setDescription("Type RESET to confirm wiping this server's snap data")
          .setRequired(true)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  ].map((command) => command.toJSON());
}

async function handleCommand(interaction, manager, store) {
  if (!interaction.isChatInputCommand() || !interaction.guildId) {
    return false;
  }

  const guildConfig = store.getGuild(interaction.guildId);

  if (interaction.commandName === "snapsetup") {
    const channel = interaction.options.getChannel("channel");
    const role = interaction.options.getRole("role");
    const timeZone = interaction.options.getString("timezone");
    const startHour = interaction.options.getInteger("start_hour");
    const endHour = interaction.options.getInteger("end_hour");
    const durationMinutes = interaction.options.getInteger("duration_minutes");

    if (!channel && !role && !timeZone && startHour === null && endHour === null && durationMinutes === null) {
      const checklist = [
        guildConfig.snapsChannelId ? "Channel configured" : "Channel missing",
        guildConfig.snapsRoleId ? "Role configured" : "Role missing",
        guildConfig.timeZone ? `Timezone: ${guildConfig.timeZone}` : "Timezone missing",
        `Window: ${guildConfig.dailyWindowStartHourLocal}:00-${guildConfig.dailyWindowEndHourLocal}:59`,
        `Duration: ${guildConfig.dropDurationMinutes} minute(s)`,
      ];
      await interaction.reply({
        embeds: [
          buildBaseEmbed("Snap Setup Guide").setDescription(checklist.map((line) => `- ${line}`).join("\n")),
        ],
        ephemeral: true,
      });
      return true;
    }

    if (timeZone && !isValidTimeZone(timeZone)) {
      await interaction.reply({ content: "That timezone is not valid. Use an IANA timezone like America/New_York.", ephemeral: true });
      return true;
    }

    store.updateGuild(interaction.guildId, {
      snapsChannelId: channel?.id ?? guildConfig.snapsChannelId,
      snapsRoleId: role?.id ?? guildConfig.snapsRoleId,
      timeZone: timeZone ?? guildConfig.timeZone,
      dailyWindowStartHourLocal: startHour ?? guildConfig.dailyWindowStartHourLocal,
      dailyWindowEndHourLocal: endHour ?? guildConfig.dailyWindowEndHourLocal,
      dropDurationMinutes: durationMinutes ?? guildConfig.dropDurationMinutes,
      nextScheduledDropTs: null,
      lastScheduledForDate: null,
    });
    manager.ensureScheduledDrop(interaction.guildId);

    await interaction.reply(
      `Snap 2.0 is configured with ${channel ?? (guildConfig.snapsChannelId ? `<#${guildConfig.snapsChannelId}>` : "no channel yet")}, ${role ?? (guildConfig.snapsRoleId ? `<@&${guildConfig.snapsRoleId}>` : "no role yet")}, timezone **${timeZone ?? guildConfig.timeZone}**, and a ${startHour ?? guildConfig.dailyWindowStartHourLocal}:00-${endHour ?? guildConfig.dailyWindowEndHourLocal}:59 window.`
    );
    return true;
  }

  if (interaction.commandName === "snapwindow") {
    const startHour = interaction.options.getInteger("start_hour", true);
    const endHour = interaction.options.getInteger("end_hour", true);
    const durationMinutes = interaction.options.getInteger("duration_minutes") ?? guildConfig.dropDurationMinutes;

    if (startHour < 0 || startHour > 23 || endHour < 0 || endHour > 23) {
      await interaction.reply({ content: "Hours must be between 0 and 23 UTC.", ephemeral: true });
      return true;
    }

    if (durationMinutes < 1 || durationMinutes > 180) {
      await interaction.reply({ content: "Duration must be between 1 and 180 minutes.", ephemeral: true });
      return true;
    }

    store.updateGuild(interaction.guildId, {
      dailyWindowStartHourLocal: startHour,
      dailyWindowEndHourLocal: endHour,
      dropDurationMinutes: durationMinutes,
      nextScheduledDropTs: null,
      lastScheduledForDate: null,
    });
    const next = manager.ensureScheduledDrop(interaction.guildId);

    await interaction.reply(
      `Daily window updated to ${startHour}:00-${endHour}:59 in **${store.getGuild(interaction.guildId).timeZone}** with ${durationMinutes} minute drops. Next auto drop: <t:${next.nextScheduledDropTs}:F>.`
    );
    return true;
  }

  if (interaction.commandName === "snaptimezone") {
    const timeZone = interaction.options.getString("timezone", true);
    if (!isValidTimeZone(timeZone)) {
      await interaction.reply({ content: "That timezone is not valid. Use an IANA timezone like America/Los_Angeles.", ephemeral: true });
      return true;
    }

    store.updateGuild(interaction.guildId, {
      timeZone,
      nextScheduledDropTs: null,
      lastScheduledForDate: null,
    });
    const next = manager.ensureScheduledDrop(interaction.guildId);
    await interaction.reply(`Timezone updated to **${timeZone}**. Next auto drop: <t:${next.nextScheduledDropTs}:F>.`);
    return true;
  }

  if (interaction.commandName === "snapreminders") {
    const raw = interaction.options.getString("minutes", true);
    const minutes = raw
      .split(",")
      .map((value) => Number.parseInt(value.trim(), 10))
      .filter((value) => Number.isInteger(value) && value > 0)
      .sort((a, b) => b - a);

    if (minutes.length === 0) {
      await interaction.reply({ content: "Provide at least one positive whole minute, like `10,5,1`.", ephemeral: true });
      return true;
    }

    store.updateGuild(interaction.guildId, {
      reminderMinutesBeforeEnd: minutes,
    });

    await interaction.reply(`Reminder schedule updated to **${minutes.join(", ")}** minute(s) before close.`);
    return true;
  }

  if (interaction.commandName === "snaptoggle") {
    const enabled = interaction.options.getBoolean("enabled", true);
    store.updateGuild(interaction.guildId, { enabled, nextScheduledDropTs: enabled ? null : guildConfig.nextScheduledDropTs });

    if (enabled) {
      manager.ensureScheduledDrop(interaction.guildId);
    }

    await interaction.reply(`Automatic snap drops are now ${enabled ? "enabled" : "disabled"}.`);
    return true;
  }

  if (interaction.commandName === "snapdrop") {
    try {
      const drop = await manager.startDrop(interaction.guildId, {
        forcedByUserId: interaction.user.id,
        isScheduled: false,
      });
      await interaction.reply(`Manual drop started in <#${drop.threadId}> and closes <t:${drop.endTs}:R>.`);
    } catch (error) {
      await interaction.reply({ content: error.message, ephemeral: true });
    }
    return true;
  }

  if (interaction.commandName === "snapclose") {
    const currentDrop = store.getCurrentDrop(interaction.guildId);

    if (!currentDrop?.active) {
      await interaction.reply({ content: "There is no active drop to close.", ephemeral: true });
      return true;
    }

    currentDrop.endTs = unixNow();
    store.setCurrentDrop(interaction.guildId, currentDrop);
    await manager.finalizeDrop(interaction.guildId);
    await interaction.reply("The current snap drop has been closed.");
    return true;
  }

  if (interaction.commandName === "snapextend") {
    const minutes = interaction.options.getInteger("minutes", true);
    if (minutes < 1 || minutes > 60) {
      await interaction.reply({ content: "Extension must be between 1 and 60 minutes.", ephemeral: true });
      return true;
    }

    try {
      const drop = await manager.extendDrop(interaction.guildId, minutes);
      await interaction.reply(`The active drop now closes <t:${drop.endTs}:R>.`);
    } catch (error) {
      await interaction.reply({ content: error.message, ephemeral: true });
    }
    return true;
  }

  if (interaction.commandName === "snapreopen") {
    try {
      const drop = await manager.reopenLastClosedDrop(interaction.guildId);
      await interaction.reply(`The last drop has been reopened in <#${drop.threadId}> for 5 minutes.`);
    } catch (error) {
      await interaction.reply({ content: error.message, ephemeral: true });
    }
    return true;
  }

  if (interaction.commandName === "snapreroll") {
    store.updateGuild(interaction.guildId, {
      nextScheduledDropTs: null,
      lastScheduledForDate: null,
    });
    const next = manager.ensureScheduledDrop(interaction.guildId);
    await interaction.reply(`Next automatic drop rerolled to <t:${next.nextScheduledDropTs}:F>.`);
    return true;
  }

  if (interaction.commandName === "snaprewardrole") {
    const role = interaction.options.getRole("role", true);
    const threshold = interaction.options.getInteger("threshold", true);

    if (threshold < 1 || threshold > 365) {
      await interaction.reply({ content: "Threshold must be between 1 and 365.", ephemeral: true });
      return true;
    }

    store.updateGuild(interaction.guildId, {
      rewardRoleId: role.id,
      rewardThreshold: threshold,
    });
    await interaction.reply(`Reward role set to ${role} for streaks of **${threshold}+**.`);
    return true;
  }

  if (interaction.commandName === "snapjoinrole") {
    const role = interaction.options.getRole("role", true);
    store.updateGuild(interaction.guildId, {
      joinRoleId: role.id,
    });
    await interaction.reply(`Members can now use \`/snapjoin\` to get ${role} and \`/snapleave\` to remove it.`);
    return true;
  }

  if (interaction.commandName === "snapconfig") {
    const currentDrop = store.getCurrentDrop(interaction.guildId);
    const actions = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("snap:snooze").setLabel("Snooze").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("snap:mystats").setLabel("My Stats").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("snap:reroll").setLabel("Reroll Next Drop").setStyle(ButtonStyle.Secondary)
    );
    const embed = buildBaseEmbed("Snap 2.0 Config").addFields(
      { name: "Enabled", value: guildConfig.enabled ? "Yes" : "No", inline: true },
      {
        name: "Channel",
        value: guildConfig.snapsChannelId ? `<#${guildConfig.snapsChannelId}>` : "Not set",
        inline: true,
      },
      {
        name: "Role",
        value: guildConfig.snapsRoleId ? `<@&${guildConfig.snapsRoleId}>` : "Not set",
        inline: true,
      },
      {
        name: "Timezone",
        value: guildConfig.timeZone,
        inline: true,
      },
      {
        name: "Daily Window",
        value: `${guildConfig.dailyWindowStartHourLocal}:00-${guildConfig.dailyWindowEndHourLocal}:59 local`,
        inline: true,
      },
      {
        name: "Drop Duration",
        value: `${guildConfig.dropDurationMinutes} minute(s)`,
        inline: true,
      },
      {
        name: "Reminders",
        value: guildConfig.reminderMinutesBeforeEnd.join(", "),
        inline: true,
      },
      {
        name: "Reward Role",
        value: guildConfig.rewardRoleId
          ? `<@&${guildConfig.rewardRoleId}> at ${guildConfig.rewardThreshold}+ streak`
          : "Not configured",
        inline: false,
      },
      {
        name: "Join Role",
        value: guildConfig.joinRoleId ? `<@&${guildConfig.joinRoleId}>` : "Not configured",
        inline: false,
      },
      {
        name: "Next Auto Drop",
        value: guildConfig.nextScheduledDropTs ? `<t:${guildConfig.nextScheduledDropTs}:F>` : "Not scheduled yet",
        inline: false,
      },
      {
        name: "Active Drop",
        value: currentDrop?.active
          ? `<#${currentDrop.threadId}> closes in ${formatRelativeDuration(currentDrop.endTs * 1000 - Date.now())}`
          : "No active drop",
        inline: false,
      }
    );

    await interaction.reply({ embeds: [embed], components: [actions], ephemeral: true });
    return true;
  }

  if (interaction.commandName === "snapstats") {
    const user = interaction.options.getUser("user") || interaction.user;
    const member =
      interaction.guild.members.cache.get(user.id) ||
      (await interaction.guild.members.fetch(user.id).catch(() => null));
    const entry = store.getMember(interaction.guildId, user.id, member?.displayName || user.username);

    const embed = buildBaseEmbed(`Snap Stats: ${entry.displayName}`).addFields(
      { name: "On-Time", value: `${entry.totalOnTime}`, inline: true },
      { name: "Late", value: `${entry.totalLate}`, inline: true },
      { name: "Missed", value: `${entry.totalMissed || 0}`, inline: true },
      { name: "Current Streak", value: `${entry.streak}`, inline: true },
      { name: "Best Streak", value: `${entry.bestStreak || 0}`, inline: true },
      { name: "Last On-Time", value: entry.lastOnTimeDate || "Never", inline: true }
    );

    await interaction.reply({ embeds: [embed] });
    return true;
  }

  if (interaction.commandName === "snapleaderboard") {
    const members = store
      .listGuildMembers(interaction.guildId)
      .sort((a, b) => {
        if ((b.bestStreak || 0) !== (a.bestStreak || 0)) {
          return (b.bestStreak || 0) - (a.bestStreak || 0);
        }

        return (b.totalOnTime || 0) - (a.totalOnTime || 0);
      })
      .slice(0, 10);

    if (members.length === 0) {
      await interaction.reply("No snap history yet.");
      return true;
    }

    const embed = buildBaseEmbed("Snap Leaderboard").setDescription(
      members
        .map(
          (member, index) =>
            `**${index + 1}.** ${member.displayName} - best ${member.bestStreak || 0}, on-time ${member.totalOnTime || 0}`
        )
        .join("\n")
    );

    await interaction.reply({ embeds: [embed] });
    return true;
  }

  if (interaction.commandName === "snapjoin" || interaction.commandName === "snapleave") {
    if (!guildConfig.joinRoleId) {
      await interaction.reply({
        content: "This server does not have a join role configured yet. Ask an admin to run `/snapjoinrole`.",
        ephemeral: true,
      });
      return true;
    }

    const role = await interaction.guild.roles.fetch(guildConfig.joinRoleId).catch(() => null);
    const member =
      interaction.guild.members.cache.get(interaction.user.id) ||
      (await interaction.guild.members.fetch(interaction.user.id).catch(() => null));

    if (!role || !member) {
      await interaction.reply({
        content: "The join role is missing or I couldn't load your member record.",
        ephemeral: true,
      });
      return true;
    }

    if (interaction.commandName === "snapjoin") {
      if (member.roles.cache.has(role.id)) {
        await interaction.reply({ content: `You already have ${role}.`, ephemeral: true });
        return true;
      }

      await member.roles.add(role).catch(() => null);
      await interaction.reply({ content: `You have been added to ${role}.`, ephemeral: true });
      return true;
    }

    if (!member.roles.cache.has(role.id)) {
      await interaction.reply({ content: `You do not currently have ${role}.`, ephemeral: true });
      return true;
    }

    await member.roles.remove(role).catch(() => null);
    await interaction.reply({ content: `You have been removed from ${role}.`, ephemeral: true });
    return true;
  }

  if (interaction.commandName === "snapsnooze") {
    try {
      await manager.snoozeMember(interaction);
      await interaction.reply({ content: "You have been marked as snoozed for this drop.", ephemeral: true });
    } catch (error) {
      await interaction.reply({ content: error.message, ephemeral: true });
    }
    return true;
  }

  if (interaction.commandName === "snapexport") {
    const payload = {
      exportedAt: new Date().toISOString(),
      guildId: interaction.guildId,
      config: store.getGuild(interaction.guildId),
      members: store.listGuildMembers(interaction.guildId),
    };
    const file = new AttachmentBuilder(Buffer.from(JSON.stringify(payload, null, 2), "utf8"), {
      name: `snap-export-${interaction.guildId}.json`,
    });

    await interaction.reply({ content: "Export ready.", files: [file], ephemeral: true });
    return true;
  }

  if (interaction.commandName === "snaprecap") {
    const sent = await manager.maybeSendWeeklyRecap(interaction.guildId, true);
    await interaction.reply(sent ? "Weekly recap posted." : "Weekly recap could not be posted right now.");
    return true;
  }

  if (interaction.commandName === "snapreset") {
    const confirm = interaction.options.getString("confirm", true);
    if (confirm !== "RESET") {
      await interaction.reply({
        content: "Reset cancelled. Type exactly `RESET` in the `confirm` field to wipe this server's snap bot state.",
        ephemeral: true,
      });
      return true;
    }

    manager.resetGuildState(interaction.guildId);
    await interaction.reply({
      content:
        "This server's snap bot state has been reset. All tracked stats, config, and active drop data for this server were removed.",
      ephemeral: true,
    });
    return true;
  }

  return false;
}

async function handleComponent(interaction, manager, store) {
  if (!interaction.isButton() || !interaction.guildId) {
    return false;
  }

  if (interaction.customId === "snap:snooze") {
    try {
      await manager.snoozeMember(interaction);
      await interaction.reply({ content: "You have been marked as snoozed for the active drop.", ephemeral: true });
    } catch (error) {
      await interaction.reply({ content: error.message, ephemeral: true });
    }
    return true;
  }

  if (interaction.customId === "snap:mystats") {
    const entry = store.getMember(
      interaction.guildId,
      interaction.user.id,
      interaction.member?.displayName || interaction.user.username
    );
    await interaction.reply({
      embeds: [
        buildBaseEmbed(`Snap Stats: ${entry.displayName}`).setDescription(
          `On-time: **${entry.totalOnTime}**\nLate: **${entry.totalLate}**\nMissed: **${entry.totalMissed || 0}**\nCurrent streak: **${entry.streak}**\nBest streak: **${entry.bestStreak || 0}**`
        ),
      ],
      ephemeral: true,
    });
    return true;
  }

  if (interaction.customId === "snap:reroll") {
    store.updateGuild(interaction.guildId, {
      nextScheduledDropTs: null,
      lastScheduledForDate: null,
    });
    const next = manager.ensureScheduledDrop(interaction.guildId);
    await interaction.reply({ content: `Next automatic drop rerolled to <t:${next.nextScheduledDropTs}:F>.`, ephemeral: true });
    return true;
  }

  return false;
}

module.exports = {
  buildCommands,
  handleCommand,
  handleComponent,
};
