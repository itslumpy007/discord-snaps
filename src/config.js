const path = require("node:path");

const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const STATE_PATH = path.join(DATA_DIR, "state.json");

const DEFAULTS = {
  dropDurationMinutes: 15,
  schedulerIntervalMs: 30 * 1000,
  dailyWindowStartHourLocal: 18,
  dailyWindowEndHourLocal: 23,
  defaultTimeZone: "America/New_York",
  reminderMinutesBeforeEnd: [10, 5, 1],
  weeklyRecapWeekday: 1,
  weeklyRecapHourLocal: 9,
  rewardThreshold: 7,
};

function readRequiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function getRuntimeConfig() {
  const dashboardPort = Number.parseInt(process.env.DASHBOARD_PORT || "3000", 10);
  const dashboardHost = process.env.DASHBOARD_HOST || "127.0.0.1";
  const dashboardPublicUrl =
    process.env.DASHBOARD_PUBLIC_URL || `http://${dashboardHost}:${dashboardPort}`;
  const dashboardEnabled = Boolean(
    process.env.DISCORD_CLIENT_SECRET &&
      process.env.DASHBOARD_SESSION_SECRET &&
      process.env.DASHBOARD_REDIRECT_URI
  );

  return {
    token: readRequiredEnv("DISCORD_TOKEN"),
    clientId: readRequiredEnv("DISCORD_CLIENT_ID"),
    statePath: STATE_PATH,
    defaults: DEFAULTS,
    dashboard: {
      enabled: dashboardEnabled,
      host: dashboardHost,
      port: Number.isInteger(dashboardPort) ? dashboardPort : 3000,
      publicUrl: dashboardPublicUrl,
      redirectUri: process.env.DASHBOARD_REDIRECT_URI || `${dashboardPublicUrl}/auth/discord/callback`,
      clientSecret: process.env.DISCORD_CLIENT_SECRET || null,
      sessionSecret: process.env.DASHBOARD_SESSION_SECRET || null,
    },
  };
}

module.exports = {
  DATA_DIR,
  STATE_PATH,
  DEFAULTS,
  getRuntimeConfig,
};
