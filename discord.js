#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
} = require('discord.js');

loadDotEnv(path.join(__dirname, '.env'));

const token = (process.env.DISCORD_BOT_TOKEN || '').trim();
const prefix = (process.env.DISCORD_COMMAND_PREFIX || '!').trim() || '!';
const channels = loadChannelMap();

const WAITLIST_CHANNEL_ID = resolveConfiguredChannelId(
  process.env.DISCORD_WAITLIST_CHANNEL_ID,
  ['waitlist'],
);
const DONATION_CHANNEL_ID = resolveConfiguredChannelId(
  process.env.DISCORD_DONATION_CHANNEL_ID,
  ['donation', 'donate', 'support'],
);
const PREMIUM_CHANNEL_ID = resolveConfiguredChannelId(
  process.env.DISCORD_PREMIUM_CHANNEL_ID,
  ['premium', 'premium-chat'],
);
const DAILY_ANNOUNCE_CHANNEL_ID = resolveConfiguredChannelId(
  process.env.DISCORD_DAILY_ANNOUNCE_CHANNEL_ID,
  ['announcements', 'announcement'],
);
const WELCOME_CHANNEL_ID = resolveConfiguredChannelId(
  process.env.DISCORD_WELCOME_CHANNEL_ID,
  ['welcome', 'general'],
);

const enableModeration = envBool('DISCORD_MODERATION_ENABLED', true);
const enableReleaseResponder = envBool('DISCORD_RELEASE_RESPONDER_ENABLED', true);
const enableWelcome = envBool('DISCORD_WELCOME_ENABLED', true);
const enableDailyAnnouncement = envBool('DISCORD_DAILY_ANNOUNCE_ENABLED', true);
const mentionEveryoneOnDailyAnnouncement = envBool(
  'DISCORD_DAILY_ANNOUNCE_MENTION_EVERYONE',
  true,
);

const releaseReplyCooldownMs = intEnv('DISCORD_RELEASE_REPLY_COOLDOWN_MS', 120000);
const spamWindowMs = intEnv('DISCORD_SPAM_WINDOW_MS', 10000);
const spamMaxMessages = intEnv('DISCORD_SPAM_MAX_MESSAGES', 5);
const duplicateWindowMs = intEnv('DISCORD_DUPLICATE_WINDOW_MS', 30000);
const duplicateMaxMessages = intEnv('DISCORD_DUPLICATE_MAX_MESSAGES', 3);
const processedMessageIdMaxSize = intEnv(
  'DISCORD_PROCESSED_MESSAGE_CACHE_SIZE',
  5000,
);

const dailySchedule = parseDailyTime(process.env.DISCORD_DAILY_ANNOUNCE_TIME || '16:30');
const dailyScheduleTz = process.env.DISCORD_DAILY_ANNOUNCE_TZ || 'Europe/Berlin';
const instanceLockPath = path.resolve(__dirname, '.discord-bot.lock');

const userMessageHistory = new Map();
const releaseReplyCooldown = new Map();
const processedMessageIds = new Set();
const replyInFlightByMessageId = new Set();

const insultKeywords = loadWordList(
  process.env.DISCORD_INSULT_KEYWORDS,
  [
    'hurensohn',
    'fick dich',
    'arschloch',
    'idiot',
    'bastard',
    'asshole',
    'fuck you',
    'motherfucker',
    'nutte',
    'retard',
    'wichser',
  ],
);

const releasePatterns = [
  /\bwhen\b.{0,35}\b(release|launch|drop|out)\b/i,
  /\b(is|when)\b.{0,25}\b(app|game)\b.{0,20}\b(out|released|live)\b/i,
  /\bapp\b.{0,25}\b(release date|out now|released)\b/i,
  /\bwann\b.{0,35}\b(release|launch|raus|drau[ßs]en|online|kommt)\b/i,
  /\bist\b.{0,25}\b(app|spiel)\b.{0,20}\b(drau[ßs]en|online)\b/i,
];

if (!token) {
  console.error('[discord] Missing DISCORD_BOT_TOKEN in .env');
  console.error('[discord] Copy .env.example to .env and fill your real token and channel IDs.');
  process.exit(1);
}

acquireProcessLock();
installShutdownHandlers();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('clientReady', () => {
  console.log(`[discord] Logged in as ${client.user.tag}`);
  console.log(`[discord] Command prefix: ${prefix}`);

  const keys = Object.keys(channels);
  if (keys.length > 0) {
    console.log(`[discord] Loaded ${keys.length} channel key(s): ${keys.join(', ')}`);
  } else {
    console.log('[discord] No channel map found. Use discord.channels.json or DISCORD_CHANNEL_* env vars.');
  }

  if (enableDailyAnnouncement) {
    startDailyAnnouncementScheduler();
  }
});

client.on('guildMemberAdd', async (member) => {
  if (!enableWelcome || !WELCOME_CHANNEL_ID) return;
  const welcomeChannel = await fetchTextChannelById(WELCOME_CHANNEL_ID);
  if (!welcomeChannel) return;

  const welcomeText = [
    `Welcome ${member}, hunter.`,
    `Start here and join the waitlist: ${channelMention(WAITLIST_CHANNEL_ID, 'waitlist')}`,
  ].join('\n');

  await welcomeChannel.send(welcomeText).catch((error) => {
    console.error('[discord] Welcome message failed:', error.message);
  });
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  if (isMessageAlreadyProcessed(message.id)) return;
  markMessageProcessed(message.id);

  try {
    const normalized = normalizeForMatch(message.content);

    if (enableModeration && !isModerator(message.member)) {
      const moderation = detectModerationReason(message, normalized);
      if (moderation) {
        await deleteMessageWithReason(message, moderation);
        return;
      }
    }

    if (
      enableReleaseResponder &&
      !message.content.startsWith(prefix) &&
      shouldReplyAboutRelease(normalized, message.author.id)
    ) {
      await safeReplyOnce(
        message,
        `Hunter, release updates are posted in ${channelMention(
          WAITLIST_CHANNEL_ID,
          'waitlist',
        )}. Join now for early access.`,
      );
    }

    if (!message.content.startsWith(prefix)) return;

    const raw = message.content.slice(prefix.length).trim();
    if (!raw) return;

    const [command, ...args] = raw.split(/\s+/);
    const cmd = command.toLowerCase();

    if (cmd === 'ping') {
      await message.reply('Pong.');
      return;
    }

    if (cmd === 'help') {
      await message.reply(
        [
          `\`${prefix}ping\` -> bot health check`,
          `\`${prefix}channels\` -> list configured channel keys`,
          `\`${prefix}say <channelKey|channelId|#channelId> <message>\` -> post message`,
          `Auto features: spam cleanup, insult cleanup, ad cleanup, release waitlist replies, daily announcement.`,
        ].join('\n'),
      );
      return;
    }

    if (cmd === 'channels') {
      const keys = Object.keys(channels);
      if (keys.length === 0) {
        await message.reply('No channels configured yet.');
        return;
      }
      const rows = keys.map((k) => `${k}: ${channels[k]}`);
      await message.reply(`Configured channels:\n${rows.join('\n')}`);
      return;
    }

    if (cmd === 'say') {
      await handleSay(message, args);
      return;
    }
  } catch (error) {
    console.error('[discord] messageCreate handler failed:', error);
    await safeReply(message, 'Command failed. Check bot logs.');
  }
});

client.on('error', (error) => {
  console.error('[discord] Client error:', error);
});

client.login(token).catch((error) => {
  console.error('[discord] Login failed:', error?.message || error);
  releaseProcessLock();
  process.exitCode = 1;
  try {
    client.destroy();
  } catch (_) {
    // no-op
  }
});

async function handleSay(message, args) {
  if (args.length < 2) {
    await safeReply(
      message,
      `Usage: ${prefix}say <channelKey|channelId|#channelId> <message>`,
    );
    return;
  }

  if (
    !message.memberPermissions?.has(PermissionsBitField.Flags.ManageMessages) &&
    !message.memberPermissions?.has(PermissionsBitField.Flags.Administrator)
  ) {
    await safeReply(
      message,
      'You need Manage Messages (or Administrator) to use this command.',
    );
    return;
  }

  const channelArg = args.shift();
  const content = args.join(' ').trim();
  const channelId = resolveChannelId(channelArg);

  if (!channelId) {
    await safeReply(
      message,
      `Unknown channel "${channelArg}". Run ${prefix}channels to see valid keys.`,
    );
    return;
  }

  const target = await fetchTextChannelById(channelId);
  if (!target) {
    await safeReply(message, 'Target channel not found or not text-based.');
    return;
  }

  await target.send(content);
  await safeReply(message, `Sent to <#${target.id}>.`);
}

function detectModerationReason(message, normalizedText) {
  if (!normalizedText) return null;

  if (containsInsult(normalizedText)) {
    return 'insult';
  }

  if (isSpam(message.author.id, normalizedText)) {
    return 'spam';
  }

  if (looksLikeOtherAppAd(normalizedText)) {
    return 'advertising-other-app';
  }

  return null;
}

function containsInsult(normalizedText) {
  return insultKeywords.some((word) => normalizedText.includes(word));
}

function isSpam(userId, normalizedText) {
  const now = Date.now();
  const existing = userMessageHistory.get(userId) || [];
  const filtered = existing.filter(
    (item) => now - item.timestamp <= Math.max(spamWindowMs, duplicateWindowMs),
  );
  filtered.push({ timestamp: now, content: normalizedText });
  userMessageHistory.set(userId, filtered);

  const rapidCount = filtered.filter((item) => now - item.timestamp <= spamWindowMs).length;
  if (rapidCount >= spamMaxMessages) {
    return true;
  }

  const duplicateCount = filtered.filter(
    (item) =>
      now - item.timestamp <= duplicateWindowMs &&
      item.content &&
      item.content === normalizedText,
  ).length;

  return duplicateCount >= duplicateMaxMessages;
}

function looksLikeOtherAppAd(normalizedText) {
  const hasLink = /(https?:\/\/\S+|www\.\S+|discord\.gg\/\S+)/i.test(normalizedText);
  const appPromoPhrase =
    /\b(download|install|try|check out|join|promo|promotion)\b.{0,20}\b(app|game|server)\b/i.test(
      normalizedText,
    ) ||
    /\b(my app|our app|new app|other app|another app)\b/i.test(normalizedText) ||
    /\b(app store|play store)\b/i.test(normalizedText);

  const mentionsShadowrank = /\bshadowrank\b/i.test(normalizedText);
  return appPromoPhrase && !mentionsShadowrank && (hasLink || /\bapp|game|server\b/i.test(normalizedText));
}

function shouldReplyAboutRelease(normalizedText, userId) {
  if (!normalizedText) return false;
  if (!WAITLIST_CHANNEL_ID) return false;
  if (!releasePatterns.some((pattern) => pattern.test(normalizedText))) return false;

  const now = Date.now();
  const last = releaseReplyCooldown.get(userId) || 0;
  if (now - last < releaseReplyCooldownMs) {
    return false;
  }

  releaseReplyCooldown.set(userId, now);
  return true;
}

async function deleteMessageWithReason(message, reason) {
  try {
    await message.delete();
    const warning = await message.channel.send(
      `${message.author}, your message was removed (${reason}).`,
    );
    setTimeout(() => {
      warning.delete().catch(() => {});
    }, 8000).unref?.();
  } catch (error) {
    console.error('[discord] Failed to delete message:', error.message);
  }
}

function startDailyAnnouncementScheduler() {
  if (!DAILY_ANNOUNCE_CHANNEL_ID) {
    console.warn('[discord] Daily announce enabled but no announce channel configured.');
    return;
  }

  console.log(
    `[discord] Daily announcement scheduled for ${pad2(dailySchedule.hour)}:${pad2(
      dailySchedule.minute,
    )} (${dailyScheduleTz}) in #${DAILY_ANNOUNCE_CHANNEL_ID}`,
  );

  let lastSentDayKey = '';
  const timer = setInterval(async () => {
    if (!client.isReady()) return;

    const now = getZonedDateParts(dailyScheduleTz);
    if (!now) return;

    if (now.hour !== dailySchedule.hour || now.minute !== dailySchedule.minute) {
      return;
    }

    const dayKey = `${now.year}-${now.month}-${now.day}`;
    if (dayKey === lastSentDayKey) {
      return;
    }
    lastSentDayKey = dayKey;

    const channel = await fetchTextChannelById(DAILY_ANNOUNCE_CHANNEL_ID);
    if (!channel) {
      console.error('[discord] Daily announce channel not available.');
      return;
    }

    const text = [
      mentionEveryoneOnDailyAnnouncement ? '@everyone' : null,
      `Hunters, register ASAP in ${channelMention(
        WAITLIST_CHANNEL_ID,
        'waitlist',
      )} to secure early access. The waitlist will close in a few days.`,
      `Want to support the project? Donate in ${channelMention(
        DONATION_CHANNEL_ID,
        'donation',
      )}. Supporters get access to ${channelMention(
        PREMIUM_CHANNEL_ID,
        'premium-chat',
      )} with dev insights, beta testing, early access, and bonus gifts (including app credits).`,
    ]
      .filter(Boolean)
      .join('\n');

    await channel
      .send({
        content: text,
        allowedMentions: mentionEveryoneOnDailyAnnouncement
          ? { parse: ['everyone'] }
          : { parse: [] },
      })
      .catch((error) => {
      console.error('[discord] Daily announcement failed:', error.message);
      });
  }, 15000);

  timer.unref?.();
}

async function fetchTextChannelById(channelId) {
  if (!channelId) return null;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return null;
  return channel;
}

function isModerator(member) {
  return Boolean(
    member?.permissions?.has(PermissionsBitField.Flags.ManageMessages) ||
      member?.permissions?.has(PermissionsBitField.Flags.Administrator),
  );
}

function resolveChannelId(channelArg) {
  const value = String(channelArg || '').trim();
  if (!value) return null;

  const mentionMatch = value.match(/^<#(\d+)>$/);
  if (mentionMatch) return mentionMatch[1];
  if (/^\d+$/.test(value)) return value;

  const normalized = normalizeKey(value);
  if (channels[normalized]) return channels[normalized];

  return null;
}

function resolveConfiguredChannelId(envValue, fallbackKeys = []) {
  const fromEnv = String(envValue || '').trim();
  if (/^\d+$/.test(fromEnv)) return fromEnv;

  for (const key of fallbackKeys) {
    const value = channels[normalizeKey(key)];
    if (value) return value;
  }

  return null;
}

function channelMention(channelId, fallbackName) {
  if (channelId) return `<#${channelId}>`;
  return `#${fallbackName}`;
}

function loadChannelMap() {
  const fromFile = loadChannelMapFromFile();
  const fromEnvKeys = loadChannelMapFromEnvKeys();
  const fromEnvJson = loadChannelMapFromEnvJson();

  return {
    ...fromFile,
    ...fromEnvKeys,
    ...fromEnvJson,
  };
}

function loadChannelMapFromFile() {
  const configuredPath = process.env.DISCORD_CHANNELS_FILE || 'discord.channels.json';
  const filePath = path.resolve(__dirname, configuredPath);
  let resolvedFilePath = filePath;

  if (!fs.existsSync(resolvedFilePath)) {
    const fallback = findFallbackChannelFile();
    if (!fallback) return {};
    resolvedFilePath = fallback;
    console.warn(
      `[discord] Using fallback channel file: ${path.basename(resolvedFilePath)}`,
    );
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(resolvedFilePath, 'utf8'));
    return normalizeChannelMap(parsed);
  } catch (error) {
    console.error(
      `[discord] Failed to parse channel file ${path.basename(resolvedFilePath)}:`,
      error.message,
    );
    return {};
  }
}

function findFallbackChannelFile() {
  try {
    const files = fs.readdirSync(__dirname);
    const candidates = files
      .filter((name) => /^discord\.channels.*\.json$/i.test(name))
      .sort();
    if (candidates.length === 0) return null;
    return path.resolve(__dirname, candidates[0]);
  } catch (_) {
    return null;
  }
}

function loadChannelMapFromEnvKeys() {
  const map = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('DISCORD_CHANNEL_')) continue;
    const cleanValue = String(value || '').trim();
    if (!/^\d+$/.test(cleanValue)) continue;

    const cleanKey = key
      .replace('DISCORD_CHANNEL_', '')
      .toLowerCase()
      .replace(/__+/g, ':')
      .replace(/_+/g, '-');
    if (!cleanKey) continue;

    map[normalizeKey(cleanKey)] = cleanValue;
  }
  return map;
}

function loadChannelMapFromEnvJson() {
  const raw = process.env.DISCORD_CHANNELS_JSON;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return normalizeChannelMap(parsed);
  } catch (error) {
    console.error('[discord] Failed to parse DISCORD_CHANNELS_JSON:', error.message);
    return {};
  }
}

function normalizeChannelMap(map) {
  if (!map || typeof map !== 'object') return {};

  const normalized = {};
  for (const [key, value] of Object.entries(map)) {
    const cleanKey = normalizeKey(key);
    const cleanValue = String(value || '').trim();
    if (!cleanKey || !/^\d+$/.test(cleanValue)) continue;
    normalized[cleanKey] = cleanValue;
  }
  return normalized;
}

function normalizeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^#+/, '')
    .replace(/\s+/g, '-');
}

function normalizeForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s:/.#_-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function loadWordList(raw, defaults) {
  if (!raw) return defaults;
  const fromEnv = raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return fromEnv.length > 0 ? fromEnv : defaults;
}

function envBool(key, fallback) {
  const raw = process.env[key];
  if (raw == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase().trim());
}

function intEnv(key, fallback) {
  const raw = Number(process.env[key]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

function parseDailyTime(value) {
  const match = String(value || '')
    .trim()
    .match(/^(\d{1,2}):(\d{1,2})$/);

  if (!match) {
    return { hour: 16, minute: 30 };
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { hour: 16, minute: 30 };
  }

  return { hour, minute };
}

function getZonedDateParts(timeZone) {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    const parts = formatter.formatToParts(new Date());
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return {
      year: Number(map.year),
      month: Number(map.month),
      day: Number(map.day),
      hour: Number(map.hour),
      minute: Number(map.minute),
    };
  } catch (error) {
    console.error('[discord] Invalid timezone for schedule:', timeZone, error.message);
    return null;
  }
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

async function safeReply(message, content) {
  try {
    await message.reply(content);
  } catch (error) {
    console.error('[discord] Reply failed:', error.message);
  }
}

async function safeReplyOnce(message, content) {
  const messageId = String(message?.id || '');
  if (!messageId) return;
  if (replyInFlightByMessageId.has(messageId)) return;

  replyInFlightByMessageId.add(messageId);

  try {
    await sleep(120 + Math.floor(Math.random() * 380));

    const alreadyReplied = await hasBotAlreadyReplied(message);
    if (alreadyReplied) return;

    await message.reply(content);
  } catch (error) {
    console.error('[discord] Reply-once failed:', error.message);
  } finally {
    replyInFlightByMessageId.delete(messageId);
  }
}

async function hasBotAlreadyReplied(message) {
  try {
    if (!client.user) return false;
    if (!message?.channel?.isTextBased?.()) return false;

    const nearby = await message.channel.messages.fetch({
      around: message.id,
      limit: 50,
    });

    for (const candidate of nearby.values()) {
      if (candidate.author?.id !== client.user.id) continue;
      if (candidate.reference?.messageId === message.id) {
        return true;
      }
    }

    return false;
  } catch (_) {
    return false;
  }
}

function isMessageAlreadyProcessed(messageId) {
  return processedMessageIds.has(String(messageId));
}

function markMessageProcessed(messageId) {
  const id = String(messageId);
  processedMessageIds.add(id);

  while (processedMessageIds.size > processedMessageIdMaxSize) {
    const oldest = processedMessageIds.values().next().value;
    if (!oldest) break;
    processedMessageIds.delete(oldest);
  }
}

function acquireProcessLock() {
  const existing = readLockFile();
  if (existing && Number(existing.pid) !== process.pid && isPidRunning(existing.pid)) {
    console.error(
      `[discord] Another bot process is already running (PID ${existing.pid}). Stop it first.`,
    );
    process.exit(1);
  }

  writeLockFile();
}

function installShutdownHandlers() {
  process.on('exit', () => {
    releaseProcessLock();
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      releaseProcessLock();
      process.exit(0);
    });
  }
}

function writeLockFile() {
  const data = JSON.stringify(
    {
      pid: process.pid,
      startedAt: new Date().toISOString(),
    },
    null,
    2,
  );
  fs.writeFileSync(instanceLockPath, data, 'utf8');
}

function readLockFile() {
  try {
    if (!fs.existsSync(instanceLockPath)) return null;
    const raw = fs.readFileSync(instanceLockPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function releaseProcessLock() {
  try {
    if (!fs.existsSync(instanceLockPath)) return;
    const existing = readLockFile();
    if (existing && Number(existing.pid) !== process.pid) return;
    fs.unlinkSync(instanceLockPath);
  } catch (_) {
    // no-op
  }
}

function isPidRunning(pid) {
  const numericPid = Number(pid);
  if (!Number.isFinite(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'EPERM') return true;
    return false;
  }
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex < 1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
