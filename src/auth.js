const crypto = require("node:crypto");

const MANAGE_GUILD = 1n << 5n;
const ADMINISTRATOR = 1n << 3n;

function createSessionManager(secret) {
  const sessions = new Map();

  function sign(value) {
    return crypto.createHmac("sha256", secret).update(value).digest("hex");
  }

  function issueSession(data) {
    const sessionId = crypto.randomUUID();
    const signature = sign(sessionId);
    sessions.set(sessionId, {
      ...data,
      createdAt: Date.now(),
    });

    return `${sessionId}.${signature}`;
  }

  function readSession(cookieValue) {
    if (!cookieValue) {
      return null;
    }

    const [sessionId, signature] = cookieValue.split(".");
    if (!sessionId || !signature) {
      return null;
    }

    if (sign(sessionId) !== signature) {
      return null;
    }

    return sessions.get(sessionId) || null;
  }

  function destroySession(cookieValue) {
    if (!cookieValue) {
      return;
    }

    const [sessionId] = cookieValue.split(".");
    if (sessionId) {
      sessions.delete(sessionId);
    }
  }

  return {
    issueSession,
    readSession,
    destroySession,
  };
}

function parseCookies(cookieHeader = "") {
  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .map((chunk) => {
        const separator = chunk.indexOf("=");
        if (separator === -1) {
          return [chunk, ""];
        }

        return [chunk.slice(0, separator), decodeURIComponent(chunk.slice(separator + 1))];
      })
  );
}

function hasManageGuildPermission(permissions) {
  try {
    const bits = BigInt(permissions || "0");
    return (bits & ADMINISTRATOR) === ADMINISTRATOR || (bits & MANAGE_GUILD) === MANAGE_GUILD;
  } catch {
    return false;
  }
}

function buildAuthorizeUrl(config, state) {
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "identify guilds");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return url.toString();
}

async function exchangeCode(config, code) {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
  });

  const response = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`OAuth token exchange failed with status ${response.status}.`);
  }

  return response.json();
}

async function fetchDiscordUser(accessToken) {
  const [userResponse, guildsResponse] = await Promise.all([
    fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    }),
    fetch("https://discord.com/api/users/@me/guilds", {
      headers: { Authorization: `Bearer ${accessToken}` },
    }),
  ]);

  if (!userResponse.ok || !guildsResponse.ok) {
    throw new Error("Failed to fetch Discord user profile.");
  }

  const [user, guilds] = await Promise.all([userResponse.json(), guildsResponse.json()]);

  return {
    user,
    guilds: guilds.map((guild) => ({
      ...guild,
      canManage: hasManageGuildPermission(guild.permissions),
    })),
  };
}

module.exports = {
  buildAuthorizeUrl,
  createSessionManager,
  exchangeCode,
  fetchDiscordUser,
  parseCookies,
};
