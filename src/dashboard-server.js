const crypto = require("node:crypto");
const http = require("node:http");

const {
  buildAuthorizeUrl,
  createSessionManager,
  exchangeCode,
  fetchDiscordUser,
  parseCookies,
} = require("./auth");

function createDashboardServer(config, service) {
  const sessionManager = createSessionManager(config.sessionSecret);
  const pendingStates = new Map();

  function issueState() {
    const state = crypto.randomUUID();
    pendingStates.set(state, Date.now());
    return state;
  }

  function consumeState(state) {
    if (!pendingStates.has(state)) {
      return false;
    }

    pendingStates.delete(state);
    return true;
  }

  function sendJson(response, statusCode, payload) {
    response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(payload));
  }

  function sendHtml(response, statusCode, body) {
    response.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
    response.end(body);
  }

  function sendJavascript(response, statusCode, body) {
    response.writeHead(statusCode, { "Content-Type": "application/javascript; charset=utf-8" });
    response.end(body);
  }

  function redirect(response, location, cookies = []) {
    const headers = { Location: location };
    if (cookies.length > 0) {
      headers["Set-Cookie"] = cookies;
    }

    response.writeHead(302, headers);
    response.end();
  }

  async function readJsonBody(request) {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    if (chunks.length === 0) {
      return {};
    }

    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  function getSession(request) {
    const cookies = parseCookies(request.headers.cookie);
    return {
      cookieValue: cookies.snapdash || null,
      session: sessionManager.readSession(cookies.snapdash),
    };
  }

  function requireSession(request, response) {
    const { session } = getSession(request);

    if (!session) {
      sendJson(response, 401, { error: "Not authenticated." });
      return null;
    }

    return session;
  }

  function requireGuildAccess(session, guildId, response) {
    const guild = session.guilds.find((entry) => entry.id === guildId && entry.canManage);
    if (!guild) {
      sendJson(response, 403, { error: "You do not have access to that server." });
      return null;
    }

    return guild;
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, config.publicUrl);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "GET" && url.pathname === "/") {
        redirect(response, "/dashboard");
        return;
      }

      if (request.method === "GET" && url.pathname === "/dashboard") {
        sendHtml(response, 200, renderDashboardHtml());
        return;
      }

      if (request.method === "GET" && url.pathname === "/dashboard.js") {
        sendJavascript(response, 200, renderDashboardJavascript());
        return;
      }

      if (request.method === "GET" && url.pathname === "/auth/discord/login") {
        const state = issueState();
        redirect(response, buildAuthorizeUrl(config, state));
        return;
      }

      if (request.method === "GET" && url.pathname === "/auth/discord/callback") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");

        if (!code || !state || !consumeState(state)) {
          sendHtml(response, 400, "<h1>Invalid OAuth state.</h1>");
          return;
        }

        const tokenData = await exchangeCode(config, code);
        const discordIdentity = await fetchDiscordUser(tokenData.access_token);
        const sessionValue = sessionManager.issueSession({
          accessToken: tokenData.access_token,
          user: discordIdentity.user,
          guilds: discordIdentity.guilds,
        });

        redirect(response, "/dashboard", [
          `snapdash=${encodeURIComponent(sessionValue)}; HttpOnly; Path=/; SameSite=Lax`,
        ]);
        return;
      }

      if (request.method === "POST" && url.pathname === "/auth/logout") {
        const { cookieValue } = getSession(request);
        sessionManager.destroySession(cookieValue);
        redirect(response, "/dashboard", [
          "snapdash=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax",
        ]);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/me") {
        const session = requireSession(request, response);
        if (!session) {
          return;
        }

        sendJson(response, 200, {
          user: session.user,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/guilds") {
        const session = requireSession(request, response);
        if (!session) {
          return;
        }

        sendJson(response, 200, {
          guilds: service.getManageableGuilds(session.guilds),
        });
        return;
      }

      const guildMatch = url.pathname.match(/^\/api\/guilds\/([^/]+)(?:\/([^/]+))?$/);
      if (guildMatch) {
        const [, guildId, action] = guildMatch;
        const session = requireSession(request, response);
        if (!session) {
          return;
        }

        const guildAccess = requireGuildAccess(session, guildId, response);
        if (!guildAccess) {
          return;
        }

        if (request.method === "GET" && !action) {
          const overview = await service.getGuildOverview(guildId);
          sendJson(response, 200, overview);
          return;
        }

        if (request.method === "GET" && action === "export") {
          const payload = service.exportGuildData(guildId);
          response.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": `attachment; filename="snap-export-${guildId}.json"`,
          });
          response.end(JSON.stringify(payload, null, 2));
          return;
        }

        if (request.method === "PATCH" && action === "config") {
          const body = await readJsonBody(request);
          const configState = await service.updateGuildConfig(guildId, body);
          sendJson(response, 200, { config: configState });
          return;
        }

        if (request.method === "POST" && action === "actions") {
          const body = await readJsonBody(request);
          const result = await service.runAction(guildId, body.action, {
            ...body,
            userId: session.user.id,
          });
          sendJson(response, 200, { result });
          return;
        }
      }

      sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      console.error("Dashboard server error:", error);
      sendJson(response, 500, { error: error.message || "Unexpected server error." });
    }
  });

  return {
    start() {
      return new Promise((resolve) => {
        server.listen(config.port, config.host, () => {
          console.log(`Dashboard listening at ${config.publicUrl}`);
          resolve();
        });
      });
    },
  };
}

function renderDashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Discord Snaps Admin</title>
  <style>
    :root {
      --bg: #f6efe3;
      --panel: #fffaf2;
      --ink: #1e1b16;
      --muted: #6f6256;
      --accent: #db6b2b;
      --accent-strong: #b75118;
      --line: #e6d7c2;
      --ok: #2f7d4f;
      --bad: #ad3a22;
      --shadow: 0 18px 40px rgba(49, 32, 12, 0.12);
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", "Aptos", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(219, 107, 43, 0.18), transparent 28%),
        linear-gradient(135deg, #f7efe1 0%, #f2e6d4 50%, #f8f2e8 100%);
      min-height: 100vh;
    }

    .shell {
      display: grid;
      grid-template-columns: 320px minmax(0, 1fr);
      min-height: 100vh;
    }

    .sidebar {
      border-right: 1px solid var(--line);
      background: rgba(255, 250, 242, 0.88);
      backdrop-filter: blur(16px);
      padding: 24px;
    }

    .brand {
      margin-bottom: 24px;
    }

    .brand h1 {
      margin: 0;
      font-size: 1.7rem;
      letter-spacing: 0.04em;
    }

    .brand p {
      margin: 8px 0 0;
      color: var(--muted);
    }

    .guild-list, .stack {
      display: grid;
      gap: 10px;
    }

    .guild-button, button, .action-button {
      border: 0;
      border-radius: 16px;
      background: #fff;
      color: var(--ink);
      padding: 12px 14px;
      box-shadow: var(--shadow);
      cursor: pointer;
      text-align: left;
      font-weight: 600;
    }

    .guild-button.active {
      background: linear-gradient(135deg, var(--accent), #ef9c3b);
      color: white;
    }

    button.primary, .action-button.primary {
      background: linear-gradient(135deg, var(--accent), #ef9c3b);
      color: white;
    }

    button.ghost {
      background: transparent;
      border: 1px solid var(--line);
      box-shadow: none;
    }

    .main {
      padding: 28px;
      display: grid;
      gap: 18px;
    }

    .hero, .panel {
      background: rgba(255, 250, 242, 0.92);
      border: 1px solid var(--line);
      border-radius: 26px;
      padding: 22px;
      box-shadow: var(--shadow);
    }

    .hero h2, .panel h3 {
      margin-top: 0;
    }

    .hero-grid, .panel-grid, .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
    }

    .stat {
      border: 1px solid var(--line);
      border-radius: 20px;
      padding: 14px;
      background: rgba(255,255,255,0.66);
    }

    .stat .label {
      color: var(--muted);
      font-size: 0.85rem;
    }

    .stat .value {
      font-size: 1.35rem;
      font-weight: 700;
      margin-top: 6px;
    }

    .panel-grid.two {
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    }

    .form-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
    }

    label {
      display: grid;
      gap: 6px;
      font-size: 0.92rem;
      font-weight: 600;
    }

    input, select {
      border-radius: 12px;
      border: 1px solid var(--line);
      padding: 10px 12px;
      font: inherit;
      background: #fffdf9;
    }

    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }

    .list {
      display: grid;
      gap: 8px;
    }

    .list-item {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      border-bottom: 1px solid var(--line);
      padding-bottom: 8px;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-radius: 999px;
      font-size: 0.84rem;
      background: #fff;
      border: 1px solid var(--line);
    }

    .badge.ok { color: var(--ok); }
    .badge.bad { color: var(--bad); }

    .topbar {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: center;
    }

    .empty {
      color: var(--muted);
      padding: 18px;
      border: 1px dashed var(--line);
      border-radius: 18px;
    }

    .hidden { display: none !important; }

    @media (max-width: 960px) {
      .shell {
        grid-template-columns: 1fr;
      }

      .sidebar {
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <h1>Discord Snaps</h1>
        <p>Admin dashboard for scheduling, controls, and analytics.</p>
      </div>
      <div class="stack">
        <div id="auth-card" class="panel">
          <h3>Login</h3>
          <p>Sign in with Discord to manage servers where you have permission.</p>
          <button id="login-button" class="primary">Login With Discord</button>
        </div>
        <div id="user-card" class="panel hidden">
          <div id="user-name"></div>
          <div id="user-meta" class="badge"></div>
          <div style="margin-top: 12px;">
            <button id="logout-button" class="ghost">Log Out</button>
          </div>
        </div>
        <div id="guilds-card" class="panel hidden">
          <h3>Servers</h3>
          <div id="guild-list" class="guild-list"></div>
        </div>
      </div>
    </aside>
    <main class="main">
      <section class="hero">
        <div class="topbar">
          <div>
            <h2 id="hero-title">Admin Dashboard</h2>
            <p id="hero-subtitle">Log in to load your manageable Discord servers.</p>
          </div>
          <div class="toolbar">
            <button id="refresh-button" class="ghost hidden">Refresh</button>
            <button id="download-button" class="ghost hidden">Download Export</button>
          </div>
        </div>
        <div id="hero-stats" class="hero-grid"></div>
      </section>

      <section id="welcome-panel" class="panel">
        <h3>What You Can Do Here</h3>
        <div class="panel-grid two">
          <div>
            <p>Manage scheduling, timezones, reminders, reward roles, and weekly recaps without memorizing slash commands.</p>
          </div>
          <div>
            <p>Control active drops in real time, review leaderboard health, and export data for your server.</p>
          </div>
        </div>
      </section>

      <section id="dashboard-content" class="hidden">
        <div class="panel-grid two">
          <section class="panel">
            <h3>Overview</h3>
            <div id="health-list" class="list"></div>
          </section>
          <section class="panel">
            <h3>Live Controls</h3>
            <div class="toolbar">
              <button data-action="manual-drop" class="action-button primary">Start Drop</button>
              <button data-action="close-drop" class="action-button">Close Drop</button>
              <button data-action="reopen-drop" class="action-button">Reopen Drop</button>
              <button data-action="reroll-drop" class="action-button">Reroll Next</button>
              <button data-action="post-recap" class="action-button">Post Recap</button>
              <button data-action="reset-guild" class="action-button">Reset Server</button>
            </div>
            <div style="margin-top: 14px;">
              <label>
                Extend active drop (minutes)
                <div class="toolbar">
                  <input id="extend-minutes" type="number" min="1" max="60" value="5" />
                  <button id="extend-button" class="action-button">Extend</button>
                </div>
              </label>
            </div>
          </section>
        </div>

        <section class="panel">
          <h3>Configuration</h3>
          <form id="config-form" class="form-grid">
            <label>Snap Channel
              <select name="snapsChannelId" id="channel-select"></select>
            </label>
            <label>Snap Role
              <select name="snapsRoleId" id="role-select"></select>
            </label>
            <label>Timezone
              <input name="timeZone" id="timezone-input" placeholder="America/New_York" />
            </label>
            <label>Start Hour
              <input name="dailyWindowStartHourLocal" id="start-hour-input" type="number" min="0" max="23" />
            </label>
            <label>End Hour
              <input name="dailyWindowEndHourLocal" id="end-hour-input" type="number" min="0" max="23" />
            </label>
            <label>Drop Duration
              <input name="dropDurationMinutes" id="duration-input" type="number" min="1" max="180" />
            </label>
            <label>Reminders
              <input name="reminderMinutesBeforeEnd" id="reminders-input" placeholder="10,5,1" />
            </label>
            <label>Reward Role
              <select name="rewardRoleId" id="reward-role-select"></select>
            </label>
            <label>Reward Threshold
              <input name="rewardThreshold" id="reward-threshold-input" type="number" min="1" max="365" />
            </label>
            <label>Automation Enabled
              <select name="enabled" id="enabled-select">
                <option value="true">Enabled</option>
                <option value="false">Disabled</option>
              </select>
            </label>
            <label>Weekly Recap Enabled
              <select name="weeklyRecapEnabled" id="recap-enabled-select">
                <option value="true">Enabled</option>
                <option value="false">Disabled</option>
              </select>
            </label>
          </form>
          <div style="margin-top: 14px;">
            <button id="save-config-button" class="primary">Save Configuration</button>
          </div>
        </section>

        <div class="panel-grid two">
          <section class="panel">
            <h3>Leaderboard</h3>
            <div id="leaderboard-list" class="list"></div>
          </section>
          <section class="panel">
            <h3>Tracked Members</h3>
            <div id="members-list" class="list"></div>
          </section>
        </div>
      </section>
    </main>
  </div>
  <script src="/dashboard.js"></script>
</body>
</html>`;
}

function renderDashboardJavascript() {
  return `
const state = {
  user: null,
  guilds: [],
  selectedGuildId: null,
  overview: null,
};

const el = {
  authCard: document.getElementById("auth-card"),
  userCard: document.getElementById("user-card"),
  userName: document.getElementById("user-name"),
  userMeta: document.getElementById("user-meta"),
  guildsCard: document.getElementById("guilds-card"),
  guildList: document.getElementById("guild-list"),
  heroTitle: document.getElementById("hero-title"),
  heroSubtitle: document.getElementById("hero-subtitle"),
  heroStats: document.getElementById("hero-stats"),
  welcomePanel: document.getElementById("welcome-panel"),
  dashboardContent: document.getElementById("dashboard-content"),
  healthList: document.getElementById("health-list"),
  leaderboardList: document.getElementById("leaderboard-list"),
  membersList: document.getElementById("members-list"),
  channelSelect: document.getElementById("channel-select"),
  roleSelect: document.getElementById("role-select"),
  rewardRoleSelect: document.getElementById("reward-role-select"),
  timezoneInput: document.getElementById("timezone-input"),
  startHourInput: document.getElementById("start-hour-input"),
  endHourInput: document.getElementById("end-hour-input"),
  durationInput: document.getElementById("duration-input"),
  remindersInput: document.getElementById("reminders-input"),
  rewardThresholdInput: document.getElementById("reward-threshold-input"),
  enabledSelect: document.getElementById("enabled-select"),
  recapEnabledSelect: document.getElementById("recap-enabled-select"),
  refreshButton: document.getElementById("refresh-button"),
  downloadButton: document.getElementById("download-button"),
  extendMinutes: document.getElementById("extend-minutes"),
};

document.getElementById("login-button").addEventListener("click", () => {
  window.location.href = "/auth/discord/login";
});

document.getElementById("logout-button").addEventListener("click", async () => {
  await fetch("/auth/logout", { method: "POST" });
  window.location.reload();
});

document.getElementById("save-config-button").addEventListener("click", saveConfig);
document.getElementById("extend-button").addEventListener("click", async () => {
  await runAction("extend-drop", { minutes: el.extendMinutes.value });
});
el.refreshButton.addEventListener("click", () => loadOverview(state.selectedGuildId));
el.downloadButton.addEventListener("click", () => {
  if (state.selectedGuildId) {
    window.location.href = "/api/guilds/" + state.selectedGuildId + "/export";
  }
});

for (const button of document.querySelectorAll("[data-action]")) {
  button.addEventListener("click", async () => {
    await runAction(button.dataset.action, {});
  });
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  if (response.status === 401) {
    state.user = null;
    renderAuthState();
    throw new Error("Please log in.");
  }

  if (!response.ok) {
    let payload = {};
    try {
      payload = await response.json();
    } catch {}
    throw new Error(payload.error || "Request failed.");
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  return response.text();
}

function notice(message) {
  window.alert(message);
}

function renderAuthState() {
  const loggedIn = Boolean(state.user);
  el.authCard.classList.toggle("hidden", loggedIn);
  el.userCard.classList.toggle("hidden", !loggedIn);
  el.guildsCard.classList.toggle("hidden", !loggedIn);
  el.refreshButton.classList.toggle("hidden", !loggedIn);
  el.downloadButton.classList.toggle("hidden", !loggedIn || !state.selectedGuildId);

  if (!loggedIn) {
    el.heroTitle.textContent = "Admin Dashboard";
    el.heroSubtitle.textContent = "Log in to load your manageable Discord servers.";
    el.heroStats.innerHTML = "";
    el.welcomePanel.classList.remove("hidden");
    el.dashboardContent.classList.add("hidden");
    return;
  }

  el.userName.textContent = state.user.username + "#" + state.user.discriminator;
  el.userMeta.textContent = "Discord admin session";
}

function renderGuilds() {
  el.guildList.innerHTML = "";

  if (state.guilds.length === 0) {
    el.guildList.innerHTML = '<div class="empty">No manageable servers were found where the bot is present.</div>';
    return;
  }

  for (const guild of state.guilds) {
    const button = document.createElement("button");
    button.className = "guild-button" + (guild.id === state.selectedGuildId ? " active" : "");
    button.textContent = guild.name;
    button.addEventListener("click", () => {
      state.selectedGuildId = guild.id;
      renderGuilds();
      loadOverview(guild.id);
    });
    el.guildList.appendChild(button);
  }
}

function renderOverview() {
  const data = state.overview;
  if (!data) {
    return;
  }

  el.welcomePanel.classList.add("hidden");
  el.dashboardContent.classList.remove("hidden");
  el.downloadButton.classList.remove("hidden");

  el.heroTitle.textContent = data.guild.name;
  el.heroSubtitle.textContent =
    "Next drop: " + (data.config.nextScheduledDropTs ? new Date(data.config.nextScheduledDropTs * 1000).toLocaleString() : "not scheduled");

  const heroStats = [
    ["Tracked Members", data.stats.totalMembersTracked],
    ["On-Time", data.stats.totalOnTime],
    ["Late", data.stats.totalLate],
    ["Missed", data.stats.totalMissed],
    ["Active Drop", data.currentDrop ? "Live" : "Idle"],
    ["Timezone", data.config.timeZone],
  ];
  el.heroStats.innerHTML = heroStats.map(([label, value]) => \`
    <div class="stat">
      <div class="label">\${label}</div>
      <div class="value">\${value}</div>
    </div>
  \`).join("");

  el.healthList.innerHTML = data.health.map((check) => \`
    <div class="list-item">
      <strong>\${check.label}</strong>
      <span class="badge \${check.ok ? "ok" : "bad"}">\${check.ok ? "Healthy" : "Needs attention"}</span>
    </div>
  \`).join("");

  el.leaderboardList.innerHTML = data.leaderboard.length
    ? data.leaderboard.map((member, index) => \`
        <div class="list-item">
          <span><strong>#\${index + 1}</strong> \${member.displayName}</span>
          <span>best \${member.bestStreak || 0} / on-time \${member.totalOnTime || 0}</span>
        </div>
      \`).join("")
    : '<div class="empty">No leaderboard data yet.</div>';

  el.membersList.innerHTML = data.recentMembers.length
    ? data.recentMembers.map((member) => \`
        <div class="list-item">
          <span>\${member.displayName}</span>
          <span>streak \${member.streak} / late \${member.totalLate || 0} / missed \${member.totalMissed || 0}</span>
        </div>
      \`).join("")
    : '<div class="empty">No member stats yet.</div>';

  renderSelect(el.channelSelect, data.channels, data.config.snapsChannelId, "Select a channel");
  renderSelect(el.roleSelect, data.roles, data.config.snapsRoleId, "Select a role");
  renderSelect(el.rewardRoleSelect, data.roles, data.config.rewardRoleId, "No reward role");
  el.timezoneInput.value = data.config.timeZone || "";
  el.startHourInput.value = data.config.dailyWindowStartHourLocal ?? "";
  el.endHourInput.value = data.config.dailyWindowEndHourLocal ?? "";
  el.durationInput.value = data.config.dropDurationMinutes ?? "";
  el.remindersInput.value = (data.config.reminderMinutesBeforeEnd || []).join(",");
  el.rewardThresholdInput.value = data.config.rewardThreshold ?? "";
  el.enabledSelect.value = String(Boolean(data.config.enabled));
  el.recapEnabledSelect.value = String(Boolean(data.config.weeklyRecapEnabled));
}

function renderSelect(select, options, selected, emptyLabel) {
  select.innerHTML = "";
  const emptyOption = document.createElement("option");
  emptyOption.value = "";
  emptyOption.textContent = emptyLabel;
  select.appendChild(emptyOption);

  for (const option of options) {
    const item = document.createElement("option");
    item.value = option.id;
    item.textContent = option.name;
    if (option.id === selected) {
      item.selected = true;
    }
    select.appendChild(item);
  }
}

async function loadSession() {
  try {
    const me = await api("/api/me");
    state.user = me.user;
    const guildsPayload = await api("/api/guilds");
    state.guilds = guildsPayload.guilds;
    state.selectedGuildId = state.guilds[0]?.id || null;
    renderAuthState();
    renderGuilds();
    if (state.selectedGuildId) {
      await loadOverview(state.selectedGuildId);
    }
  } catch (error) {
    renderAuthState();
    console.warn(error.message);
  }
}

async function loadOverview(guildId) {
  if (!guildId) {
    return;
  }

  const overview = await api("/api/guilds/" + guildId);
  state.overview = overview;
  renderOverview();
}

async function saveConfig() {
  if (!state.selectedGuildId) {
    return;
  }

  const payload = {
    snapsChannelId: el.channelSelect.value || null,
    snapsRoleId: el.roleSelect.value || null,
    rewardRoleId: el.rewardRoleSelect.value || null,
    timeZone: el.timezoneInput.value.trim(),
    dailyWindowStartHourLocal: el.startHourInput.value,
    dailyWindowEndHourLocal: el.endHourInput.value,
    dropDurationMinutes: el.durationInput.value,
    reminderMinutesBeforeEnd: el.remindersInput.value,
    rewardThreshold: el.rewardThresholdInput.value,
    enabled: el.enabledSelect.value === "true",
    weeklyRecapEnabled: el.recapEnabledSelect.value === "true",
  };

  await api("/api/guilds/" + state.selectedGuildId + "/config", {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  notice("Configuration saved.");
  await loadOverview(state.selectedGuildId);
}

async function runAction(action, extra) {
  if (!state.selectedGuildId) {
    return;
  }

  const payload = { action, ...extra };
  if (action === "reset-guild") {
    const confirm = window.prompt('Type RESET to wipe this server\\'s snap bot data.');
    if (confirm !== "RESET") {
      notice("Reset cancelled.");
      return;
    }

    payload.confirm = confirm;
  }

  const result = await api("/api/guilds/" + state.selectedGuildId + "/actions", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (action === "post-recap") {
    notice(result.result?.sent ? "Weekly recap posted." : "Weekly recap was not posted.");
  } else if (action === "reset-guild") {
    notice("Server snap state reset.");
    state.overview = null;
  } else {
    notice("Action completed.");
  }

  await loadOverview(state.selectedGuildId);
}

loadSession();
`;
}

module.exports = {
  createDashboardServer,
};
