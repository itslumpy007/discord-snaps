const { ChannelType, EmbedBuilder } = require("discord.js");

function buildBaseEmbed(title) {
  return new EmbedBuilder().setTitle(title).setColor(0xf97316).setTimestamp();
}

async function ensureDropThread(channel, message, name) {
  if (channel.isThread()) {
    return channel;
  }

  if (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement) {
    return message.startThread({
      name,
      autoArchiveDuration: 60,
    });
  }

  return channel;
}

function mentionRole(roleId) {
  return roleId ? `<@&${roleId}>` : "@here";
}

module.exports = {
  buildBaseEmbed,
  ensureDropThread,
  mentionRole,
};
