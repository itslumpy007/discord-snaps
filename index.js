require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  SlashCommandBuilder,
  Routes,
  REST,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');

const fs = require('fs');
const path = require('path');

// =========================
// ENV
// =========================
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const MOD_ROLE_ID = process.env.DISCORD_MOD_ROLE_ID || null;
const DEFAULT_DROP_WINDOW_SECONDS = Number(process.env.DROP_WINDOW_SECONDS || 120);
const DEFAULT_RANDOM_DROP_START_HOUR_UTC = Number(process.env.RANDOM_DROP_START_HOUR_UTC || 14);
const DEFAULT_RANDOM_DROP_END_HOUR_UTC = Number(process.env.RANDOM_DROP_END_HOUR_UTC || 23);

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID');
  process.exit(1);
}

// =========================
// FILE STORAGE
// =========================
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function defaultGuildConfig() {
  return {
    snapsChannelId: null,
    snapsRoleId: null,
    nextScheduledDropTs: null,
    lastScheduledForDate: null,
    enabled: true,
    dropWindowSeconds: DEFAULT_DROP_WINDOW_SECONDS,
    randomStartHourUtc: DEFAULT_RANDOM_DROP_START_HOUR_UTC,
    randomEndHourUtc: DEFAULT_RANDOM_DROP_END_HOUR_UTC,
    allowLatePosts: true,
    previewEnabled: true,
    threadsEnabled: true,
    customMessage: 'Send **1 real-time photo** now.',
    customEmbedTitle: 'Time to BeReal',
    customFooter: 'Snap Bot',
    modRoleId: null,
  };
}

function defaultState() {
  return {
    guilds: {},
    members: {},
    currentDrops: {},
  };
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    const s = defaultState();
    saveState(s);
    return s;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!parsed.guilds) parsed.guilds = {};
    if (!parsed.members) parsed.members = {};
    if (!parsed.currentDrops) parsed.currentDrops = {};
    return parsed;
  } catch {
    const s = defaultState();
    saveState(s);
    return s;
  }
}

function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

let state = loadState();

// =========================
// HELPERS
// =========================
function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function utcDateKeyFromMs(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function memberKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function ensureGuildConfig(guildId) {
  if (!state.guilds[guildId]) {
    state.guilds[guildId] = defaultGuildConfig();
  } else {
    state.guilds[guildId] = {
      ...defaultGuildConfig(),
      ...state.guilds[guildId],
    };
  }
  return state.guilds[guildId];
}

function ensureMemberRecord(guildId, user) {
  const key = memberKey(guildId, user.id);
  if (!state.members[key]) {
    state.members[key] = {
      guildId,
      userId: user.id,
      displayName: user.username,
      streak: 0,
      totalOnTime: 0,
      totalLate: 0,
      totalDropsSeen: 0,
      lastOnTimeDate: null,
      lastAnyDate: null,
    };
  } else {
    state.members[key].displayName = user.username;
  }
  return state.members[key];
}

function getRandomDropUnixForTodayUTC(config) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();

  const startHour = clamp(config.randomStartHourUtc, 0, 23);
  const endHour = clamp(config.randomEndHourUtc, 0, 23);
  const low = Math.min(startHour, endHour);
  const high = Math.max(startHour, endHour);

  const start = Date.UTC(y, m, d, low, 0, 0) / 1000;
  const end = Date.UTC(y, m, d, high, 59, 59) / 1000;

  return randomInt(start, end);
}

function scheduleTodayIfNeeded(guildId) {
  const config = ensureGuildConfig(guildId);
  if (!config.enabled) return;
  if (!config.snapsChannelId || !config.snapsRoleId) return;

  const todayKey = utcDateKeyFromMs(Date.now());
  if (config.lastScheduledForDate === todayKey && config.nextScheduledDropTs) return;

  let ts = getRandomDropUnixForTodayUTC(config);
  const now = nowUnix();
  if (ts <= now + 30) ts = now + 300;

  config.nextScheduledDropTs = ts;
  config.lastScheduledForDate = todayKey;
  saveState(state);
}

function hasModAccess(member, config) {
  if (!member) return false;
  if (member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return true;
  if (config?.modRoleId && member.roles.cache.has(config.modRoleId)) return true;
  if (MOD_ROLE_ID && member.roles.cache.has(MOD_ROLE_ID)) return true;
  return false;
}

function isImageAttachment(att) {
  const ct = att.contentType || '';
  if (ct.startsWith('image/')) return true;
  const name = (att.name || '').toLowerCase();
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp'].some(ext => name.endsWith(ext));
}

function createDropButtons(dropId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`snap_sent_${dropId}`)
        .setLabel('Post Now')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`snap_skip_${dropId}`)
        .setLabel('Skip')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`snap_snooze_${dropId}`)
        .setLabel('Snooze 10m')
        .setStyle(ButtonStyle.Primary),
    ),
  ];
}

function buildDropEmbed(config, roleId, startTs, endTs, isTest = false) {
  return new EmbedBuilder()
    .setTitle(isTest ? `🧪 ${config.customEmbedTitle}` : `📸 ${config.customEmbedTitle}`)
    .setDescription([
      `<@&${roleId}>`,
      '',
      `**Started:** <t:${startTs}:F>`,
      `**Ends:** <t:${endTs}:F>`,
      `**Time left:** <t:${endTs}:R>`,
      '',
      config.customMessage,
      config.threadsEnabled ? 'Use the thread below to submit your photo.' : 'Submit your photo in this channel.',
      config.allowLatePosts ? 'Late posts are allowed and will be marked **late**.' : 'Late posts are **not allowed**.',
    ].join('\n'))
    .setFooter({ text: config.customFooter })
    .setTimestamp(new Date(startTs * 1000));
}

function buildPreviewEmbed(message, submittedAt, late, streak, threadLink) {
  return new EmbedBuilder()
    .setTitle('New BeReal')
    .setDescription([
      `📸 ${message.author}`,
      late ? '⏰ **Late submission**' : '✅ **On-time submission**',
      `🕒 Submitted: <t:${submittedAt}:F>`,
      threadLink ? `🧵 [Open thread](${threadLink})` : null,
      !late ? `🔥 Streak: **${streak}**` : null,
      message.content?.trim() ? `💬 ${message.content.trim()}` : null,
    ].filter(Boolean).join('\n'))
    .setImage(message.attachments.first()?.url || null)
    .setTimestamp(new Date(message.createdTimestamp));
}

function buildStatusText(guildId) {
  const config = ensureGuildConfig(guildId);
  const active = state.currentDrops[guildId];

  if (!config.snapsChannelId || !config.snapsRoleId) {
    return 'This server is not set up yet. Run `/setup` first.';
  }

  const lines = [
    `Enabled: **${config.enabled ? 'Yes' : 'No'}**`,
    `Channel: <#${config.snapsChannelId}>`,
    `Role: <@&${config.snapsRoleId}>`,
    `Window: **${Math.floor(config.dropWindowSeconds / 60)}m**`,
    `Random range: **${config.randomStartHourUtc}:00–${config.randomEndHourUtc}:59 UTC**`,
    `Threads: **${config.threadsEnabled ? 'On' : 'Off'}**`,
    `Preview reposts: **${config.previewEnabled ? 'On' : 'Off'}**`,
    `Late posts: **${config.allowLatePosts ? 'Allowed' : 'Blocked'}**`,
  ];

  if (active && active.active) {
    lines.push('', `**Active drop**`, `Started: <t:${active.startTs}:F>`, `Ends: <t:${active.endTs}:F>`, `Time left: <t:${active.endTs}:R>`, `Submissions: **${Object.keys(active.submissions).length}**`);
  } else if (config.nextScheduledDropTs) {
    lines.push('', `Next scheduled drop: <t:${config.nextScheduledDropTs}:F>`);
  }

  return lines.join('\n');
}

function registerOnTimeSubmission(guildId, user, submittedAtMs) {
  const rec = ensureMemberRecord(guildId, user);
  const dayKey = utcDateKeyFromMs(submittedAtMs);

  if (rec.lastOnTimeDate !== dayKey) {
    const yesterday = new Date(submittedAtMs - 86400000);
    const yesterdayKey = utcDateKeyFromMs(yesterday.getTime());

    if (rec.lastOnTimeDate === yesterdayKey) rec.streak += 1;
    else rec.streak = 1;

    rec.lastOnTimeDate = dayKey;
    rec.totalOnTime += 1;
  }

  rec.lastAnyDate = dayKey;
  return rec;
}

function registerLateSubmission(guildId, user, submittedAtMs) {
  const rec = ensureMemberRecord(guildId, user);
  const dayKey = utcDateKeyFromMs(submittedAtMs);

  if (rec.lastAnyDate !== dayKey) {
    rec.totalLate += 1;
    rec.lastAnyDate = dayKey;
  }

  return rec;
}

// =========================
// DROP LOGIC
// =========================
async function createDrop(client, guildId, opts = {}) {
  const config = ensureGuildConfig(guildId);
  const { forcedByUserId = null, isTest = false } = opts;

  if (!config.enabled && !isTest) {
    return { ok: false, error: 'Drops are disabled in this server.' };
  }

  if (!config.snapsChannelId || !config.snapsRoleId) {
    return { ok: false, error: 'This server is not set up yet. Run /setup first.' };
  }

  const existing = state.currentDrops[guildId];
  if (existing && existing.active) {
    return { ok: false, error: 'A drop is already active in this server.' };
  }

  const channel = await client.channels.fetch(config.snapsChannelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) {
    return { ok: false, error: 'Configured snaps channel is invalid.' };
  }

  const startTs = nowUnix();
  const endTs = startTs + config.dropWindowSeconds;
  const dropId = `${guildId}-${startTs}`;

  const messagePayload = {
    content: `<@&${config.snapsRoleId}>`,
    embeds: [buildDropEmbed(config, config.snapsRoleId, startTs, endTs, isTest)],
    components: createDropButtons(dropId),
    allowedMentions: { roles: [config.snapsRoleId] },
  };

  const msg = await channel.send(messagePayload);

  let thread = null;
  if (config.threadsEnabled) {
    thread = await msg.startThread({
      name: `BeReal ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      autoArchiveDuration: 60,
    }).catch(() => null);

    if (thread) {
      await thread.send(`Post your BeReal photo here. Window closes <t:${endTs}:R>.`).catch(() => {});
    }
  }

  state.currentDrops[guildId] = {
    id: dropId,
    guildId,
    active: true,
    test: isTest,
    startTs,
    endTs,
    channelId: channel.id,
    messageId: msg.id,
    threadId: thread?.id || null,
    roleId: config.snapsRoleId,
    forcedByUserId,
    submissions: {},
    skipped: [],
    snoozed: [],
  };

  saveState(state);
  return { ok: true, drop: state.currentDrops[guildId] };
}

async function closeActiveDrop(client, guildId, reason = 'closed') {
  const drop = state.currentDrops[guildId];
  if (!drop || !drop.active) return;

  drop.active = false;

  const channel = await client.channels.fetch(drop.channelId).catch(() => null);
  const thread = drop.threadId ? await client.channels.fetch(drop.threadId).catch(() => null) : null;

  const onTimeCount = Object.values(drop.submissions).filter(s => !s.late).length;
  const lateCount = Object.values(drop.submissions).filter(s => s.late).length;

  const title = reason === 'stopped' ? 'BeReal Stopped' : 'BeReal Closed';
  const icon = reason === 'stopped' ? '🛑' : '⏰';

  if (thread) {
    await thread.send(`${icon} **${title}**\nOn-time posts: **${onTimeCount}**\nLate posts: **${lateCount}**`).catch(() => {});
    await thread.setLocked(true).catch(() => {});
  }

  if (channel) {
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle(title)
          .setDescription([
            `On-time: **${onTimeCount}**`,
            `Late: **${lateCount}**`,
            `Started: <t:${drop.startTs}:F>`,
            `Ended: <t:${nowUnix()}:F>`,
          ].join('\n'))
          .setTimestamp(new Date()),
      ],
    }).catch(() => {});
  }

  saveState(state);
}

// =========================
// CLIENT
// =========================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// =========================
// COMMANDS
// =========================
const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Set the snaps channel and role for this server')
    .addChannelOption(option =>
      option.setName('channel').setDescription('Channel for drops').addChannelTypes(ChannelType.GuildText).setRequired(true)
    )
    .addRoleOption(option =>
      option.setName('role').setDescription('Role to ping').setRequired(true)
    ),

  new SlashCommandBuilder().setName('resetsetup').setDescription('Reset this server setup'),
  new SlashCommandBuilder().setName('join').setDescription('Join the snaps role'),
  new SlashCommandBuilder().setName('leave').setDescription('Leave the snaps role'),
  new SlashCommandBuilder().setName('dropnow').setDescription('Start a real drop now'),
  new SlashCommandBuilder().setName('testdrop').setDescription('Send a test drop now'),
  new SlashCommandBuilder().setName('stopdrops').setDescription('Disable automatic and manual drops'),
  new SlashCommandBuilder().setName('startdrops').setDescription('Enable drops again'),
  new SlashCommandBuilder().setName('snapsstatus').setDescription('Show current settings and drop status'),
  new SlashCommandBuilder().setName('streaks').setDescription('Show the streak leaderboard'),
  new SlashCommandBuilder().setName('mystats').setDescription('Show your BeReal stats'),

  new SlashCommandBuilder()
    .setName('setwindow')
    .setDescription('Set the drop window in minutes')
    .addIntegerOption(option =>
      option.setName('minutes').setDescription('1 to 30').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('setdroprange')
    .setDescription('Set the random daily drop UTC range')
    .addIntegerOption(option =>
      option.setName('start_hour').setDescription('0 to 23 UTC').setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName('end_hour').setDescription('0 to 23 UTC').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('setmessage')
    .setDescription('Set the custom drop message')
    .addStringOption(option =>
      option.setName('text').setDescription('Custom message text').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('setmodrole')
    .setDescription('Set a server-specific mod role for admin commands')
    .addRoleOption(option =>
      option.setName('role').setDescription('Role allowed to run mod commands').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('togglepreview')
    .setDescription('Turn preview reposts on or off')
    .addBooleanOption(option =>
      option.setName('enabled').setDescription('Preview reposts enabled').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('togglethreads')
    .setDescription('Turn submission threads on or off')
    .addBooleanOption(option =>
      option.setName('enabled').setDescription('Threads enabled').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('togglelateposts')
    .setDescription('Allow or block late photo submissions')
    .addBooleanOption(option =>
      option.setName('enabled').setDescription('Late posts allowed').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('setembedtitle')
    .setDescription('Set the drop embed title')
    .addStringOption(option =>
      option.setName('text').setDescription('Embed title').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('setfooter')
    .setDescription('Set the drop embed footer')
    .addStringOption(option =>
      option.setName('text').setDescription('Footer text').setRequired(true)
    ),

  new SlashCommandBuilder().setName('help').setDescription('Show snap bot help'),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log('Global slash commands registered.');
}

// =========================
// READY
// =========================
client.once('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) {
    ensureGuildConfig(guild.id);
    scheduleTodayIfNeeded(guild.id);
  }
});

// =========================
// INTERACTIONS
// =========================
client.on('interactionCreate', async interaction => {
  try {
    if (!interaction.inGuild()) return;
    const guildId = interaction.guildId;
    const config = ensureGuildConfig(guildId);

    if (interaction.isChatInputCommand()) {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const admin = hasModAccess(member, config);
      const reply = content => interaction.reply({ content, flags: MessageFlags.Ephemeral });

      if (interaction.commandName === 'help') {
        return reply([
          '**Snap Bot Commands**',
          '`/setup` set channel + role',
          '`/join` / `/leave` opt in or out',
          '`/dropnow` send a live drop',
          '`/testdrop` send a test drop',
          '`/snapsstatus` current status',
          '`/mystats` your stats',
          '`/streaks` leaderboard',
          '`/startdrops` / `/stopdrops` control drops',
          '`/setwindow`, `/setdroprange`, `/setmessage` customize behavior',
          '`/togglepreview`, `/togglethreads`, `/togglelateposts` feature toggles',
        ].join('\n'));
      }

      if (interaction.commandName === 'setup') {
        if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
          return reply('You need Manage Server to use this.');
        }

        const channel = interaction.options.getChannel('channel');
        const role = interaction.options.getRole('role');

        config.snapsChannelId = channel.id;
        config.snapsRoleId = role.id;
        config.enabled = true;
        config.nextScheduledDropTs = null;
        config.lastScheduledForDate = null;
        saveState(state);
        scheduleTodayIfNeeded(guildId);

        return reply(`✅ Setup saved\nChannel: <#${channel.id}>\nRole: <@&${role.id}>`);
      }

      if (interaction.commandName === 'resetsetup') {
        if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
          return reply('You need Manage Server to use this.');
        }

        state.guilds[guildId] = defaultGuildConfig();
        delete state.currentDrops[guildId];
        saveState(state);
        return reply('✅ Setup reset for this server. Run `/setup` again.');
      }

      if (!config.snapsChannelId || !config.snapsRoleId) {
        return reply('This server is not set up yet. Run `/setup` first.');
      }

      if (interaction.commandName === 'join') {
        const role = await interaction.guild.roles.fetch(config.snapsRoleId).catch(() => null);
        if (!role) return reply('Configured role not found. Run `/setup` again.');
        await member.roles.add(role);
        ensureMemberRecord(guildId, interaction.user);
        saveState(state);
        return reply(`✅ You joined ${role}.`);
      }

      if (interaction.commandName === 'leave') {
        const role = await interaction.guild.roles.fetch(config.snapsRoleId).catch(() => null);
        if (!role) return reply('Configured role not found. Run `/setup` again.');
        await member.roles.remove(role).catch(() => {});
        return reply(`✅ You left ${role}.`);
      }

      if (interaction.commandName === 'startdrops') {
        if (!admin) return reply('You do not have permission to do that.');
        config.enabled = true;
        config.nextScheduledDropTs = null;
        config.lastScheduledForDate = null;
        saveState(state);
        scheduleTodayIfNeeded(guildId);
        return reply('✅ Drops are now enabled in this server.');
      }

      if (interaction.commandName === 'stopdrops') {
        if (!admin) return reply('You do not have permission to do that.');
        config.enabled = false;
        config.nextScheduledDropTs = null;
        config.lastScheduledForDate = null;
        if (state.currentDrops[guildId]?.active) {
          await closeActiveDrop(client, guildId, 'stopped');
        }
        saveState(state);
        return reply('🛑 Drops are now disabled in this server.');
      }

      if (interaction.commandName === 'dropnow' || interaction.commandName === 'testdrop') {
        if (!admin) return reply('You do not have permission to do that.');
        const result = await createDrop(client, guildId, {
          forcedByUserId: interaction.user.id,
          isTest: interaction.commandName === 'testdrop',
        });
        if (!result.ok) return reply(result.error);
        return reply(`✅ Drop started in <#${result.drop.channelId}>\nEnds: <t:${result.drop.endTs}:R>`);
      }

      if (interaction.commandName === 'snapsstatus') {
        return reply(buildStatusText(guildId));
      }

      if (interaction.commandName === 'streaks') {
        return interaction.reply({
          content: `**BeReal Leaderboard**\n${buildLeaderboard(guildId)}`,
          allowedMentions: { parse: [] },
        });
      }

      if (interaction.commandName === 'mystats') {
        const rec = ensureMemberRecord(guildId, interaction.user);
        return reply([
          `**Your Snap Stats**`,
          `Streak: **${rec.streak}**`,
          `On-time: **${rec.totalOnTime}**`,
          `Late: **${rec.totalLate}**`,
        ].join('\n'));
      }

      if (interaction.commandName === 'setwindow') {
        if (!admin) return reply('You do not have permission to do that.');
        const minutes = clamp(interaction.options.getInteger('minutes'), 1, 30);
        config.dropWindowSeconds = minutes * 60;
        saveState(state);
        return reply(`✅ Drop window set to **${minutes} minutes**.`);
      }

      if (interaction.commandName === 'setdroprange') {
        if (!admin) return reply('You do not have permission to do that.');
        const start = clamp(interaction.options.getInteger('start_hour'), 0, 23);
        const end = clamp(interaction.options.getInteger('end_hour'), 0, 23);
        config.randomStartHourUtc = start;
        config.randomEndHourUtc = end;
        config.nextScheduledDropTs = null;
        config.lastScheduledForDate = null;
        saveState(state);
        scheduleTodayIfNeeded(guildId);
        return reply(`✅ Random drop range set to **${start}:00–${end}:59 UTC**.`);
      }

      if (interaction.commandName === 'setmessage') {
        if (!admin) return reply('You do not have permission to do that.');
        config.customMessage = interaction.options.getString('text').slice(0, 500);
        saveState(state);
        return reply('✅ Custom drop message updated.');
      }

      if (interaction.commandName === 'setmodrole') {
        if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
          return reply('You need Manage Server to use this.');
        }
        const role = interaction.options.getRole('role');
        config.modRoleId = role.id;
        saveState(state);
        return reply(`✅ Mod role set to ${role}.`);
      }

      if (interaction.commandName === 'togglepreview') {
        if (!admin) return reply('You do not have permission to do that.');
        config.previewEnabled = interaction.options.getBoolean('enabled');
        saveState(state);
        return reply(`✅ Preview reposts are now **${config.previewEnabled ? 'on' : 'off'}**.`);
      }

      if (interaction.commandName === 'togglethreads') {
        if (!admin) return reply('You do not have permission to do that.');
        config.threadsEnabled = interaction.options.getBoolean('enabled');
        saveState(state);
        return reply(`✅ Threads are now **${config.threadsEnabled ? 'on' : 'off'}**.`);
      }

      if (interaction.commandName === 'togglelateposts') {
        if (!admin) return reply('You do not have permission to do that.');
        config.allowLatePosts = interaction.options.getBoolean('enabled');
        saveState(state);
        return reply(`✅ Late posts are now **${config.allowLatePosts ? 'allowed' : 'blocked'}**.`);
      }

      if (interaction.commandName === 'setembedtitle') {
        if (!admin) return reply('You do not have permission to do that.');
        config.customEmbedTitle = interaction.options.getString('text').slice(0, 100);
        saveState(state);
        return reply('✅ Embed title updated.');
      }

      if (interaction.commandName === 'setfooter') {
        if (!admin) return reply('You do not have permission to do that.');
        config.customFooter = interaction.options.getString('text').slice(0, 100);
        saveState(state);
        return reply('✅ Embed footer updated.');
      }
    }

    if (interaction.isButton()) {
      const guildId = interaction.guildId;
      const drop = state.currentDrops[guildId];
      if (!drop) {
        return interaction.reply({ content: 'That drop is no longer active.', flags: MessageFlags.Ephemeral });
      }

      const [prefix, action, ...rest] = interaction.customId.split('_');
      const dropId = rest.join('_');

      if (prefix !== 'snap') return;
      if (!drop.active || drop.id !== dropId) {
        return interaction.reply({ content: 'That drop is no longer active.', flags: MessageFlags.Ephemeral });
      }

      if (action === 'sent') {
        const target = drop.threadId ? `<#${drop.threadId}>` : `<#${drop.channelId}>`;
        return interaction.reply({ content: `📸 Post your image in ${target}`, flags: MessageFlags.Ephemeral });
      }

      if (action === 'skip') {
        if (!drop.skipped.includes(interaction.user.id)) {
          drop.skipped.push(interaction.user.id);
          saveState(state);
        }
        return interaction.reply({ content: 'Marked as skipped for this drop.', flags: MessageFlags.Ephemeral });
      }

      if (action === 'snooze') {
        if (!drop.snoozed.includes(interaction.user.id)) {
          drop.snoozed.push(interaction.user.id);
          saveState(state);
        }
        return interaction.reply({ content: 'Snoozed for 10 minutes.', flags: MessageFlags.Ephemeral });
      }
    }
  } catch (err) {
    console.error('INTERACTION ERROR:', err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: `Error: ${err.message || 'Something went wrong.'}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

// =========================
// MESSAGE HANDLING
// =========================
client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;

  const guildId = message.guild.id;
  const config = ensureGuildConfig(guildId);
  const drop = state.currentDrops[guildId];
  if (!drop || !drop.active) return;

  const validChannel = drop.threadId ? message.channel.id === drop.threadId : message.channel.id === drop.channelId;
  if (!validChannel) return;

  const member = await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member) return;
  if (!member.roles.cache.has(drop.roleId)) {
    await message.reply('You need the snaps role to participate.').catch(() => {});
    return;
  }

  const attachments = [...message.attachments.values()];
  const imageAttachments = attachments.filter(isImageAttachment);
  if (!imageAttachments.length) {
    await message.reply('Please send an image attachment for your BeReal post.').catch(() => {});
    return;
  }

  if (drop.submissions[message.author.id]) {
    await message.reply('You already posted for this drop. One post only.').catch(() => {});
    return;
  }

  const submittedAt = Math.floor(message.createdTimestamp / 1000);
  const late = submittedAt > drop.endTs;
  if (late && !config.allowLatePosts) {
    await message.reply('Late posts are disabled for this server.').catch(() => {});
    return;
  }

  drop.submissions[message.author.id] = {
    submittedAt,
    late,
    messageId: message.id,
    previewMessageId: null,
  };

  const rec = late
    ? registerLateSubmission(guildId, message.author, message.createdTimestamp)
    : registerOnTimeSubmission(guildId, message.author, message.createdTimestamp);

  saveState(state);

  await message.reply(
    late
      ? `⏰ Late BeReal recorded.\nSubmitted: <t:${submittedAt}:F>`
      : `✅ On-time BeReal recorded.\nSubmitted: <t:${submittedAt}:F>\nCurrent streak: **${rec.streak}**`
  ).catch(() => {});

  if (!config.previewEnabled) return;

  const mainChannel = await client.channels.fetch(drop.channelId).catch(() => null);
  if (!mainChannel) return;

  const threadLink = drop.threadId ? `https://discord.com/channels/${message.guild.id}/${drop.threadId}` : null;
  const embed = buildPreviewEmbed(message, submittedAt, late, rec.streak, threadLink);

  const previewMessage = await mainChannel.send({ embeds: [embed], allowedMentions: { parse: ['users'] } }).catch(() => null);
  if (previewMessage) {
    drop.submissions[message.author.id].previewMessageId = previewMessage.id;
    saveState(state);
  }
});

// =========================
// SCHEDULER
// =========================
setInterval(async () => {
  try {
    for (const guildId of Object.keys(state.guilds)) {
      const config = ensureGuildConfig(guildId);
      if (!config.enabled) continue;
      if (!config.snapsChannelId || !config.snapsRoleId) continue;

      scheduleTodayIfNeeded(guildId);

      const now = nowUnix();
      const activeDrop = state.currentDrops[guildId];

      if (config.nextScheduledDropTs && now >= config.nextScheduledDropTs) {
        if (!activeDrop || !activeDrop.active) {
          const result = await createDrop(client, guildId);
          if (result.ok) {
            config.nextScheduledDropTs = null;
            saveState(state);
          }
        } else {
          config.nextScheduledDropTs = null;
          saveState(state);
        }
      }

      if (activeDrop && activeDrop.active && now > activeDrop.endTs) {
        await closeActiveDrop(client, guildId, 'closed');
      }

      const todayKey = utcDateKeyFromMs(Date.now());
      if (config.lastScheduledForDate !== todayKey) {
        scheduleTodayIfNeeded(guildId);
      }
    }
  } catch (err) {
    console.error('SCHEDULER ERROR:', err);
  }
}, 15000);

// =========================
// STARTUP
// =========================
(async () => {
  try {
  await rest.put(
  Routes.applicationCommands(CLIENT_ID),
  { body: commands }
);

console.log('✅ Commands registered');
