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
// ENV / CONFIG
// =========================
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const MOD_ROLE_ID = process.env.DISCORD_MOD_ROLE_ID || null;

const DROP_WINDOW_SECONDS = Number(process.env.DROP_WINDOW_SECONDS || 120);
const RANDOM_DROP_START_HOUR_UTC = Number(process.env.RANDOM_DROP_START_HOUR_UTC || 14);
const RANDOM_DROP_END_HOUR_UTC = Number(process.env.RANDOM_DROP_END_HOUR_UTC || 23);

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing env vars: DISCORD_TOKEN or DISCORD_CLIENT_ID');
  process.exit(1);
}

// =========================
// STORAGE
// =========================
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function defaultState() {
  return {
    guilds: {},       // guildId -> config
    members: {},      // guildId:userId -> stats
    currentDrops: {}, // guildId -> active drop
  };
}

function loadState() {
  let s;

  if (!fs.existsSync(STATE_FILE)) {
    s = defaultState();
    saveState(s);
    return s;
  }

  try {
    s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    s = defaultState();
    saveState(s);
    return s;
  }

  if (!s.guilds) s.guilds = {};
  if (!s.members) s.members = {};
  if (!s.currentDrops) s.currentDrops = {};

  saveState(s);
  return s;
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

let state = loadState();

// =========================
// HELPERS
// =========================
function memberKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function utcDateKeyFromMs(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function ensureGuildConfig(guildId) {
  if (!state.guilds[guildId]) {
    state.guilds[guildId] = {
      snapsChannelId: null,
      snapsRoleId: null,
      nextScheduledDropTs: null,
      lastScheduledForDate: null,
      enabled: true,
    };
  }

  if (typeof state.guilds[guildId].enabled !== 'boolean') {
    state.guilds[guildId].enabled = true;
  }

  return state.guilds[guildId];
}

function ensureMemberRecord(guildId, user) {
  const key = memberKey(guildId, user.id);

  if (!state.members[key]) {
    state.members[key] = {
      guildId,
      userId: user.id,
      streak: 0,
      lastOnTimeDate: null,
      lastAnyDate: null,
      totalOnTime: 0,
      totalLate: 0,
      displayName: user.username,
    };
  } else {
    state.members[key].displayName = user.username;
  }

  return state.members[key];
}

function isImageAttachment(att) {
  const ct = att.contentType || '';
  if (ct.startsWith('image/')) return true;

  const name = (att.name || '').toLowerCase();
  return (
    name.endsWith('.png') ||
    name.endsWith('.jpg') ||
    name.endsWith('.jpeg') ||
    name.endsWith('.gif') ||
    name.endsWith('.webp')
  );
}

function hasModAccess(member) {
  if (!member) return false;
  if (member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return true;
  if (MOD_ROLE_ID && member.roles.cache.has(MOD_ROLE_ID)) return true;
  return false;
}

function getRandomDropUnixForTodayUTC() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();

  const start = Date.UTC(y, m, d, RANDOM_DROP_START_HOUR_UTC, 0, 0) / 1000;
  const end = Date.UTC(y, m, d, RANDOM_DROP_END_HOUR_UTC, 59, 59) / 1000;

  return randomInt(start, end);
}

function scheduleTodayIfNeeded(guildId) {
  const config = ensureGuildConfig(guildId);

  if (!config.enabled) return;
  if (!config.snapsChannelId || !config.snapsRoleId) return;

  const todayKey = utcDateKeyFromMs(Date.now());
  if (config.lastScheduledForDate === todayKey && config.nextScheduledDropTs) return;

  let ts = getRandomDropUnixForTodayUTC();
  const now = nowUnix();

  if (ts <= now + 30) ts = now + 300;

  config.nextScheduledDropTs = ts;
  config.lastScheduledForDate = todayKey;
  saveState(state);
}

function buildDropButtons(dropId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`snap_status_sent_${dropId}`)
        .setLabel('Sent')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`snap_status_skip_${dropId}`)
        .setLabel('Skip')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`snap_status_snooze_${dropId}`)
        .setLabel('Snooze 10m')
        .setStyle(ButtonStyle.Primary)
    ),
  ];
}

function buildDropMessage(roleId, drop) {
  return [
    `<@&${roleId}> 📸 **Time to BeReal.**`,
    ``,
    `**UTC start:** <t:${drop.startTs}:F>`,
    `**UTC end:** <t:${drop.endTs}:F>`,
    `**Time left:** <t:${drop.endTs}:R>`,
    ``,
    `Send **1 real-time photo** in the thread below.`,
    `Your photo will also be reposted as a preview in this channel.`,
    `Late posts are allowed, but marked **late**.`,
  ].join('\n');
}

function buildLeaderboard(guildId) {
  const entries = Object.values(state.members)
    .filter(rec => rec.guildId === guildId)
    .sort((a, b) => {
      if (b.streak !== a.streak) return b.streak - a.streak;
      return b.totalOnTime - a.totalOnTime;
    })
    .slice(0, 10);

  if (!entries.length) return 'No streak data yet.';

  return entries.map((e, i) =>
    `${i + 1}. <@${e.userId}> — streak **${e.streak}**, on-time **${e.totalOnTime}**, late **${e.totalLate}**`
  ).join('\n');
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
}

function registerLateSubmission(guildId, user, submittedAtMs) {
  const rec = ensureMemberRecord(guildId, user);
  const dayKey = utcDateKeyFromMs(submittedAtMs);

  if (rec.lastAnyDate !== dayKey) {
    rec.totalLate += 1;
    rec.lastAnyDate = dayKey;
  }
}

// =========================
// DROP CREATION / CLOSING
// =========================
async function createDrop(client, guildId, forcedByUserId = null) {
  const config = ensureGuildConfig(guildId);

  if (!config.enabled) {
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
  const endTs = startTs + DROP_WINDOW_SECONDS;
  const dropId = `${guildId}-${startTs}`;

  const msg = await channel.send({
    content: buildDropMessage(config.snapsRoleId, { startTs, endTs }),
    components: buildDropButtons(dropId),
    allowedMentions: { roles: [config.snapsRoleId] },
  });

  const thread = await msg.startThread({
    name: `BeReal ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    autoArchiveDuration: 60,
  });

  await thread.send(`Post your BeReal photo here.\nWindow closes <t:${endTs}:R>.`);

  state.currentDrops[guildId] = {
    id: dropId,
    guildId,
    active: true,
    startTs,
    endTs,
    channelId: channel.id,
    messageId: msg.id,
    threadId: thread.id,
    roleId: config.snapsRoleId,
    forcedByUserId,
    submissions: {},
    skipped: [],
    snoozed: [],
  };

  saveState(state);
  return { ok: true, drop: state.currentDrops[guildId] };
}

async function closeActiveDrop(client, guildId, closedByCommand = false) {
  const drop = state.currentDrops[guildId];
  if (!drop || !drop.active) return;

  drop.active = false;

  const channel = await client.channels.fetch(drop.channelId).catch(() => null);
  const thread = await client.channels.fetch(drop.threadId).catch(() => null);

  const onTimeCount = Object.values(drop.submissions).filter(s => !s.late).length;
  const lateCount = Object.values(drop.submissions).filter(s => s.late).length;

  if (thread) {
    const closeText = closedByCommand
      ? `🛑 **Drop stopped by admin**\nOn-time posts: **${onTimeCount}**\nLate posts: **${lateCount}**`
      : `⏰ **Drop closed**\nOn-time posts: **${onTimeCount}**\nLate posts: **${lateCount}**`;

    await thread.send(closeText).catch(() => {});
    await thread.setLocked(true).catch(() => {});
  }

  if (channel) {
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle(closedByCommand ? 'BeReal Stopped' : 'BeReal Closed')
          .setDescription(
            `On-time: **${onTimeCount}**\nLate: **${lateCount}**\nStarted: <t:${drop.startTs}:F>\nEnded: <t:${nowUnix()}:F>`
          )
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
      option.setName('channel')
        .setDescription('The channel for BeReal drops')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    )
    .addRoleOption(option =>
      option.setName('role')
        .setDescription('The role to ping for BeReal drops')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join the snaps role'),

  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Leave the snaps role'),

  new SlashCommandBuilder()
    .setName('dropnow')
    .setDescription('Start a drop now (mods only)'),

  new SlashCommandBuilder()
    .setName('stopdrops')
    .setDescription('Disable BeReal drops in this server'),

  new SlashCommandBuilder()
    .setName('startdrops')
    .setDescription('Enable BeReal drops in this server'),

  new SlashCommandBuilder()
    .setName('snapsstatus')
    .setDescription('Show current drop status'),

  new SlashCommandBuilder()
    .setName('streaks')
    .setDescription('Show the BeReal leaderboard'),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(
    Routes.applicationCommands(CLIENT_ID),
    { body: commands }
  );
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
client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.inGuild()) return;

    if (interaction.isChatInputCommand()) {
      const guildId = interaction.guildId;
      const config = ensureGuildConfig(guildId);
      const guildMember = await interaction.guild.members.fetch(interaction.user.id);

      if (interaction.commandName === 'setup') {
        if (!guildMember.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
          return interaction.reply({
            content: 'You need Manage Server to use this.',
            flags: MessageFlags.Ephemeral,
          });
        }

        const channel = interaction.options.getChannel('channel');
        const role = interaction.options.getRole('role');

        if (!channel || channel.type !== ChannelType.GuildText) {
          return interaction.reply({
            content: 'Please choose a normal text channel.',
            flags: MessageFlags.Ephemeral,
          });
        }

        config.snapsChannelId = channel.id;
        config.snapsRoleId = role.id;
        config.nextScheduledDropTs = null;
        config.lastScheduledForDate = null;
        config.enabled = true;

        saveState(state);
        scheduleTodayIfNeeded(guildId);

        return interaction.reply({
          content: `✅ Setup saved\nChannel: <#${channel.id}>\nRole: <@&${role.id}>`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (interaction.commandName === 'stopdrops') {
        if (!guildMember.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
          return interaction.reply({
            content: 'You need Manage Server to do this.',
            flags: MessageFlags.Ephemeral,
          });
        }

        config.enabled = false;
        config.nextScheduledDropTs = null;
        config.lastScheduledForDate = null;

        if (state.currentDrops[guildId]?.active) {
          await closeActiveDrop(client, guildId, true);
        }

        saveState(state);

        return interaction.reply({
          content: '🛑 Drops are now disabled in this server.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (interaction.commandName === 'startdrops') {
        if (!guildMember.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
          return interaction.reply({
            content: 'You need Manage Server to do this.',
            flags: MessageFlags.Ephemeral,
          });
        }

        config.enabled = true;
        config.nextScheduledDropTs = null;
        config.lastScheduledForDate = null;

        saveState(state);
        scheduleTodayIfNeeded(guildId);

        return interaction.reply({
          content: '✅ Drops are now enabled in this server.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (!config.snapsChannelId || !config.snapsRoleId) {
        return interaction.reply({
          content: 'This server is not set up yet. Run `/setup` first.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (interaction.commandName === 'join') {
        const role = await interaction.guild.roles.fetch(config.snapsRoleId).catch(() => null);
        if (!role) {
          return interaction.reply({
            content: 'Configured role not found.',
            flags: MessageFlags.Ephemeral,
          });
        }

        await guildMember.roles.add(role);
        ensureMemberRecord(guildId, interaction.user);
        saveState(state);

        return interaction.reply({
          content: `You joined ${role}.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (interaction.commandName === 'leave') {
        const role = await interaction.guild.roles.fetch(config.snapsRoleId).catch(() => null);
        if (!role) {
          return interaction.reply({
            content: 'Configured role not found.',
            flags: MessageFlags.Ephemeral,
          });
        }

        await guildMember.roles.remove(role).catch(() => {});
        return interaction.reply({
          content: `You left ${role}.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (interaction.commandName === 'dropnow') {
        if (!hasModAccess(guildMember)) {
          return interaction.reply({
            content: 'You do not have permission to do that.',
            flags: MessageFlags.Ephemeral,
          });
        }

        const result = await createDrop(client, guildId, interaction.user.id);
        if (!result.ok) {
          return interaction.reply({
            content: result.error,
            flags: MessageFlags.Ephemeral,
          });
        }

        return interaction.reply({
          content: `✅ Drop started.\nUTC start: <t:${result.drop.startTs}:F>\nEnds: <t:${result.drop.endTs}:R>`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (interaction.commandName === 'snapsstatus') {
        if (!config.enabled) {
          return interaction.reply({
            content: 'Drops are currently disabled in this server.',
            flags: MessageFlags.Ephemeral,
          });
        }

        const drop = state.currentDrops[guildId];
        if (!drop || !drop.active) {
          const next = config.nextScheduledDropTs
            ? `Next scheduled drop: <t:${config.nextScheduledDropTs}:F>`
            : 'No drop scheduled.';
          return interaction.reply({
            content: `No active drop.\n${next}`,
            flags: MessageFlags.Ephemeral,
          });
        }

        const count = Object.keys(drop.submissions).length;
        return interaction.reply({
          content:
            `**Active drop**\n` +
            `Started: <t:${drop.startTs}:F>\n` +
            `Ends: <t:${drop.endTs}:F>\n` +
            `Time left: <t:${drop.endTs}:R>\n` +
            `Submissions: **${count}**`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (interaction.commandName === 'streaks') {
        return interaction.reply({
          content: `**BeReal Leaderboard**\n${buildLeaderboard(guildId)}`,
          allowedMentions: { parse: [] },
        });
      }
    }

    if (interaction.isButton()) {
      if (!interaction.inGuild()) return;

      const guildId = interaction.guildId;
      const drop = state.currentDrops[guildId];
      if (!drop) {
        return interaction.reply({
          content: 'That drop is no longer active.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const [prefix, kind, action, ...rest] = interaction.customId.split('_');
      const dropId = rest.join('_');

      if (prefix !== 'snap' || kind !== 'status') return;
      if (!drop.active || drop.id !== dropId) {
        return interaction.reply({
          content: 'That drop is no longer active.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (action === 'sent') {
        return interaction.reply({
          content: `Post your image in the thread: <#${drop.threadId}>`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (action === 'skip') {
        if (!drop.skipped.includes(interaction.user.id)) {
          drop.skipped.push(interaction.user.id);
          saveState(state);
        }
        return interaction.reply({
          content: 'Marked as skipped for this drop.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (action === 'snooze') {
        if (!drop.snoozed.includes(interaction.user.id)) {
          drop.snoozed.push(interaction.user.id);
          saveState(state);
        }
        return interaction.reply({
          content: 'Snoozed for 10 minutes.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  } catch (err) {
    console.error('INTERACTION ERROR:', err);

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: `Error: ${err.message || 'Something went wrong.'}`,
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }
  }
});

// =========================
// MESSAGE HANDLING
// =========================
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  const guildId = message.guild.id;
  const drop = state.currentDrops[guildId];
  if (!drop || !drop.active) return;
  if (message.channel.id !== drop.threadId) return;

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

  drop.submissions[message.author.id] = {
    submittedAt,
    late,
    messageId: message.id,
    previewMessageId: null,
  };

  if (late) registerLateSubmission(guildId, message.author, message.createdTimestamp);
  else registerOnTimeSubmission(guildId, message.author, message.createdTimestamp);

  saveState(state);

  const rec = ensureMemberRecord(guildId, message.author);

  const reply = late
    ? `⏰ Late BeReal recorded.\nSubmitted: <t:${submittedAt}:F>`
    : `✅ On-time BeReal recorded.\nSubmitted: <t:${submittedAt}:F>\nCurrent streak: **${rec.streak}**`;

  await message.reply(reply).catch(() => {});

  const mainChannel = await client.channels.fetch(drop.channelId).catch(() => null);
  if (!mainChannel) return;

  const firstImage = imageAttachments[0];
  const threadLink = `https://discord.com/channels/${message.guild.id}/${drop.threadId}`;

  const embed = new EmbedBuilder()
    .setTitle('New BeReal')
    .setDescription(
      [
        `📸 ${message.author}`,
        late ? '⏰ **Late submission**' : '✅ **On-time submission**',
        `🕒 Submitted: <t:${submittedAt}:F>`,
        `🧵 [Open thread](${threadLink})`,
        !late ? `🔥 Streak: **${rec.streak}**` : null,
        message.content?.trim() ? `💬 ${message.content.trim()}` : null,
      ].filter(Boolean).join('\n')
    )
    .setImage(firstImage.url)
    .setTimestamp(new Date(message.createdTimestamp));

  const previewMessage = await mainChannel.send({
    embeds: [embed],
    allowedMentions: { parse: ['users'] },
  }).catch(() => null);

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
        await closeActiveDrop(client, guildId);
      }

      const todayKey = utcDateKeyFromMs(Date.now());
      if (config.lastScheduledForDate !== todayKey) {
        scheduleTodayIfNeeded(guildId);
      }
    }
  } catch (err) {
    console.error('Scheduler error:', err);
  }
}, 15000);

// =========================
// STARTUP
// =========================
(async () => {
  try {
    await registerCommands();
    await client.login(TOKEN);
  } catch (err) {
    console.error('STARTUP ERROR:', err);
  }
})();