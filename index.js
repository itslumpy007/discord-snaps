require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  SlashCommandBuilder,
  Routes,
  REST,
  ChannelType
} = require('discord.js');

const fs = require('fs');
const path = require('path');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = '1428244067124383757';

// ===== STORAGE =====
const DATA_FILE = path.join(__dirname, 'data', 'state.json');

if (!fs.existsSync('data')) fs.mkdirSync('data');

let state = { guilds: {} };

if (fs.existsSync(DATA_FILE)) {
  try {
    state = JSON.parse(fs.readFileSync(DATA_FILE));
  } catch {}
}

function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

function getGuild(guildId) {
  if (!state.guilds[guildId]) {
    state.guilds[guildId] = {
      channel: null,
      role: null,
      enabled: true
    };
  }
  return state.guilds[guildId];
}

// ===== CLIENT =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

// ===== COMMANDS =====
const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Setup snaps system')
    .addChannelOption(o =>
      o.setName('channel').setRequired(true).setDescription('Snaps channel'))
    .addRoleOption(o =>
      o.setName('role').setRequired(true).setDescription('Snaps role')),

  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join snaps'),

  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Leave snaps'),

  new SlashCommandBuilder()
    .setName('dropnow')
    .setDescription('Start drop'),

  new SlashCommandBuilder()
    .setName('stopdrops')
    .setDescription('Disable drops'),

  new SlashCommandBuilder()
    .setName('startdrops')
    .setDescription('Enable drops'),
].map(c => c.toJSON());

// ===== REGISTER =====
async function register() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );

  console.log('✅ Commands registered instantly');
}

// ===== READY =====
client.once('ready', () => {
  console.log(`🟢 Logged in as ${client.user.tag}`);
});

// ===== COMMAND HANDLER =====
client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;

  const g = getGuild(i.guildId);

  if (i.commandName === 'setup') {
    if (!i.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return i.reply({ content: 'No permission', ephemeral: true });
    }

    g.channel = i.options.getChannel('channel').id;
    g.role = i.options.getRole('role').id;
    g.enabled = true;

    save();

    return i.reply({
      content: `✅ Setup saved\nChannel: <#${g.channel}>\nRole: <@&${g.role}>`,
      ephemeral: true
    });
  }

  if (!g.channel || !g.role) {
    return i.reply({ content: 'Run /setup first', ephemeral: true });
  }

  if (i.commandName === 'join') {
    const role = await i.guild.roles.fetch(g.role);
    await i.member.roles.add(role);
    return i.reply({ content: `Joined ${role}`, ephemeral: true });
  }

  if (i.commandName === 'leave') {
    const role = await i.guild.roles.fetch(g.role);
    await i.member.roles.remove(role);
    return i.reply({ content: `Left ${role}`, ephemeral: true });
  }

  if (i.commandName === 'stopdrops') {
    if (!i.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return i.reply({ content: 'No permission', ephemeral: true });
    }

    g.enabled = false;
    save();

    return i.reply({ content: '🛑 Drops disabled', ephemeral: true });
  }

  if (i.commandName === 'startdrops') {
    if (!i.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return i.reply({ content: 'No permission', ephemeral: true });
    }

    g.enabled = true;
    save();

    return i.reply({ content: '✅ Drops enabled', ephemeral: true });
  }

  if (i.commandName === 'dropnow') {
    if (!g.enabled) {
      return i.reply({ content: 'Drops are disabled', ephemeral: true });
    }

    const channel = await client.channels.fetch(g.channel);

    await channel.send({
      content: `<@&${g.role}> 📸 Time to BeReal!\nSend your photo now!`
    });

    return i.reply({ content: 'Drop started', ephemeral: true });
  }
});

// ===== START =====
(async () => {
  await register();
  await client.login(TOKEN);
})();