require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  Routes,
  REST,
  PermissionFlagsBits,
  EmbedBuilder,
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("Missing DISCORD_TOKEN, DISCORD_CLIENT_ID, or DISCORD_GUILD_ID in .env");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

/*
  CONFIG
*/
const config = {
  snapChannelName: "snap",
  maxDropsPerDay: 3,
  cooldownMinutes: 10,
  autoDeleteHours: 24,
  vipRoleName: "Snap VIP",
  allowTextCaptionOnly: false, // false = must include attachment
};

const userData = new Map();
/*
userData structure:
userId: {
  dailyCount: number,
  dailyResetAt: number,
  lastDropAt: number,
  totalDrops: number,
  streak: number,
  bestStreak: number,
  lastDropDayKey: string
}
*/

function now() {
  return Date.now();
}

function getDayKey(timestamp = Date.now()) {
  const d = new Date(timestamp);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getTomorrowUtcMidnight() {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

function getUserEntry(userId) {
  let entry = userData.get(userId);

  if (!entry) {
    entry = {
      dailyCount: 0,
      dailyResetAt: getTomorrowUtcMidnight(),
      lastDropAt: 0,
      totalDrops: 0,
      streak: 0,
      bestStreak: 0,
      lastDropDayKey: null,
    };
    userData.set(userId, entry);
  }

  if (now() >= entry.dailyResetAt) {
    entry.dailyCount = 0;
    entry.dailyResetAt = getTomorrowUtcMidnight();
  }

  return entry;
}

function formatDuration(ms) {
  const totalSeconds = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function hasVipBypass(member) {
  if (!member) return false;
  return member.roles.cache.some((role) => role.name === config.vipRoleName);
}

function updateStreak(entry) {
  const today = getDayKey();
  const yesterday = getDayKey(Date.now() - 24 * 60 * 60 * 1000);

  if (!entry.lastDropDayKey) {
    entry.streak = 1;
  } else if (entry.lastDropDayKey === today) {
    // same day, keep streak
  } else if (entry.lastDropDayKey === yesterday) {
    entry.streak += 1;
  } else {
    entry.streak = 1;
  }

  entry.lastDropDayKey = today;
  if (entry.streak > entry.bestStreak) {
    entry.bestStreak = entry.streak;
  }
}

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("snapstats")
      .setDescription("View your snap stats or another user's stats")
      .addUserOption((option) =>
        option.setName("user").setDescription("User to check").setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName("snapleaderboard")
      .setDescription("View the snap leaderboard"),

    new SlashCommandBuilder()
      .setName("setdrops")
      .setDescription("Set max drops per day")
      .addIntegerOption((option) =>
        option.setName("amount").setDescription("Max drops per day").setRequired(true)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName("setcooldown")
      .setDescription("Set cooldown in minutes between drops")
      .addIntegerOption((option) =>
        option.setName("minutes").setDescription("Cooldown in minutes").setRequired(true)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName("setautodelete")
      .setDescription("Set auto delete time in hours")
      .addIntegerOption((option) =>
        option.setName("hours").setDescription("Hours before snaps delete").setRequired(true)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName("setviprole")
      .setDescription("Set VIP role name that bypasses limits")
      .addStringOption((option) =>
        option.setName("role_name").setDescription("Exact role name").setRequired(true)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName("snapconfig")
      .setDescription("View current snap bot config")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  ].map((cmd) => cmd.toJSON());

  const rest = new REST({ version: "10" }).setToken(TOKEN);

  try {
    console.log("Refreshing application commands...");
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: commands,
    });
    console.log("Slash commands registered.");
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;
    if (message.author.bot) return;
    if (message.channel.name !== config.snapChannelName) return;

    const hasAttachment = message.attachments.size > 0;
    if (!hasAttachment && !config.allowTextCaptionOnly) {
      await message.reply("📸 You need to attach a photo or video to drop a snap.");
      return;
    }

    const member = message.member;
    const isVip = hasVipBypass(member);
    const entry = getUserEntry(message.author.id);

    if (!isVip) {
      const cooldownMs = config.cooldownMinutes * 60 * 1000;
      const timeSinceLastDrop = now() - entry.lastDropAt;

      if (entry.lastDropAt > 0 && timeSinceLastDrop < cooldownMs) {
        const remaining = cooldownMs - timeSinceLastDrop;
        await message.reply(`⏳ You need to wait **${formatDuration(remaining)}** before dropping again.`);
        return;
      }

      if (entry.dailyCount >= config.maxDropsPerDay) {
        const resetIn = entry.dailyResetAt - now();
        await message.reply(
          `🚫 You reached your daily drop limit of **${config.maxDropsPerDay}**. Resets in **${formatDuration(resetIn)}**.`
        );
        return;
      }
    }

    entry.dailyCount += 1;
    entry.totalDrops += 1;
    entry.lastDropAt = now();
    updateStreak(entry);

    const attachmentFiles = [...message.attachments.values()].map((a) => a.url);
    const caption = message.content?.trim() ? message.content.trim() : "No caption";

    const embed = new EmbedBuilder()
      .setTitle("📸 New Snap Drop")
      .setDescription(`**From:** ${message.author}\n**Caption:** ${caption}`)
      .addFields(
        { name: "🔥 Current Streak", value: `${entry.streak}`, inline: true },
        { name: "📦 Daily Drops", value: `${entry.dailyCount}/${isVip ? "∞" : config.maxDropsPerDay}`, inline: true },
        { name: "🏆 Total Drops", value: `${entry.totalDrops}`, inline: true }
      )
      .setTimestamp();

    if (message.attachments.first()?.contentType?.startsWith("image/")) {
      embed.setImage(message.attachments.first().url);
    }

    const sent = await message.channel.send({
      content: `📷 ${message.author.username} dropped a snap!`,
      embeds: [embed],
      files: attachmentFiles,
    });

    const deleteMs = config.autoDeleteHours * 60 * 60 * 1000;
    setTimeout(async () => {
      try {
        await sent.delete();
      } catch {}
    }, deleteMs);

    try {
      await message.delete();
    } catch {}

  } catch (err) {
    console.error("messageCreate error:", err);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "snapstats") {
      const targetUser = interaction.options.getUser("user") || interaction.user;
      const entry = getUserEntry(targetUser.id);

      const embed = new EmbedBuilder()
        .setTitle(`📊 Snap Stats - ${targetUser.username}`)
        .addFields(
          { name: "📦 Daily Drops", value: `${entry.dailyCount}`, inline: true },
          { name: "🏆 Total Drops", value: `${entry.totalDrops}`, inline: true },
          { name: "🔥 Current Streak", value: `${entry.streak}`, inline: true },
          { name: "👑 Best Streak", value: `${entry.bestStreak}`, inline: true },
          {
            name: "⏳ Cooldown",
            value:
              entry.lastDropAt > 0
                ? formatDuration(
                    Math.max(0, config.cooldownMinutes * 60 * 1000 - (now() - entry.lastDropAt))
                  )
                : "Ready now",
            inline: false,
          }
        )
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
      return;
    }

    if (interaction.commandName === "snapleaderboard") {
      const entries = [...userData.entries()]
        .sort((a, b) => b[1].totalDrops - a[1].totalDrops)
        .slice(0, 10);

      if (entries.length === 0) {
        await interaction.reply("No snap drops yet.");
        return;
      }

      const lines = await Promise.all(
        entries.map(async ([userId, data], index) => {
          let username = `User ${userId}`;
          try {
            const user = await client.users.fetch(userId);
            username = user.username;
          } catch {}
          return `**${index + 1}.** ${username} — ${data.totalDrops} drops | 🔥 ${data.streak} streak`;
        })
      );

      const embed = new EmbedBuilder()
        .setTitle("🏆 Snap Leaderboard")
        .setDescription(lines.join("\n"))
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
      return;
    }

    if (interaction.commandName === "setdrops") {
      const amount = interaction.options.getInteger("amount");
      if (amount < 1) {
        await interaction.reply({ content: "Amount must be at least 1.", ephemeral: true });
        return;
      }
      config.maxDropsPerDay = amount;
      await interaction.reply(`✅ Max drops per day set to **${amount}**`);
      return;
    }

    if (interaction.commandName === "setcooldown") {
      const minutes = interaction.options.getInteger("minutes");
      if (minutes < 0) {
        await interaction.reply({ content: "Cooldown cannot be negative.", ephemeral: true });
        return;
      }
      config.cooldownMinutes = minutes;
      await interaction.reply(`✅ Cooldown set to **${minutes} minute(s)**`);
      return;
    }

    if (interaction.commandName === "setautodelete") {
      const hours = interaction.options.getInteger("hours");
      if (hours < 1) {
        await interaction.reply({ content: "Hours must be at least 1.", ephemeral: true });
        return;
      }
      config.autoDeleteHours = hours;
      await interaction.reply(`✅ Auto-delete set to **${hours} hour(s)**`);
      return;
    }

    if (interaction.commandName === "setviprole") {
      const roleName = interaction.options.getString("role_name");
      config.vipRoleName = roleName;
      await interaction.reply(`✅ VIP bypass role set to **${roleName}**`);
      return;
    }

    if (interaction.commandName === "snapconfig") {
      const embed = new EmbedBuilder()
        .setTitle("⚙️ Snap Bot Config")
        .addFields(
          { name: "Snap Channel", value: config.snapChannelName, inline: true },
          { name: "Max Drops / Day", value: `${config.maxDropsPerDay}`, inline: true },
          { name: "Cooldown", value: `${config.cooldownMinutes} minute(s)`, inline: true },
          { name: "Auto Delete", value: `${config.autoDeleteHours} hour(s)`, inline: true },
          { name: "VIP Role", value: config.vipRoleName, inline: true },
          { name: "Caption Only Allowed", value: `${config.allowTextCaptionOnly}`, inline: true }
        )
        .setTimestamp();

      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }
  } catch (err) {
    console.error("interactionCreate error:", err);

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: "There was an error running that command.", ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: "There was an error running that command.", ephemeral: true }).catch(() => {});
    }
  }
});

client.login(TOKEN);
