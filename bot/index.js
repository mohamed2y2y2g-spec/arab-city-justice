import "dotenv/config";
import { Client, GatewayIntentBits, Events } from "discord.js";

const required = ["DISCORD_BOT_TOKEN", "WORKER_INGEST_URL", "BOT_INGEST_SECRET"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const TEST_GUILD_ID = "1569044247208923291";
const MINISTRY_MEMBER_ROLE_ID = "1569053569544618024";
const MINISTRY_SOURCE_ROLE_IDS = new Set(["1569053629401534474", "1569053685441499196"]);
const ALLOWED_CHANNELS = new Set([
  "1569054230138978415",
  "1569054925122699417"
]);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ]
});

client.once(Events.ClientReady, ready => {
  console.log(`Connected as ${ready.user.tag}; isolated test guild only.`);
});

async function syncMinistryMemberRole(member) {
  if (!member || member.guild?.id !== TEST_GUILD_ID || member.user?.bot) return;
  const isMinistryStaff = [...MINISTRY_SOURCE_ROLE_IDS].some(roleId => member.roles.cache.has(roleId));
  const alreadyHasMemberRole = member.roles.cache.has(MINISTRY_MEMBER_ROLE_ID);
  try {
    if (isMinistryStaff && !alreadyHasMemberRole) {
      await member.roles.add(MINISTRY_MEMBER_ROLE_ID, "Ministry staff role sync (test server only)");
    } else if (!isMinistryStaff && alreadyHasMemberRole) {
      await member.roles.remove(MINISTRY_MEMBER_ROLE_ID, "Ministry staff role sync (test server only)");
    }
  } catch (error) {
    console.error("Ministry role sync failed:", error.message);
  }
}

client.on(Events.GuildMemberAdd, syncMinistryMemberRole);
client.on(Events.GuildMemberUpdate, async (_oldMember, newMember) => syncMinistryMemberRole(newMember));

client.on(Events.MessageCreate, async message => {
  if (!message.guild || message.guild.id !== TEST_GUILD_ID) return;
  if (!ALLOWED_CHANNELS.has(message.channelId)) return;
  if (message.author.bot || !message.content?.trim()) return;

  const payload = {
    guild_id: message.guild.id,
    channel_id: message.channelId,
    discord_message_id: message.id,
    author_id: message.author.id,
    author_name: message.member?.displayName || message.author.username,
    body: message.content.slice(0, 2000),
    created_at: message.createdAt.toISOString()
  };

  try {
    const response = await fetch(process.env.WORKER_INGEST_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bot-ingest-secret": process.env.BOT_INGEST_SECRET
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      console.error("Message bridge rejected:", response.status, (await response.text()).slice(0, 300));
    }
  } catch (error) {
    console.error("Message bridge failed:", error.message);
  }
});

client.on(Events.Error, error => console.error("Discord client error:", error));
process.on("unhandledRejection", error => console.error("Unhandled rejection:", error));
process.on("SIGTERM", () => {
  console.log("SIGTERM received; closing Discord connection.");
  client.destroy();
  process.exit(0);
});

client.login(process.env.DISCORD_BOT_TOKEN);
