require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  Routes,
  REST,
  EmbedBuilder,
  PermissionFlagsBits,
} = require("discord.js");
const Database = require("better-sqlite3");

// =====================
// CONFIG
// =====================

// --- Text XP ---
const TEXT_XP_MIN = 15;
const TEXT_XP_MAX = 25;
const TEXT_XP_COOLDOWN_SECONDS = 60;

// --- Anti-Farm (Text) ---
const MIN_MESSAGE_LENGTH_FOR_XP = 6;
const DUPLICATE_WINDOW_SECONDS = 120;
const RAPID_MESSAGE_WINDOW_SECONDS = 8;
const BLOCK_IF_ONLY_EMOJIS = true;

// --- Voice XP ---
const VOICE_XP_PER_MINUTE = 5;
const VOICE_AWARD_INTERVAL_SECONDS = 60;
const VOICE_MIN_MEMBERS = 2;
const VOICE_REQUIRE_UNMUTED = true;

// --- Prestige ---
const PRESTIGE_MIN_LEVEL = 100;
const PRESTIGE_XP_BONUS_PER_LEVEL = 0.05; // +5% XP je Prestige
const PRESTIGE_ROLES = []; // optional später

// --- Channels ohne Text-XP (IDs eintragen, optional) ---
const NO_TEXT_XP_CHANNELS = new Set([]);

// --- Voice channels ohne Voice-XP (IDs eintragen, optional) ---
const NO_VOICE_XP_CHANNELS = new Set([]);

// --- Level Up Message Channel (optional) ---
const LEVELUP_CHANNEL_ID = process.env.LEVELUP_CHANNEL_ID || null;

// --- Role Rewards (erstmal leer, damit es ohne IDs läuft) ---
const ROLE_REWARDS = []; // später füllst du das
const STACK_ROLE_REWARDS = true;

// =====================
// LEVELING MATH
// =====================
function xpForNextLevel(level) {
  return 5 * level * level + 50 * level + 100;
}
function totalXpForLevel(level) {
  let total = 0;
  for (let l = 0; l < level; l++) total += xpForNextLevel(l);
  return total;
}
function levelFromTotalXp(totalXp) {
  let level = 0;
  while (totalXp >= totalXpForLevel(level + 1)) level++;
  return level;
}
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function nowSec() {
  return Math.floor(Date.now() / 1000);
}
function normalizeContent(content) {
  return (content || "").toLowerCase().replace(/\s+/g, " ").trim();
}
function isOnlyEmojis(str) {
  const s = (str || "")
    .replace(/<a?:\w+:\d+>/g, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, "")
    .trim();
  return s.length === 0;
}

// =====================
// DB
// =====================
const db = new Database("levels.sqlite");
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  guild_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  xp       INTEGER NOT NULL DEFAULT 0,
  level    INTEGER NOT NULL DEFAULT 0,
  prestige INTEGER NOT NULL DEFAULT 0,
  last_text_xp_at  INTEGER NOT NULL DEFAULT 0,
  last_voice_xp_at INTEGER NOT NULL DEFAULT 0,
  last_msg_norm TEXT NOT NULL DEFAULT '',
  last_msg_at   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS voice_sessions (
  guild_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
`);

function tryAlter(sql) {
  try { db.exec(sql); } catch (_) {}
}
tryAlter(`ALTER TABLE users ADD COLUMN prestige INTEGER NOT NULL DEFAULT 0;`);
tryAlter(`ALTER TABLE users ADD COLUMN last_msg_norm TEXT NOT NULL DEFAULT '';`);
tryAlter(`ALTER TABLE users ADD COLUMN last_msg_at INTEGER NOT NULL DEFAULT 0;`);

const stmtGetUser = db.prepare(
  `SELECT guild_id, user_id, xp, level, prestige,
          last_text_xp_at, last_voice_xp_at, last_msg_norm, last_msg_at
   FROM users WHERE guild_id = ? AND user_id = ?`
);

const stmtUpsertUser = db.prepare(
  `INSERT INTO users (guild_id, user_id, xp, level, prestige,
                      last_text_xp_at, last_voice_xp_at, last_msg_norm, last_msg_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(guild_id, user_id) DO UPDATE SET
     xp=excluded.xp,
     level=excluded.level,
     prestige=excluded.prestige,
     last_text_xp_at=excluded.last_text_xp_at,
     last_voice_xp_at=excluded.last_voice_xp_at,
     last_msg_norm=excluded.last_msg_norm,
     last_msg_at=excluded.last_msg_at`
);

const stmtTop = db.prepare(
  `SELECT user_id, xp, level, prestige FROM users
   WHERE guild_id = ?
   ORDER BY xp DESC
   LIMIT ?`
);

const stmtUpsertVoiceSession = db.prepare(
  `INSERT INTO voice_sessions (guild_id, user_id, channel_id, joined_at)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(guild_id, user_id) DO UPDATE SET
     channel_id=excluded.channel_id,
     joined_at=excluded.joined_at`
);

const stmtDeleteVoiceSession = db.prepare(
  `DELETE FROM voice_sessions WHERE guild_id = ? AND user_id = ?`
);

// =====================
// DISCORD CLIENT
// =====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel],
});

// =====================
// SLASH COMMANDS
// =====================
const commands = [
  new SlashCommandBuilder()
    .setName("rank")
    .setDescription("Zeigt Level/XP/Prestige.")
    .addUserOption((opt) =>
      opt.setName("user").setDescription("Optional: anderer User").setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Top-10 nach XP."),
  new SlashCommandBuilder()
    .setName("prestige")
    .setDescription(`Prestige ausführen (ab Level ${PRESTIGE_MIN_LEVEL}).`),

  new SlashCommandBuilder()
    .setName("setxp")
    .setDescription("ADMIN: Setzt die XP eines Users.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((opt) => opt.setName("user").setDescription("User").setRequired(true))
    .addIntegerOption((opt) => opt.setName("xp").setDescription("Neue XP").setRequired(true).setMinValue(0)),

  new SlashCommandBuilder()
    .setName("addxp")
    .setDescription("ADMIN: Addiert XP zu einem User.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((opt) => opt.setName("user").setDescription("User").setRequired(true))
    .addIntegerOption((opt) => opt.setName("xp").setDescription("XP hinzufügen").setRequired(true).setMinValue(0)),

  new SlashCommandBuilder()
    .setName("setlevel")
    .setDescription("ADMIN: Setzt Level (XP wird passend gesetzt).")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((opt) => opt.setName("user").setDescription("User").setRequired(true))
    .addIntegerOption((opt) => opt.setName("level").setDescription("Neues Level").setRequired(true).setMinValue(0)),

  new SlashCommandBuilder()
    .setName("resetxp")
    .setDescription("ADMIN: Reset XP/Level eines Users.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((opt) => opt.setName("user").setDescription("User").setRequired(true)),

  new SlashCommandBuilder()
    .setName("setprestige")
    .setDescription("ADMIN: Setzt Prestige.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((opt) => opt.setName("user").setDescription("User").setRequired(true))
    .addIntegerOption((opt) => opt.setName("prestige").setDescription("Neues Prestige").setRequired(true).setMinValue(0)),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID),
    { body: commands }
  );
}

// =====================
// Role rewards (disabled until you add ROLE_REWARDS)
// =====================
function getEligibleRewards(level) {
  const sorted = [...ROLE_REWARDS].sort((a, b) => a.level - b.level);
  return sorted.filter((r) => level >= r.level);
}
async function applyRoleRewards(member, newLevel) {
  if (!ROLE_REWARDS.length) return;

  const eligible = getEligibleRewards(newLevel);
  if (eligible.length === 0) return;

  if (STACK_ROLE_REWARDS) {
    for (const r of eligible) {
      const role = member.guild.roles.cache.get(r.roleId);
      if (!role) continue;
      if (!member.roles.cache.has(role.id)) {
        await member.roles.add(role).catch(() => {});
      }
    }
  } else {
    const highest = eligible[eligible.length - 1];
    const highestRole = member.guild.roles.cache.get(highest.roleId);
    if (highestRole && !member.roles.cache.has(highestRole.id)) {
      await member.roles.add(highestRole).catch(() => {});
    }
    for (const r of ROLE_REWARDS) {
      if (r.roleId === highest.roleId) continue;
      if (member.roles.cache.has(r.roleId)) {
        await member.roles.remove(r.roleId).catch(() => {});
      }
    }
  }
}

function applyPrestigeMultiplier(baseXp, prestige) {
  const mult = 1 + prestige * PRESTIGE_XP_BONUS_PER_LEVEL;
  return Math.max(0, Math.floor(baseXp * mult));
}

async function addXpAndHandleLevelUp(guild, userId, baseXpToAdd, source, channelForMsg = null) {
  const row = stmtGetUser.get(guild.id, userId) || {
    xp: 0, level: 0, prestige: 0,
    last_text_xp_at: 0, last_voice_xp_at: 0,
    last_msg_norm: "", last_msg_at: 0,
  };

  const xpToAdd = applyPrestigeMultiplier(baseXpToAdd, row.prestige);

  const oldXp = row.xp;
  const oldLevel = row.level;

  const newXp = oldXp + xpToAdd;
  const newLevel = Math.max(oldLevel, levelFromTotalXp(newXp));

  stmtUpsertUser.run(
    guild.id, userId, newXp, newLevel, row.prestige,
    row.last_text_xp_at, row.last_voice_xp_at, row.last_msg_norm, row.last_msg_at
  );

  if (newLevel > oldLevel) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) await applyRoleRewards(member, newLevel);

    const msgChannel =
      (LEVELUP_CHANNEL_ID && guild.channels.cache.get(LEVELUP_CHANNEL_ID)) || channelForMsg;

    if (msgChannel?.isTextBased?.()) {
      const nextTotal = totalXpForLevel(newLevel + 1);
      const curTotal = totalXpForLevel(newLevel);
      const within = newXp - curTotal;
      const needed = nextTotal - curTotal;

      const embed = new EmbedBuilder()
        .setTitle("🎉 Level Up!")
        .setDescription(`<@${userId}> ist jetzt **Level ${newLevel}**!`)
        .addFields(
          { name: "Quelle", value: source, inline: true },
          { name: "Prestige", value: `${row.prestige}`, inline: true },
          { name: "Gesamt XP", value: `${newXp.toLocaleString("de-DE")}`, inline: true },
          { name: "Fortschritt", value: `${within}/${needed} XP`, inline: false }
        );

      msgChannel.send({ embeds: [embed] }).catch(() => {});
    }
  }
}

async function handleTextXp(message) {
  if (!message.guild) return;
  if (message.author.bot) return;
  if (NO_TEXT_XP_CHANNELS.has(message.channel.id)) return;

  const guildId = message.guild.id;
  const userId = message.author.id;
  const now = nowSec();

  const row = stmtGetUser.get(guildId, userId) || {
    xp: 0, level: 0, prestige: 0,
    last_text_xp_at: 0, last_voice_xp_at: 0,
    last_msg_norm: "", last_msg_at: 0,
  };

  if (now - row.last_text_xp_at < TEXT_XP_COOLDOWN_SECONDS) return;

  const raw = message.content ?? "";
  const norm = normalizeContent(raw);

  if (norm.length < MIN_MESSAGE_LENGTH_FOR_XP) return;
  if (BLOCK_IF_ONLY_EMOJIS && isOnlyEmojis(raw)) return;

  if (norm && row.last_msg_norm === norm && (now - row.last_msg_at) <= DUPLICATE_WINDOW_SECONDS) {
    stmtUpsertUser.run(
      guildId, userId, row.xp, row.level, row.prestige,
      row.last_text_xp_at, row.last_voice_xp_at, norm, now
    );
    return;
  }

  if ((now - row.last_msg_at) <= RAPID_MESSAGE_WINDOW_SECONDS) return;

  const gained = randInt(TEXT_XP_MIN, TEXT_XP_MAX);

  stmtUpsertUser.run(
    guildId, userId, row.xp, row.level, row.prestige,
    now, row.last_voice_xp_at, norm, now
  );

  await addXpAndHandleLevelUp(message.guild, userId, gained, "Textchat", message.channel);
}

function isEligibleForVoiceXp(member) {
  if (!member?.voice?.channelId) return false;
  if (NO_VOICE_XP_CHANNELS.has(member.voice.channelId)) return false;

  if (VOICE_REQUIRE_UNMUTED) {
    const v = member.voice;
    if (v.selfMute || v.selfDeaf || v.serverMute || v.serverDeaf) return false;
  }

  const ch = member.voice.channel;
  if (!ch) return false;

  const nonBotMembers = ch.members.filter((m) => !m.user.bot);
  if (nonBotMembers.size < VOICE_MIN_MEMBERS) return false;

  return true;
}

async function voiceXpTick() {
  for (const guild of client.guilds.cache.values()) {
    const sessions = db
      .prepare(`SELECT guild_id, user_id, channel_id, joined_at FROM voice_sessions WHERE guild_id = ?`)
      .all(guild.id);

    for (const s of sessions) {
      const member = await guild.members.fetch(s.user_id).catch(() => null);
      if (!member) {
        stmtDeleteVoiceSession.run(guild.id, s.user_id);
        continue;
      }
      if (member.voice.channelId !== s.channel_id) {
        stmtDeleteVoiceSession.run(guild.id, s.user_id);
        continue;
      }
      if (!isEligibleForVoiceXp(member)) continue;

      const now = nowSec();
      const row = stmtGetUser.get(guild.id, s.user_id) || {
        xp: 0, level: 0, prestige: 0,
        last_text_xp_at: 0, last_voice_xp_at: 0,
        last_msg_norm: "", last_msg_at: 0,
      };

      if (now - row.last_voice_xp_at < VOICE_AWARD_INTERVAL_SECONDS) continue;

      stmtUpsertUser.run(
        guild.id, s.user_id, row.xp, row.level, row.prestige,
        row.last_text_xp_at, now, row.last_msg_norm, row.last_msg_at
      );

      await addXpAndHandleLevelUp(guild, s.user_id, VOICE_XP_PER_MINUTE, "Voicechat", null);
    }
  }
}

client.on("voiceStateUpdate", (oldState, newState) => {
  const guild = newState.guild;
  const member = newState.member;
  if (!guild || !member || member.user.bot) return;

  const oldChannelId = oldState.channelId;
  const newChannelId = newState.channelId;

  if (oldChannelId && !newChannelId) {
    stmtDeleteVoiceSession.run(guild.id, member.id);
    return;
  }
  if (!oldChannelId && newChannelId) {
    if (NO_VOICE_XP_CHANNELS.has(newChannelId)) return;
    stmtUpsertVoiceSession.run(guild.id, member.id, newChannelId, nowSec());
    return;
  }
  if (oldChannelId && newChannelId && oldChannelId !== newChannelId) {
    if (NO_VOICE_XP_CHANNELS.has(newChannelId)) {
      stmtDeleteVoiceSession.run(guild.id, member.id);
      return;
    }
    stmtUpsertVoiceSession.run(guild.id, member.id, newChannelId, nowSec());
  }
});

async function doPrestige(guild, userId, channelForMsg = null) {
  const row = stmtGetUser.get(guild.id, userId) || {
    xp: 0, level: 0, prestige: 0,
    last_text_xp_at: 0, last_voice_xp_at: 0,
    last_msg_norm: "", last_msg_at: 0,
  };

  if (row.level < PRESTIGE_MIN_LEVEL) {
    return { ok: false, reason: `Du brauchst Level ${PRESTIGE_MIN_LEVEL} (aktuell ${row.level}).` };
  }

  const newPrestige = row.prestige + 1;

  stmtUpsertUser.run(
    guild.id, userId, 0, 0, newPrestige,
    row.last_text_xp_at, row.last_voice_xp_at, row.last_msg_norm, row.last_msg_at
  );

  const msgChannel =
    (LEVELUP_CHANNEL_ID && guild.channels.cache.get(LEVELUP_CHANNEL_ID)) || channelForMsg;

  if (msgChannel?.isTextBased?.()) {
    const embed = new EmbedBuilder()
      .setTitle("✨ Prestige!")
      .setDescription(`<@${userId}> ist jetzt **Prestige ${newPrestige}**!\nLevel & XP wurden zurückgesetzt.`)
      .addFields({
        name: "Neuer XP-Bonus",
        value: `+${Math.round(newPrestige * PRESTIGE_XP_BONUS_PER_LEVEL * 100)}%`,
        inline: true,
      });
    msgChannel.send({ embeds: [embed] }).catch(() => {});
  }

  return { ok: true, prestige: newPrestige };
}

// =====================
// EVENTS
// =====================
client.on("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands().catch((e) => console.error("Command register failed:", e));

  setInterval(() => {
    voiceXpTick().catch((e) => console.error("voiceXpTick error:", e));
  }, 15_000);
});

client.on("messageCreate", async (message) => {
  try { await handleTextXp(message); } catch (e) { console.error(e); }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const guildId = interaction.guildId;
  if (!guildId) return interaction.reply({ content: "Nur auf Servern nutzbar.", ephemeral: true });

  if (interaction.commandName === "rank") {
    const target = interaction.options.getUser("user") || interaction.user;
    const row = stmtGetUser.get(guildId, target.id) || { xp: 0, level: 0, prestige: 0 };

    const curTotal = totalXpForLevel(row.level);
    const nextTotal = totalXpForLevel(row.level + 1);
    const within = row.xp - curTotal;
    const needed = nextTotal - curTotal;

    const embed = new EmbedBuilder()
      .setTitle(`📈 Rank von ${target.username}`)
      .addFields(
        { name: "Prestige", value: `${row.prestige}`, inline: true },
        { name: "Level", value: `${row.level}`, inline: true },
        { name: "Gesamt XP", value: `${row.xp.toLocaleString("de-DE")}`, inline: true },
        { name: "Bis nächstes Level", value: `${within}/${needed} XP`, inline: false }
      );
    return interaction.reply({ embeds: [embed] });
  }

  if (interaction.commandName === "leaderboard") {
    const top = stmtTop.all(guildId, 10);
    if (!top.length) return interaction.reply({ content: "Noch keine Daten 🙂", ephemeral: true });

    const lines = await Promise.all(
      top.map(async (u, idx) => {
        const member = await interaction.guild.members.fetch(u.user_id).catch(() => null);
        const name = member?.user?.username ?? `User ${u.user_id}`;
        return `**${idx + 1}.** ${name} — P${u.prestige} • L${u.level} — **${u.xp.toLocaleString("de-DE")} XP**`;
      })
    );

    const embed = new EmbedBuilder().setTitle("🏆 Leaderboard").setDescription(lines.join("\n"));
    return interaction.reply({ embeds: [embed] });
  }

  if (interaction.commandName === "prestige") {
    await interaction.deferReply({ ephemeral: true });
    const res = await doPrestige(interaction.guild, interaction.user.id, interaction.channel);
    if (!res.ok) return interaction.editReply(res.reason);
    return interaction.editReply(`✅ Prestige erfolgreich: **${res.prestige}**`);
  }

  // Admin double-check
  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);

  if (["setxp", "addxp", "setlevel", "resetxp", "setprestige"].includes(interaction.commandName) && !isAdmin) {
    return interaction.reply({ content: "❌ Nur Admins.", ephemeral: true });
  }

  if (interaction.commandName === "setxp") {
    const user = interaction.options.getUser("user", true);
    const xp = interaction.options.getInteger("xp", true);
    const row = stmtGetUser.get(guildId, user.id) || { xp: 0, level: 0, prestige: 0, last_text_xp_at: 0, last_voice_xp_at: 0, last_msg_norm: "", last_msg_at: 0 };
    const newLevel = levelFromTotalXp(xp);
    stmtUpsertUser.run(guildId, user.id, xp, newLevel, row.prestige, row.last_text_xp_at, row.last_voice_xp_at, row.last_msg_norm, row.last_msg_at);
    return interaction.reply({ content: `✅ XP gesetzt: ${user} → ${xp} XP (Level ${newLevel})`, ephemeral: true });
  }

  if (interaction.commandName === "addxp") {
    const user = interaction.options.getUser("user", true);
    const add = interaction.options.getInteger("xp", true);
    const row = stmtGetUser.get(guildId, user.id) || { xp: 0, level: 0, prestige: 0, last_text_xp_at: 0, last_voice_xp_at: 0, last_msg_norm: "", last_msg_at: 0 };
    const newXp = row.xp + add;
    const newLevel = levelFromTotalXp(newXp);
    stmtUpsertUser.run(guildId, user.id, newXp, newLevel, row.prestige, row.last_text_xp_at, row.last_voice_xp_at, row.last_msg_norm, row.last_msg_at);
    return interaction.reply({ content: `✅ XP hinzugefügt: ${user} → ${newXp} XP (Level ${newLevel})`, ephemeral: true });
  }

  if (interaction.commandName === "setlevel") {
    const user = interaction.options.getUser("user", true);
    const level = interaction.options.getInteger("level", true);
    const row = stmtGetUser.get(guildId, user.id) || { xp: 0, level: 0, prestige: 0, last_text_xp_at: 0, last_voice_xp_at: 0, last_msg_norm: "", last_msg_at: 0 };
    const xp = totalXpForLevel(level);
    stmtUpsertUser.run(guildId, user.id, xp, level, row.prestige, row.last_text_xp_at, row.last_voice_xp_at, row.last_msg_norm, row.last_msg_at);
    return interaction.reply({ content: `✅ Level gesetzt: ${user} → Level ${level}`, ephemeral: true });
  }

  if (interaction.commandName === "resetxp") {
    const user = interaction.options.getUser("user", true);
    const row = stmtGetUser.get(guildId, user.id) || { xp: 0, level: 0, prestige: 0, last_text_xp_at: 0, last_voice_xp_at: 0, last_msg_norm: "", last_msg_at: 0 };
    stmtUpsertUser.run(guildId, user.id, 0, 0, row.prestige, row.last_text_xp_at, row.last_voice_xp_at, row.last_msg_norm, row.last_msg_at);
    return interaction.reply({ content: `✅ Reset: ${user} → 0 XP / Level 0 (Prestige bleibt ${row.prestige})`, ephemeral: true });
  }

  if (interaction.commandName === "setprestige") {
    const user = interaction.options.getUser("user", true);
    const prestige = interaction.options.getInteger("prestige", true);
    const row = stmtGetUser.get(guildId, user.id) || { xp: 0, level: 0, prestige: 0, last_text_xp_at: 0, last_voice_xp_at: 0, last_msg_norm: "", last_msg_at: 0 };
    stmtUpsertUser.run(guildId, user.id, row.xp, row.level, prestige, row.last_text_xp_at, row.last_voice_xp_at, row.last_msg_norm, row.last_msg_at);
    return interaction.reply({ content: `✅ Prestige gesetzt: ${user} → Prestige ${prestige}`, ephemeral: true });
  }
});

client.login(process.env.DISCORD_TOKEN);
