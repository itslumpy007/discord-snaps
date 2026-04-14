require("dotenv").config();

const { Client, GatewayIntentBits, Partials, REST, Routes } = require("discord.js");
const { getRuntimeConfig } = require("./config");
const { StateStore } = require("./state");
const { buildCommands, handleCommand, handleComponent, handleModal } = require("./commands");
const { createDashboardServer } = require("./dashboard-server");
const { DashboardService } = require("./dashboard-service");
const { SnapManager } = require("./snap-manager");

async function registerCommands(token, clientId, guildIds) {
  const commands = buildCommands();
  const rest = new REST({ version: "10" }).setToken(token);

  // Clear any old global commands so stale legacy slash commands stop showing up.
  await rest.put(Routes.applicationCommands(clientId), {
    body: [],
  });

  await Promise.all(
    guildIds.map((guildId) =>
      rest.put(Routes.applicationGuildCommands(clientId, guildId), {
        body: commands,
      })
    )
  );
}

async function main() {
  const runtimeConfig = getRuntimeConfig();
  const store = new StateStore(runtimeConfig.statePath, runtimeConfig.defaults);
  store.load();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  const manager = new SnapManager(client, store);
  const dashboardService = new DashboardService(client, store, manager);
  const helpers = {
    refreshGuildCommands: async (guildId) =>
      registerCommands(runtimeConfig.token, runtimeConfig.clientId, [guildId]),
  };

  client.once("ready", async () => {
    console.log(`Snap 2.0 online as ${client.user.tag}`);
    const guildIds = [...client.guilds.cache.keys()];

    for (const guildId of guildIds) {
      store.getGuild(guildId);
    }

    if (guildIds.length > 0) {
      await registerCommands(runtimeConfig.token, runtimeConfig.clientId, guildIds);
      console.log(`Registered slash commands for ${guildIds.length} guild(s).`);
    } else {
      console.log("No guilds in state yet. Commands will register after setup.");
    }

    manager.scheduleExistingDrops();
    for (const guildId of guildIds) {
      manager.ensureScheduledDrop(guildId);
    }

    setInterval(() => {
      manager.tickScheduler().catch((error) => {
        console.error("Scheduler tick failed:", error);
      });
    }, runtimeConfig.defaults.schedulerIntervalMs);

    if (runtimeConfig.dashboard.enabled) {
      const server = createDashboardServer(
        {
          clientId: runtimeConfig.clientId,
          clientSecret: runtimeConfig.dashboard.clientSecret,
          sessionSecret: runtimeConfig.dashboard.sessionSecret,
          redirectUri: runtimeConfig.dashboard.redirectUri,
          publicUrl: runtimeConfig.dashboard.publicUrl,
          port: runtimeConfig.dashboard.port,
          host: runtimeConfig.dashboard.host,
        },
        dashboardService
      );
      await server.start();
    } else {
      console.log(
        "Dashboard disabled. Set DISCORD_CLIENT_SECRET, DASHBOARD_SESSION_SECRET, and DASHBOARD_REDIRECT_URI to enable it."
      );
    }
  });

  client.on("guildCreate", async (guild) => {
    try {
      store.getGuild(guild.id);
      await registerCommands(runtimeConfig.token, runtimeConfig.clientId, [guild.id]);
      manager.ensureScheduledDrop(guild.id);
    } catch (error) {
      console.error(`Failed to initialize guild ${guild.id}:`, error);
    }
  });

  client.on("messageCreate", async (message) => {
    try {
      await manager.recordSubmission(message);
    } catch (error) {
      console.error("Submission handling failed:", error);
    }
  });

  client.on("interactionCreate", async (interaction) => {
    try {
      const handled = interaction.isButton()
        ? await handleComponent(interaction, manager, store, helpers)
        : interaction.isModalSubmit()
          ? await handleModal(interaction, manager, store, helpers)
        : await handleCommand(interaction, manager, store, helpers);
      if (!handled) {
        return;
      }

      if (interaction.commandName === "snapsetup") {
        await registerCommands(runtimeConfig.token, runtimeConfig.clientId, [interaction.guildId]);
      }
    } catch (error) {
      console.error("Interaction handler failed:", error);

      if (interaction.replied || interaction.deferred) {
        await interaction
          .followUp({
            content: "Something went wrong while running that command.",
            ephemeral: true,
          })
          .catch(() => {});
      } else if (interaction.isRepliable()) {
        await interaction
          .reply({
            content: "Something went wrong while running that command.",
            ephemeral: true,
          })
          .catch(() => {});
      }
    }
  });

  await client.login(runtimeConfig.token);
}

main().catch((error) => {
  console.error("Snap 2.0 failed to boot:", error);
  process.exit(1);
});
