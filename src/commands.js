const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const { buildBaseEmbed } = require("./discord-utils");
const { formatRelativeDuration, isValidTimeZone, unixNow } = require("./time");

const PANEL_VIEWS = {
  overview: "overview",
  live: "live",
  settings: "settings",
  roles: "roles",
  members: "members",
  danger: "danger",
};

function formatChannelMention(channelId) {
  return channelId ? `<#${channelId}>` : "Not set";
}

function formatRoleMention(roleId) {
  return roleId ? `<@&${roleId}>` : "Not set";
}

function getGuildStats(members) {
  return {
    tracked: members.length,
    onTime: members.reduce((sum, member) => sum + (member.totalOnTime || 0), 0),
    late: members.reduce((sum, member) => sum + (member.totalLate || 0), 0),
    missed: members.reduce((sum, member) => sum + (member.totalMissed || 0), 0),
  };
}

function formatLeaderboard(members, sorter, formatter) {
  const rows = [...members].sort(sorter).slice(0, 5).map(formatter);
  return rows.length ? rows.join("\n") : "No member history yet.";
}

function buildNavRows(activeView) {
  const button = (view, label) =>
    new ButtonBuilder()
      .setCustomId(`panel:view:${view}`)
      .setLabel(label)
      .setStyle(view === activeView ? ButtonStyle.Primary : ButtonStyle.Secondary);

  return [
    new ActionRowBuilder().addComponents(
      button(PANEL_VIEWS.overview, "Overview"),
      button(PANEL_VIEWS.live, "Live"),
      button(PANEL_VIEWS.settings, "Settings"),
      button(PANEL_VIEWS.roles, "Roles"),
      button(PANEL_VIEWS.members, "Members")
    ),
    new ActionRowBuilder().addComponents(
      button(PANEL_VIEWS.danger, "Danger"),
      new ButtonBuilder()
        .setCustomId(`panel:refresh:${activeView}`)
        .setLabel("Refresh")
        .setStyle(ButtonStyle.Secondary)
    ),
  ];
}

function buildOverviewPanel(guildConfig, currentDrop, members, stats) {
  return buildBaseEmbed("Snap Control Panel")
    .setDescription("Discord-only admin dashboard for your server's BeReal flow.")
    .addFields(
      { name: "Automation", value: guildConfig.enabled ? "Enabled" : "Paused", inline: true },
      { name: "Timezone", value: guildConfig.timeZone, inline: true },
      { name: "Drops / Day", value: `${guildConfig.dropsPerDay}`, inline: true },
      {
        name: "Daily Window",
        value: `${guildConfig.dailyWindowStartHourLocal}:00-${guildConfig.dailyWindowEndHourLocal}:59`,
        inline: true,
      },
      { name: "Drop Duration", value: `${guildConfig.dropDurationMinutes} minute(s)`, inline: true },
      {
        name: "Reminders",
        value: guildConfig.reminderMinutesBeforeEnd.join(", ") || "None",
        inline: true,
      },
      {
        name: "Next Drop",
        value: guildConfig.nextScheduledDropTs ? `<t:${guildConfig.nextScheduledDropTs}:F>` : "Not scheduled",
        inline: false,
      },
      {
        name: "Active Drop",
        value: currentDrop?.active
          ? `<#${currentDrop.threadId}> closes ${formatRelativeDuration(
              currentDrop.endTs * 1000 - Date.now()
            )} from now`
          : "No active drop",
        inline: false,
      },
      {
        name: "Server Totals",
        value: `Tracked: **${stats.tracked}** | On-time: **${stats.onTime}** | Late: **${stats.late}** | Missed: **${stats.missed}**`,
        inline: false,
      },
      {
        name: "Top Streaks",
        value: formatLeaderboard(
          members,
          (a, b) => (b.bestStreak || 0) - (a.bestStreak || 0) || (b.totalOnTime || 0) - (a.totalOnTime || 0),
          (member, index) =>
            `**${index + 1}.** ${member.displayName} - best ${member.bestStreak || 0}, on-time ${member.totalOnTime || 0}`
        ),
        inline: false,
      }
    );
}

function buildLivePanel(guildConfig, currentDrop) {
  const submitted = Object.keys(currentDrop?.submissions || {}).length;
  const snoozed = (currentDrop?.snoozed || []).length;
  const skipped = (currentDrop?.skipped || []).length;

  return buildBaseEmbed("Snap Control Panel: Live")
    .setDescription("Real-time controls for the current drop and the next scheduled moment.")
    .addFields(
      {
        name: "Status",
        value: currentDrop?.active ? "Live now" : "Idle",
        inline: true,
      },
      {
        name: "Thread",
        value: currentDrop?.threadId ? `<#${currentDrop.threadId}>` : "No active thread",
        inline: true,
      },
      {
        name: "Closes",
        value: currentDrop?.active ? `<t:${currentDrop.endTs}:R>` : "No deadline",
        inline: true,
      },
      {
        name: "Participation",
        value: `Submitted: **${submitted}** | Snoozed: **${snoozed}** | Missed: **${skipped}**`,
        inline: false,
      },
      {
        name: "Next Auto Drop",
        value: guildConfig.nextScheduledDropTs ? `<t:${guildConfig.nextScheduledDropTs}:F>` : "Not scheduled",
        inline: false,
      },
      {
        name: "Manual Controls",
        value: "Start, close, extend, reopen, reroll, export, and recap are all available below.",
        inline: false,
      }
    );
}

function buildSettingsPanel(guildConfig) {
  return buildBaseEmbed("Snap Control Panel: Settings")
    .setDescription("Scheduling, reminders, and automation switches for this server.")
    .addFields(
      { name: "Automation", value: guildConfig.enabled ? "Enabled" : "Paused", inline: true },
      {
        name: "Weekly Recap",
        value: guildConfig.weeklyRecapEnabled ? "Enabled" : "Disabled",
        inline: true,
      },
      { name: "Timezone", value: guildConfig.timeZone, inline: true },
      {
        name: "Daily Window",
        value: `${guildConfig.dailyWindowStartHourLocal}:00-${guildConfig.dailyWindowEndHourLocal}:59`,
        inline: true,
      },
      { name: "Drop Duration", value: `${guildConfig.dropDurationMinutes} minute(s)`, inline: true },
      {
        name: "Reminders",
        value: guildConfig.reminderMinutesBeforeEnd.join(", ") || "None",
        inline: true,
      },
      {
        name: "Drops / Day",
        value: `${guildConfig.dropsPerDay}`,
        inline: true,
      },
      {
        name: "Next Drop",
        value: guildConfig.nextScheduledDropTs ? `<t:${guildConfig.nextScheduledDropTs}:F>` : "Not scheduled",
        inline: true,
      }
    );
}

function buildRolesPanel(guildConfig) {
  return buildBaseEmbed("Snap Control Panel: Roles")
    .setDescription("Channel and role assignments used by the bot.")
    .addFields(
      { name: "Snap Channel", value: formatChannelMention(guildConfig.snapsChannelId), inline: false },
      { name: "Ping Role", value: formatRoleMention(guildConfig.snapsRoleId), inline: false },
      {
        name: "Reward Role",
        value: guildConfig.rewardRoleId
          ? `<@&${guildConfig.rewardRoleId}> at ${guildConfig.rewardThreshold}+ streak`
          : "Not configured",
        inline: false,
      },
      { name: "Join Role", value: formatRoleMention(guildConfig.joinRoleId), inline: false }
    );
}

function buildMembersPanel(members, currentDrop) {
  const submittedIds = new Set(Object.keys(currentDrop?.submissions || {}));
  const participation = currentDrop?.active
    ? `Submitted now: **${submittedIds.size}** | Snoozed: **${(currentDrop.snoozed || []).length}** | Waiting: **${Math.max(
        0,
        members.length - submittedIds.size - (currentDrop.snoozed || []).length
      )}**`
    : "No active drop right now.";

  return buildBaseEmbed("Snap Control Panel: Members")
    .setDescription("People-focused tools, plus quick reads on who is thriving or falling behind.")
    .addFields(
      {
        name: "Current Participation",
        value: participation,
        inline: false,
      },
      {
        name: "Top On-Time",
        value: formatLeaderboard(
          members,
          (a, b) => (b.totalOnTime || 0) - (a.totalOnTime || 0) || (b.bestStreak || 0) - (a.bestStreak || 0),
          (member, index) =>
            `**${index + 1}.** ${member.displayName} - on-time ${member.totalOnTime || 0}, streak ${member.streak || 0}`
        ),
        inline: false,
      },
      {
        name: "Most Missed",
        value: formatLeaderboard(
          members,
          (a, b) => (b.totalMissed || 0) - (a.totalMissed || 0) || (b.totalLate || 0) - (a.totalLate || 0),
          (member, index) =>
            `**${index + 1}.** ${member.displayName} - missed ${member.totalMissed || 0}, late ${member.totalLate || 0}`
        ),
        inline: false,
      }
    );
}

function buildDangerPanel(guildConfig) {
  return buildBaseEmbed("Snap Control Panel: Danger")
    .setDescription("Higher-impact maintenance actions. Use these carefully.")
    .addFields(
      {
        name: "Reset Options",
        value: "You can reset just stats, just schedule data, just role config, or the entire server state.",
        inline: false,
      },
      {
        name: "Command Sync",
        value: "Force a guild slash-command refresh if Discord is still showing stale commands.",
        inline: false,
      },
      {
        name: "Current Safeguards",
        value: `Automation is ${guildConfig.enabled ? "enabled" : "paused"} and resets require typing \`RESET\` in a modal.`,
        inline: false,
      }
    );
}

function buildPanelActions(view) {
  if (view === PANEL_VIEWS.live) {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`panel:start:${view}`).setLabel("Start").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`panel:close:${view}`).setLabel("Close").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`panel:extend:${view}`).setLabel("Extend +5m").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`panel:reopen:${view}`).setLabel("Reopen").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`panel:reroll:${view}`).setLabel("Reroll").setStyle(ButtonStyle.Secondary)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`panel:recap:${view}`).setLabel("Recap").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`panel:export:${view}`).setLabel("Export").setStyle(ButtonStyle.Secondary)
      ),
    ];
  }

  if (view === PANEL_VIEWS.settings) {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`panel:schedule:${view}`).setLabel("Edit Schedule").setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`panel:toggle-automation:${view}`)
          .setLabel("Toggle Automation")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`panel:toggle-recap:${view}`)
          .setLabel("Toggle Recap")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`panel:reroll:${view}`).setLabel("Reroll").setStyle(ButtonStyle.Secondary)
      ),
    ];
  }

  if (view === PANEL_VIEWS.roles) {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`panel:roles:${view}`).setLabel("Edit Roles").setStyle(ButtonStyle.Primary)
      ),
    ];
  }

  if (view === PANEL_VIEWS.members) {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`panel:inspect-member:${view}`).setLabel("Inspect Member").setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`panel:assign-join-role:${view}`)
          .setLabel("Give Join Role")
          .setStyle(ButtonStyle.Secondary)
      ),
    ];
  }

  if (view === PANEL_VIEWS.danger) {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`panel:sync-commands:${view}`)
          .setLabel("Sync Commands")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`panel:export:${view}`).setLabel("Export").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`panel:reset:${view}`).setLabel("Reset").setStyle(ButtonStyle.Danger)
      ),
    ];
  }

  return [];
}

function buildPanelView(interactionOrGuildId, manager, store, options = {}) {
  const guildId =
    typeof interactionOrGuildId === "string" ? interactionOrGuildId : interactionOrGuildId.guildId;
  const view = options.view || PANEL_VIEWS.overview;
  const guildConfig = store.getGuild(guildId);
  const currentDrop = store.getCurrentDrop(guildId);
  const members = store.listGuildMembers(guildId);
  const stats = getGuildStats(members);
  const embedByView = {
    [PANEL_VIEWS.overview]: buildOverviewPanel(guildConfig, currentDrop, members, stats),
    [PANEL_VIEWS.live]: buildLivePanel(guildConfig, currentDrop),
    [PANEL_VIEWS.settings]: buildSettingsPanel(guildConfig),
    [PANEL_VIEWS.roles]: buildRolesPanel(guildConfig),
    [PANEL_VIEWS.members]: buildMembersPanel(members, currentDrop),
    [PANEL_VIEWS.danger]: buildDangerPanel(guildConfig),
  };
  const components = [...buildNavRows(view), ...buildPanelActions(view)];

  return {
    embeds: [embedByView[view] || embedByView[PANEL_VIEWS.overview]],
    components,
  };
}

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
      .addIntegerOption((option) =>
        option.setName("drops_per_day").setDescription("How many random drops happen per day").setRequired(false)
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
      .addIntegerOption((option) =>
        option.setName("drops_per_day").setDescription("How many random drops happen per day").setRequired(false)
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
      .setName("snappanel")
      .setDescription("Open the Discord admin control panel for this server")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
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

function createScheduleModal(guildConfig, view) {
  const modal = new ModalBuilder()
    .setCustomId(`panel:schedule-modal:${view}`)
    .setTitle("Update Schedule");
  const startInput = new TextInputBuilder()
    .setCustomId("start_hour")
    .setLabel("Start Hour")
    .setStyle(TextInputStyle.Short)
    .setValue(String(guildConfig.dailyWindowStartHourLocal))
    .setRequired(true);
  const endInput = new TextInputBuilder()
    .setCustomId("end_hour")
    .setLabel("End Hour")
    .setStyle(TextInputStyle.Short)
    .setValue(String(guildConfig.dailyWindowEndHourLocal))
    .setRequired(true);
  const durationInput = new TextInputBuilder()
    .setCustomId("duration_minutes")
    .setLabel("Duration Minutes")
    .setStyle(TextInputStyle.Short)
    .setValue(String(guildConfig.dropDurationMinutes))
    .setRequired(true);
  const dropsInput = new TextInputBuilder()
    .setCustomId("drops_per_day")
    .setLabel("Drops Per Day")
    .setStyle(TextInputStyle.Short)
    .setValue(String(guildConfig.dropsPerDay))
    .setRequired(true);
  const remindersInput = new TextInputBuilder()
    .setCustomId("reminders")
    .setLabel("Reminders")
    .setStyle(TextInputStyle.Short)
    .setValue(guildConfig.reminderMinutesBeforeEnd.join(","))
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(startInput),
    new ActionRowBuilder().addComponents(endInput),
    new ActionRowBuilder().addComponents(durationInput),
    new ActionRowBuilder().addComponents(dropsInput),
    new ActionRowBuilder().addComponents(remindersInput)
  );
  return modal;
}

function createRolesModal(guildConfig, view) {
  const modal = new ModalBuilder().setCustomId(`panel:roles-modal:${view}`).setTitle("Edit Channel and Roles");
  const channelInput = new TextInputBuilder()
    .setCustomId("channel_id")
    .setLabel("Snap Channel ID")
    .setStyle(TextInputStyle.Short)
    .setValue(guildConfig.snapsChannelId || "")
    .setRequired(false);
  const pingRoleInput = new TextInputBuilder()
    .setCustomId("snaps_role_id")
    .setLabel("Ping Role ID")
    .setStyle(TextInputStyle.Short)
    .setValue(guildConfig.snapsRoleId || "")
    .setRequired(false);
  const rewardRoleInput = new TextInputBuilder()
    .setCustomId("reward_role_id")
    .setLabel("Reward Role ID")
    .setStyle(TextInputStyle.Short)
    .setValue(guildConfig.rewardRoleId || "")
    .setRequired(false);
  const rewardThresholdInput = new TextInputBuilder()
    .setCustomId("reward_threshold")
    .setLabel("Reward Threshold")
    .setStyle(TextInputStyle.Short)
    .setValue(String(guildConfig.rewardThreshold || 1))
    .setRequired(true);
  const joinRoleInput = new TextInputBuilder()
    .setCustomId("join_role_id")
    .setLabel("Join Role ID")
    .setStyle(TextInputStyle.Short)
    .setValue(guildConfig.joinRoleId || "")
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(channelInput),
    new ActionRowBuilder().addComponents(pingRoleInput),
    new ActionRowBuilder().addComponents(rewardRoleInput),
    new ActionRowBuilder().addComponents(rewardThresholdInput),
    new ActionRowBuilder().addComponents(joinRoleInput)
  );
  return modal;
}

function createMemberInspectModal(view) {
  return new ModalBuilder()
    .setCustomId(`panel:inspect-member-modal:${view}`)
    .setTitle("Inspect Member")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("user_id")
          .setLabel("Discord User ID")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      )
    );
}

function createAssignJoinRoleModal(view) {
  return new ModalBuilder()
    .setCustomId(`panel:assign-join-role-modal:${view}`)
    .setTitle("Give Join Role")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("user_id")
          .setLabel("Discord User ID")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      )
    );
}

function createResetModal(view) {
  const modal = new ModalBuilder().setCustomId(`panel:reset-modal:${view}`).setTitle("Reset Server State");
  const scopeInput = new TextInputBuilder()
    .setCustomId("scope")
    .setLabel("Scope: stats, schedule, roles, or all")
    .setStyle(TextInputStyle.Short)
    .setValue("all")
    .setRequired(true);
  const confirmInput = new TextInputBuilder()
    .setCustomId("confirm")
    .setLabel("Type RESET to confirm")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(scopeInput),
    new ActionRowBuilder().addComponents(confirmInput)
  );
  return modal;
}

function buildMemberStatsEmbed(entry) {
  return buildBaseEmbed(`BeReal Stats: ${entry.displayName}`).addFields(
    { name: "On-Time", value: `${entry.totalOnTime}`, inline: true },
    { name: "Late", value: `${entry.totalLate}`, inline: true },
    { name: "Missed", value: `${entry.totalMissed || 0}`, inline: true },
    { name: "Current Streak", value: `${entry.streak}`, inline: true },
    { name: "Best Streak", value: `${entry.bestStreak || 0}`, inline: true },
    { name: "Last On-Time", value: entry.lastOnTimeDate || "Never", inline: true }
  );
}

async function handleCommand(interaction, manager, store, helpers = {}) {
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
    const dropsPerDay = interaction.options.getInteger("drops_per_day");

    if (!channel && !role && !timeZone && startHour === null && endHour === null && durationMinutes === null && dropsPerDay === null) {
      const checklist = [
        guildConfig.snapsChannelId ? "Channel configured" : "Channel missing",
        guildConfig.snapsRoleId ? "Role configured" : "Role missing",
        guildConfig.timeZone ? `Timezone: ${guildConfig.timeZone}` : "Timezone missing",
        `Window: ${guildConfig.dailyWindowStartHourLocal}:00-${guildConfig.dailyWindowEndHourLocal}:59`,
        `Duration: ${guildConfig.dropDurationMinutes} minute(s)`,
        `Drops per day: ${guildConfig.dropsPerDay}`,
      ];
      await interaction.reply({
        embeds: [
          buildBaseEmbed("BeReal Setup Guide").setDescription(checklist.map((line) => `- ${line}`).join("\n")),
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
      dropsPerDay: dropsPerDay ?? guildConfig.dropsPerDay,
      nextScheduledDropTs: null,
      lastScheduledForDate: null,
      scheduledDropHistory: [],
    });
    manager.ensureScheduledDrop(interaction.guildId);

    await interaction.reply(
      `Your BeReal-style setup is configured with ${channel ?? (guildConfig.snapsChannelId ? `<#${guildConfig.snapsChannelId}>` : "no channel yet")}, ${role ?? (guildConfig.snapsRoleId ? `<@&${guildConfig.snapsRoleId}>` : "no role yet")}, timezone **${timeZone ?? guildConfig.timeZone}**, a ${startHour ?? guildConfig.dailyWindowStartHourLocal}:00-${endHour ?? guildConfig.dailyWindowEndHourLocal}:59 window, and **${dropsPerDay ?? guildConfig.dropsPerDay}** drop(s) per day.`
    );
    return true;
  }

  if (interaction.commandName === "snapwindow") {
    const startHour = interaction.options.getInteger("start_hour", true);
    const endHour = interaction.options.getInteger("end_hour", true);
    const durationMinutes = interaction.options.getInteger("duration_minutes") ?? guildConfig.dropDurationMinutes;
    const dropsPerDay = interaction.options.getInteger("drops_per_day") ?? guildConfig.dropsPerDay;

    if (startHour < 0 || startHour > 23 || endHour < 0 || endHour > 23) {
      await interaction.reply({ content: "Hours must be between 0 and 23 UTC.", ephemeral: true });
      return true;
    }

    if (durationMinutes < 1 || durationMinutes > 180) {
      await interaction.reply({ content: "Duration must be between 1 and 180 minutes.", ephemeral: true });
      return true;
    }

    if (dropsPerDay < 1 || dropsPerDay > 10) {
      await interaction.reply({ content: "Drops per day must be between 1 and 10.", ephemeral: true });
      return true;
    }

    store.updateGuild(interaction.guildId, {
      dailyWindowStartHourLocal: startHour,
      dailyWindowEndHourLocal: endHour,
      dropDurationMinutes: durationMinutes,
      dropsPerDay,
      nextScheduledDropTs: null,
      lastScheduledForDate: null,
      scheduledDropHistory: [],
    });
    const next = manager.ensureScheduledDrop(interaction.guildId);

    await interaction.reply(
      `Daily BeReal window updated to ${startHour}:00-${endHour}:59 in **${store.getGuild(interaction.guildId).timeZone}** with a ${durationMinutes} minute posting window and **${dropsPerDay}** drop(s) per day. Next auto drop: <t:${next.nextScheduledDropTs}:F>.`
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
      await interaction.reply(`Manual BeReal moment started in <#${drop.threadId}> and closes <t:${drop.endTs}:R>.`);
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
    await interaction.reply("The current BeReal moment has been closed.");
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
      await interaction.reply(`The active BeReal moment now closes <t:${drop.endTs}:R>.`);
    } catch (error) {
      await interaction.reply({ content: error.message, ephemeral: true });
    }
    return true;
  }

  if (interaction.commandName === "snapreopen") {
    try {
      const drop = await manager.reopenLastClosedDrop(interaction.guildId);
      await interaction.reply(`The last BeReal moment has been reopened in <#${drop.threadId}> for 5 minutes.`);
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
    const embed = buildBaseEmbed("BeReal Style Config").addFields(
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
        name: "Drops / Day",
        value: `${guildConfig.dropsPerDay}`,
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

  if (interaction.commandName === "snappanel") {
    await interaction.reply({
      ...buildPanelView(interaction, manager, store, { view: PANEL_VIEWS.overview }),
      ephemeral: true,
    });
    return true;
  }

  if (interaction.commandName === "snapstats") {
    const user = interaction.options.getUser("user") || interaction.user;
    const member =
      interaction.guild.members.cache.get(user.id) ||
      (await interaction.guild.members.fetch(user.id).catch(() => null));
    const entry = store.getMember(interaction.guildId, user.id, member?.displayName || user.username);

    await interaction.reply({ embeds: [buildMemberStatsEmbed(entry)] });
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

    const embed = buildBaseEmbed("BeReal Leaderboard").setDescription(
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

async function handleComponent(interaction, manager, store, helpers = {}) {
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
      embeds: [buildMemberStatsEmbed(entry)],
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

  if (!interaction.customId.startsWith("panel:")) {
    return false;
  }

  const [, action, view = PANEL_VIEWS.overview] = interaction.customId.split(":");

  if (action === "view") {
    const nextView = view;
    await interaction.update(buildPanelView(interaction, manager, store, { view: nextView }));
    return true;
  }

  if (action === "refresh") {
    await interaction.update(buildPanelView(interaction, manager, store, { view }));
    return true;
  }

  if (action === "start") {
    try {
      await manager.startDrop(interaction.guildId, {
        forcedByUserId: interaction.user.id,
        isScheduled: false,
      });
      await interaction.update(buildPanelView(interaction, manager, store, { view }));
      await interaction.followUp({ content: "Manual drop started.", ephemeral: true });
    } catch (error) {
      await interaction.reply({ content: error.message, ephemeral: true });
    }
    return true;
  }

  if (action === "close") {
    try {
      const currentDrop = store.getCurrentDrop(interaction.guildId);
      if (!currentDrop?.active) {
        throw new Error("There is no active drop to close.");
      }

      currentDrop.endTs = unixNow();
      store.setCurrentDrop(interaction.guildId, currentDrop);
      await manager.finalizeDrop(interaction.guildId);
      await interaction.update(buildPanelView(interaction, manager, store, { view }));
      await interaction.followUp({ content: "Active drop closed.", ephemeral: true });
    } catch (error) {
      await interaction.reply({ content: error.message, ephemeral: true });
    }
    return true;
  }

  if (action === "extend") {
    try {
      await manager.extendDrop(interaction.guildId, 5);
      await interaction.update(buildPanelView(interaction, manager, store, { view }));
      await interaction.followUp({ content: "Extended the active drop by 5 minutes.", ephemeral: true });
    } catch (error) {
      await interaction.reply({ content: error.message, ephemeral: true });
    }
    return true;
  }

  if (action === "reopen") {
    try {
      await manager.reopenLastClosedDrop(interaction.guildId);
      await interaction.update(buildPanelView(interaction, manager, store, { view }));
      await interaction.followUp({ content: "Reopened the last drop.", ephemeral: true });
    } catch (error) {
      await interaction.reply({ content: error.message, ephemeral: true });
    }
    return true;
  }

  if (action === "reroll") {
    store.updateGuild(interaction.guildId, {
      nextScheduledDropTs: null,
      lastScheduledForDate: null,
      scheduledDropHistory: [],
    });
    manager.ensureScheduledDrop(interaction.guildId);
    await interaction.update(buildPanelView(interaction, manager, store, { view }));
    await interaction.followUp({ content: "Rerolled the next scheduled drop.", ephemeral: true });
    return true;
  }

  if (action === "recap") {
    const sent = await manager.maybeSendWeeklyRecap(interaction.guildId, true);
    await interaction.update(buildPanelView(interaction, manager, store, { view }));
    await interaction.followUp({ content: sent ? "Weekly recap posted." : "Weekly recap could not be posted.", ephemeral: true });
    return true;
  }

  if (action === "export") {
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

  if (action === "schedule") {
    const guildConfig = store.getGuild(interaction.guildId);
    await interaction.showModal(createScheduleModal(guildConfig, view));
    return true;
  }

  if (action === "roles") {
    await interaction.showModal(createRolesModal(store.getGuild(interaction.guildId), view));
    return true;
  }

  if (action === "inspect-member") {
    await interaction.showModal(createMemberInspectModal(view));
    return true;
  }

  if (action === "assign-join-role") {
    await interaction.showModal(createAssignJoinRoleModal(view));
    return true;
  }

  if (action === "toggle-automation") {
    const guildConfig = store.getGuild(interaction.guildId);
    const enabled = !guildConfig.enabled;
    store.updateGuild(interaction.guildId, {
      enabled,
      nextScheduledDropTs: enabled ? null : guildConfig.nextScheduledDropTs,
    });
    if (enabled) {
      manager.ensureScheduledDrop(interaction.guildId);
    }
    await interaction.update(buildPanelView(interaction, manager, store, { view }));
    await interaction.followUp({
      content: `Automatic drops are now ${enabled ? "enabled" : "paused"}.`,
      ephemeral: true,
    });
    return true;
  }

  if (action === "toggle-recap") {
    const guildConfig = store.getGuild(interaction.guildId);
    store.updateGuild(interaction.guildId, {
      weeklyRecapEnabled: !guildConfig.weeklyRecapEnabled,
    });
    await interaction.update(buildPanelView(interaction, manager, store, { view }));
    await interaction.followUp({
      content: `Weekly recap is now ${guildConfig.weeklyRecapEnabled ? "disabled" : "enabled"}.`,
      ephemeral: true,
    });
    return true;
  }

  if (action === "sync-commands") {
    if (!helpers.refreshGuildCommands) {
      await interaction.reply({ content: "Command sync helper is not available in this runtime.", ephemeral: true });
      return true;
    }

    await helpers.refreshGuildCommands(interaction.guildId);
    await interaction.update(buildPanelView(interaction, manager, store, { view }));
    await interaction.followUp({
      content: "Guild slash commands synced. Discord may take a moment to refresh the command list.",
      ephemeral: true,
    });
    return true;
  }

  if (action === "reset") {
    await interaction.showModal(createResetModal(view));
    return true;
  }

  return false;
}

async function handleModal(interaction, manager, store) {
  if (!interaction.isModalSubmit() || !interaction.guildId) {
    return false;
  }

  const [, action, view = PANEL_VIEWS.overview] = interaction.customId.split(":");

  if (action === "schedule-modal") {
    const startHour = Number.parseInt(interaction.fields.getTextInputValue("start_hour"), 10);
    const endHour = Number.parseInt(interaction.fields.getTextInputValue("end_hour"), 10);
    const duration = Number.parseInt(interaction.fields.getTextInputValue("duration_minutes"), 10);
    const dropsPerDay = Number.parseInt(interaction.fields.getTextInputValue("drops_per_day"), 10);
    const reminders = interaction.fields
      .getTextInputValue("reminders")
      .split(",")
      .map((value) => Number.parseInt(value.trim(), 10))
      .filter((value) => Number.isInteger(value) && value > 0)
      .sort((a, b) => b - a);

    if (
      !Number.isInteger(startHour) || startHour < 0 || startHour > 23 ||
      !Number.isInteger(endHour) || endHour < 0 || endHour > 23 ||
      !Number.isInteger(duration) || duration < 1 || duration > 180 ||
      !Number.isInteger(dropsPerDay) || dropsPerDay < 1 || dropsPerDay > 10 ||
      reminders.length === 0
    ) {
      await interaction.reply({ content: "Invalid schedule values. Check the numbers and try again.", ephemeral: true });
      return true;
    }

    store.updateGuild(interaction.guildId, {
      dailyWindowStartHourLocal: startHour,
      dailyWindowEndHourLocal: endHour,
      dropDurationMinutes: duration,
      dropsPerDay,
      reminderMinutesBeforeEnd: reminders,
      nextScheduledDropTs: null,
      lastScheduledForDate: null,
      scheduledDropHistory: [],
    });
    manager.ensureScheduledDrop(interaction.guildId);
    await interaction.reply({
      ...buildPanelView(interaction, manager, store, { view }),
      ephemeral: true,
    });
    return true;
  }

  if (action === "roles-modal") {
    const channelId = interaction.fields.getTextInputValue("channel_id").trim() || null;
    const snapsRoleId = interaction.fields.getTextInputValue("snaps_role_id").trim() || null;
    const rewardRoleId = interaction.fields.getTextInputValue("reward_role_id").trim() || null;
    const joinRoleId = interaction.fields.getTextInputValue("join_role_id").trim() || null;
    const rewardThreshold = Number.parseInt(interaction.fields.getTextInputValue("reward_threshold"), 10);

    if (!Number.isInteger(rewardThreshold) || rewardThreshold < 1 || rewardThreshold > 365) {
      await interaction.reply({ content: "Reward threshold must be between 1 and 365.", ephemeral: true });
      return true;
    }

    if (channelId) {
      const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        await interaction.reply({ content: "That channel ID is invalid or not text-based.", ephemeral: true });
        return true;
      }
    }

    for (const [roleId, label] of [
      [snapsRoleId, "ping role"],
      [rewardRoleId, "reward role"],
      [joinRoleId, "join role"],
    ]) {
      if (!roleId) {
        continue;
      }
      const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
      if (!role) {
        await interaction.reply({ content: `The ${label} ID is invalid for this server.`, ephemeral: true });
        return true;
      }
    }

    store.updateGuild(interaction.guildId, {
      snapsChannelId: channelId,
      snapsRoleId,
      rewardRoleId,
      rewardThreshold,
      joinRoleId,
      nextScheduledDropTs: null,
      lastScheduledForDate: null,
      scheduledDropHistory: [],
    });
    manager.ensureScheduledDrop(interaction.guildId);
    await interaction.reply({
      ...buildPanelView(interaction, manager, store, { view }),
      ephemeral: true,
    });
    return true;
  }

  if (action === "inspect-member-modal") {
    const userId = interaction.fields.getTextInputValue("user_id").trim();
    const member = await interaction.guild.members.fetch(userId).catch(() => null);
    if (!member) {
      await interaction.reply({ content: "I couldn't find that member in this server.", ephemeral: true });
      return true;
    }

    const entry = store.getMember(interaction.guildId, userId, member.displayName);
    await interaction.reply({
      embeds: [buildMemberStatsEmbed(entry)],
      ephemeral: true,
    });
    return true;
  }

  if (action === "assign-join-role-modal") {
    const userId = interaction.fields.getTextInputValue("user_id").trim();
    const guildConfig = store.getGuild(interaction.guildId);
    if (!guildConfig.joinRoleId) {
      await interaction.reply({ content: "No join role is configured yet.", ephemeral: true });
      return true;
    }

    const member = await interaction.guild.members.fetch(userId).catch(() => null);
    const role = await interaction.guild.roles.fetch(guildConfig.joinRoleId).catch(() => null);
    if (!member || !role) {
      await interaction.reply({ content: "I couldn't find that member or the configured join role.", ephemeral: true });
      return true;
    }

    await member.roles.add(role).catch(() => null);
    await interaction.reply({
      content: `Added ${role} to ${member}.`,
      ephemeral: true,
    });
    return true;
  }

  if (action === "reset-modal") {
    const scope = interaction.fields.getTextInputValue("scope").trim().toLowerCase();
    const confirm = interaction.fields.getTextInputValue("confirm");
    if (confirm !== "RESET") {
      await interaction.reply({ content: "Reset cancelled.", ephemeral: true });
      return true;
    }

    if (scope === "stats") {
      manager.resetGuildStats(interaction.guildId);
    } else if (scope === "schedule") {
      manager.resetGuildSchedule(interaction.guildId);
    } else if (scope === "roles") {
      manager.resetGuildRoles(interaction.guildId);
    } else if (scope === "all") {
      manager.resetGuildState(interaction.guildId);
    } else {
      await interaction.reply({
        content: "Invalid scope. Use `stats`, `schedule`, `roles`, or `all`.",
        ephemeral: true,
      });
      return true;
    }

    await interaction.reply({
      ...buildPanelView(interaction, manager, store, { view }),
      ephemeral: true,
    });
    await interaction.followUp({ content: `Reset complete for scope: ${scope}.`, ephemeral: true });
    return true;
  }

  return false;
}

module.exports = {
  buildPanelView,
  buildCommands,
  handleCommand,
  handleComponent,
  handleModal,
};
