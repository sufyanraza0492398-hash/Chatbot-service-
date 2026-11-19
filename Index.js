"use strict";

/* ------------------------------------------------------------------
 * index.js - WhatsApp AI sales/support bot. No settings here:
 * everything comes from ./config. To add a command, add one entry
 * to the `commands` object.
 * ------------------------------------------------------------------ */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require("fs");
const readline = require("readline");
const config = require("./config");

const logger = pino({ level: "silent" }); // silent = very low RAM
const startTime = Date.now();

let sock = null;
let autoReply = !!config.AUTO_REPLY; // changed by .autoreply on/off
let ownerNotified = false;           // "connected" message only once
let reconnecting = false;

const history = {};        // chatId -> [{ role, content }]
const lastUse = {};        // userId -> timestamp of last AI use
const leadSent = {};       // chatId -> timestamp of last "new lead" alert
const sentIds = new Set(); // ids of messages the bot sent

const LEAD_REPEAT_MS = 6 * 60 * 60 * 1000; // one lead alert per chat per 6 hours

/* ============================ HELPERS ============================ */

const digits = (s) => String(s || "").split("@")[0].split(":")[0].replace(/\D/g, "");

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${d}d ${h}h ${m}m ${sec}s`;
}

// Remove WhatsApp wrapper layers (disappearing / view-once messages)
function unwrap(message) {
  let cur = message;
  for (let i = 0; i < 5; i++) {
    const inner =
      cur?.ephemeralMessage?.message ||
      cur?.viewOnceMessage?.message ||
      cur?.viewOnceMessageV2?.message ||
      cur?.documentWithCaptionMessage?.message;
    if (!inner) break;
    cur = inner;
  }
  return cur || {};
}

function getText(content) {
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    ""
  );
}

function rememberSent(sent) {
  const id = sent?.key?.id;
  if (!id) return;
  sentIds.add(id);
  if (sentIds.size > 300) sentIds.delete(sentIds.values().next().value);
}

// True when the message is a reply to one of the bot's own messages
function isReplyToBot(content) {
  const ci = content.extendedTextMessage?.contextInfo;
  if (!ci) return false;
  if (ci.stanzaId && sentIds.has(ci.stanzaId)) return true;
  const quoted = digits(ci.participant);
  return !!quoted && quoted === digits(sock?.user?.id);
}

// Owner = the bot's own account OR OWNER_NUMBER
function isOwnerMessage(msg, sender) {
  if (msg.key.fromMe) return true;
  const owner = digits(config.OWNER_NUMBER);
  return !!owner && digits(sender) === owner;
}

function cooldownLeft(key) {
  const wait = config.COOLDOWN_SECONDS * 1000 - (Date.now() - (lastUse[key] || 0));
  return wait > 0 ? Math.ceil(wait / 1000) : 0;
}

/* ============================== AI ============================== */

// Sends the chat to the AI. Returns the answer text, or null on error.
async function askAI(chatId, question) {
  const past = (history[chatId] || []).slice(-config.MAX_HISTORY);
  const messages = [
    { role: "system", content: config.SYSTEM_PROMPT },
    ...past,
    { role: "user", content: question },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000); // 20s timeout

  try {
    const res = await fetch(config.GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: config.GROQ_MODEL,
        reasoning_effort: config.REASONING_EFFORT,
        messages,
        max_tokens: 600,
      }),
      signal: controller.signal,
    });

    const raw = await res.text();
    if (!res.ok) {
      console.error(`[AI] HTTP ${res.status}: ${raw}`);
      return null;
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      console.error(`[AI] Invalid JSON (status ${res.status}): ${raw}`);
      return null;
    }

    const answer = (data?.choices?.[0]?.message?.content || "").trim();
    if (!answer) {
      console.error(`[AI] Empty answer (status ${res.status}): ${raw}`);
      return null;
    }

    // Save to history, trimmed to MAX_HISTORY
    const h = history[chatId] || (history[chatId] = []);
    h.push({ role: "user", content: question }, { role: "assistant", content: answer });
    if (h.length > config.MAX_HISTORY) h.splice(0, h.length - config.MAX_HISTORY);

    return answer.slice(0, 1500);
  } catch (err) {
    console.error(`[AI] Request failed: ${err && err.name === "AbortError" ? "timeout (20s)" : err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// When the AI says "our representative will contact you", alert the owner
// with the customer's number and what they wrote.
async function maybeNotifyOwner(ctx, answer) {
  if (ctx.isGroup || !answer.includes(config.LEAD_KEYWORD)) return;
  if (Date.now() - (leadSent[ctx.jid] || 0) < LEAD_REPEAT_MS) return;

  const ownerNum = digits(config.OWNER_NUMBER);
  if (!ownerNum) return;
  leadSent[ctx.jid] = Date.now();

  const lines = (history[ctx.jid] || [])
    .filter((m) => m.role === "user")
    .slice(-8)
    .map((m) => m.content.slice(0, 200));

  const text = config.section("NEW LEAD", [
    `CUSTOMER: wa.me/${digits(ctx.sender || ctx.jid)}`,
    ...lines,
  ]);

  try {
    await sock.sendMessage(`${ownerNum}@s.whatsapp.net`, { text });
  } catch (e) {
    console.error("[LEAD] Could not notify the owner:", e && e.message);
  }
}

// Cooldown + typing indicator + AI call + reply
async function handleAI(ctx, question, loud) {
  const key = ctx.sender || ctx.jid;
  const wait = cooldownLeft(key);
  if (wait > 0) {
    if (loud) await ctx.reply(`⏳ Please wait ${wait}s before asking again.`);
    return;
  }
  lastUse[key] = Date.now();

  try { await sock.sendPresenceUpdate("composing", ctx.jid); } catch (e) {}
  let answer = null;
  try {
    answer = await askAI(ctx.jid, question);
  } finally {
    try { await sock.sendPresenceUpdate("paused", ctx.jid); } catch (e) {}
  }
  await ctx.reply(answer || config.BUSY_MESSAGE);
  if (answer) await maybeNotifyOwner(ctx, answer);
}

/* ============================ MENU TEXT ============================ */

function botInfoSection() {
  return config.section("BOT INFO", [
    `OWNER: ${config.CREATOR_NAME}`,
    `PREFIX: ${config.PREFIX}`,
    `MODE: ${config.MODE}`,
    `AI REPLY: ${autoReply ? "ON" : "OFF"}`,
    "STATUS: Online",
    `UPTIME: ${formatUptime(Date.now() - startTime)}`,
  ]);
}

// Built automatically from the `commands` object, grouped by `cat`
function buildMenuText() {
  const cats = {};
  for (const [name, c] of Object.entries(commands)) {
    (cats[c.cat] = cats[c.cat] || []).push(`${config.PREFIX}${name} - ${c.desc}`);
  }
  const parts = [config.header(), botInfoSection()];
  for (const [cat, lines] of Object.entries(cats)) parts.push(config.section(cat, lines));
  parts.push(config.footer());
  return parts.join("\n\n");
}

/* ============================ COMMANDS ============================ */
// Each command: { cat, desc, run(ctx) }. Add a command = add one entry.
// ctx: { jid, sender, isGroup, isOwner, args, msg, reply }

const commands = {
  menu: {
    cat: "MAIN",
    desc: "Show this menu",
    run: async (ctx) => {
      const text = buildMenuText();
      if (config.BOT_IMAGE) {
        try {
          const sent = await sock.sendMessage(
            ctx.jid,
            { image: { url: config.BOT_IMAGE }, caption: text },
            { quoted: ctx.msg }
          );
          rememberSent(sent);
          return;
        } catch (e) {
          console.error("[menu] image failed, sending text:", e && e.message);
        }
      }
      await ctx.reply(text); // plain-text fallback
    },
  },

  ai: {
    cat: "AI",
    desc: "Ask the AI (example: .ai what services do you offer?)",
    run: async (ctx) => {
      if (!ctx.args) return ctx.reply(`Write your question after the command.\nExample: ${config.PREFIX}ai what services do you offer?`);
      await handleAI(ctx, ctx.args, true);
    },
  },

  reset: {
    cat: "AI",
    desc: "Clear the AI memory of this chat",
    run: async (ctx) => {
      delete history[ctx.jid];
      await ctx.reply("🧹 AI memory of this chat has been cleared.");
    },
  },

  autoreply: {
    cat: "AI",
    desc: "Turn AI auto reply on/off (owner only)",
    run: async (ctx) => {
      if (!ctx.isOwner) return ctx.reply("⛔ Only the owner can use this command.");
      const arg = (ctx.args || "").toLowerCase().trim();
      if (arg !== "on" && arg !== "off") {
        return ctx.reply(`Usage: ${config.PREFIX}autoreply on  or  ${config.PREFIX}autoreply off\nCurrent state: ${autoReply ? "ON" : "OFF"}`);
      }
      autoReply = arg === "on";
      await ctx.reply(`🤖 AI auto reply is now ${autoReply ? "ON ✅" : "OFF ❌"}`);
    },
  },

  about: {
    cat: "INFO",
    desc: "About this bot",
    run: async (ctx) => {
      await ctx.reply(
        config.section("ABOUT", [
          `BOT: ${config.BOT_NAME}`,
          `AI: ${config.AI_NAME}`,
          `CREATOR: ${config.CREATOR_NAME}`,
          `INFO: ${config.CREATOR_INFO}`,
          `VERSION: ${config.VERSION}`,
        ])
      );
    },
  },

  ping: {
    cat: "INFO",
    desc: "Check the bot speed",
    run: async (ctx) => {
      const start = Date.now();
      const sent = await ctx.reply("🏓 Pinging...");
      const ms = Date.now() - start;
      const text = config.section("PING", [`SPEED: ${ms} ms`]);
      try {
        await sock.sendMessage(ctx.jid, { text, edit: sent.key });
      } catch (e) {
        await ctx.reply(text);
      }
    },
  },

  alive: {
    cat: "INFO",
    desc: "Check if the bot is online",
    run: async (ctx) => {
      await ctx.reply(
        config.section("ALIVE", [
          "STATUS: Online ✅",
          `AI REPLY: ${autoReply ? "ON" : "OFF"}`,
          `UPTIME: ${formatUptime(Date.now() - startTime)}`,
        ])
      );
    },
  },

  owner: {
    cat: "INFO",
    desc: "Show the owner details",
    run: async (ctx) => {
      await ctx.reply(
        config.section("OWNER", [
          `NAME: ${config.CREATOR_NAME}`,
          `INFO: ${config.CREATOR_INFO}`,
          `CHAT: wa.me/${digits(config.OWNER_NUMBER)}`,
        ])
      );
    },
  },

  runtime: {
    cat: "INFO",
    desc: "Show how long the bot has been running",
    run: async (ctx) => {
      await ctx.reply(config.section("RUNTIME", [`UPTIME: ${formatUptime(Date.now() - startTime)}`]));
    },
  },

  time: {
    cat: "INFO",
    desc: "Show the current time",
    run: async (ctx) => {
      let now;
      try {
        now = new Date().toLocaleString("en-GB", {
          timeZone: config.TIMEZONE,
          dateStyle: "full",
          timeStyle: "medium",
        });
      } catch (e) {
        now = new Date().toUTCString();
      }
      await ctx.reply(config.section("TIME", [`ZONE: ${config.TIMEZONE}`, `NOW: ${now}`]));
    },
  },
};

/* ========================= MESSAGE HANDLING ========================= */

async function handleMessage(msg) {
  if (!msg.message) return;
  const jid = msg.key.remoteJid;
  if (!jid || jid === "status@broadcast" || jid.endsWith("@broadcast") || jid.endsWith("@newsletter")) return;

  const content = unwrap(msg.message);
  const text = getText(content).trim();
  if (!text) return;

  const isGroup = jid.endsWith("@g.us");
  const sender = isGroup ? msg.key.participant || "" : jid;
  const owner = isOwnerMessage(msg, sender);

  // PRIVATE mode: owner only
  if (config.MODE.toUpperCase() === "PRIVATE" && !owner) return;

  const reply = async (t) => {
    const sent = await sock.sendMessage(jid, { text: t }, { quoted: msg });
    rememberSent(sent);
    return sent;
  };

  // ---- Commands ----
  if (text.startsWith(config.PREFIX)) {
    const parts = text.slice(config.PREFIX.length).trim().split(/\s+/);
    const name = (parts.shift() || "").toLowerCase();
    const cmd = Object.prototype.hasOwnProperty.call(commands, name) ? commands[name] : null;
    if (!cmd) return;
    await cmd.run({ jid, sender, isGroup, isOwner: owner, args: parts.join(" "), msg, reply });
    return;
  }

  // ---- Auto reply (normal messages) ----
  if (msg.key.fromMe) return; // never answer our own messages
  if (!autoReply) return;
  if (isGroup && !isReplyToBot(content)) return; // groups: only .ai or replies to the bot

  await handleAI({ jid, sender, isGroup, isOwner: owner, msg, reply }, text, false);
}

/* ============================== PAIRING ============================== */

// Fallback prompt, only used if PAIR_NUMBER is empty
function askNumber() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { rl.close(); } catch (e) {}
      resolve(v);
    };
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const timer = setTimeout(() => finish(""), 20000);
    rl.question("Enter the WhatsApp number to link (with country code, no +): ", (a) => finish(digits(a)));
    rl.on("close", () => finish(""));
  });
}

async function requestPairing(s) {
  if (s !== sock || s.authState.creds.registered) return;
  try {
    let number = digits(config.PAIR_NUMBER);
    if (!number) number = await askNumber();

    if (!number) {
      console.log("[PAIR] No PAIR_NUMBER in config.js and no input received. Set PAIR_NUMBER in config.js. Retrying in 15 seconds...");
      setTimeout(() => requestPairing(s), 15000);
      return;
    }

    let code = await s.requestPairingCode(number);
    code = (code.match(/.{1,4}/g) || [code]).join("-");
    console.log("\n==============================");
    console.log(`  PAIRING CODE:  ${code}`);
    console.log("==============================");
    console.log("1. Open WhatsApp on the phone with that number");
    console.log("2. Go to Settings > Linked Devices > Link a Device");
    console.log("3. Tap 'Link with phone number instead'");
    console.log("4. Enter the code above\n");
  } catch (err) {
    console.error("[PAIR] Could not request the pairing code:", err && err.message);
    try { s.end(err); } catch (e) {} // socket closes -> auto reconnect retries
  }
}

/* ============================ CONNECTION ============================ */

function scheduleReconnect(delay) {
  if (reconnecting) return;
  reconnecting = true;
  setTimeout(() => {
    reconnecting = false;
    startBot().catch((e) => {
      console.error("[BOT] Start failed:", e);
      scheduleReconnect(5000);
    });
  }, delay);
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(config.SESSION_DIR);

  const opts = {
    auth: state,
    logger,
    browser: Browsers.ubuntu("Chrome"),
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    shouldIgnoreJid: (j) => j === "status@broadcast" || String(j).endsWith("@newsletter"),
  };
  try {
    const { version } = await fetchLatestBaileysVersion();
    if (version) opts.version = version;
  } catch (e) {
    console.log("[BOT] Could not fetch latest WhatsApp version, using default.");
  }

  const s = makeWASocket(opts);
  sock = s;

  s.ev.on("creds.update", saveCreds);

  // First run: request a pairing code ~3 seconds after the socket is created
  if (!s.authState.creds.registered) {
    setTimeout(() => requestPairing(s), 3000);
  }

  s.ev.on("connection.update", async (update) => {
    if (s !== sock) return;
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      console.log(`[BOT] Connected as ${digits(s.user?.id)}`);
      if (!ownerNotified) {
        ownerNotified = true;
        try {
          const ownerNum = digits(config.OWNER_NUMBER) || digits(s.user?.id);
          await s.sendMessage(`${ownerNum}@s.whatsapp.net`, {
            text: config.section("CONNECTED", [
              `${config.BOT_NAME} is online ✅`,
              `AI REPLY: ${autoReply ? "ON" : "OFF"}`,
              `Type ${config.PREFIX}menu to see commands`,
            ]),
          });
        } catch (e) {
          console.error("[BOT] Could not send the connected message:", e && e.message);
        }
      }
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`[BOT] Connection closed (code ${code}).`);

      if (code === DisconnectReason.loggedOut) {
        console.log("[BOT] Logged out. Deleting the session and pairing again...");
        try { fs.rmSync(config.SESSION_DIR, { recursive: true, force: true }); } catch (e) {}
        scheduleReconnect(2000);
      } else if (code === 515) {
        scheduleReconnect(500); // restart required (normal after pairing)
      } else {
        scheduleReconnect(4000);
      }
    }
  });

  s.ev.on("messages.upsert", async ({ messages, type }) => {
    if (s !== sock || type !== "notify") return;
    for (const msg of messages) {
      try {
        await handleMessage(msg);
      } catch (err) {
        console.error("[MSG] Error while handling a message:", err);
      }
    }
  });
}

/* ============================== START ============================== */

// Never exit: log errors only
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));

// Keep-alive so the process always stays running
setInterval(() => {}, 30000);

if (!config.GROQ_API_KEY) {
  console.log("[BOT] WARNING: GROQ_API_KEY is empty in config.js. The AI will not work until you add your key.");
}

startBot().catch((e) => {
  console.error("[BOT] Start failed:", e);
  scheduleReconnect(5000);
});
