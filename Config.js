"use strict";

/* ------------------------------------------------------------------
 * config.js - ALL settings live here. Edit the "MY DETAILS" block
 * and the SERVICES text. Nothing else needs to change.
 * ------------------------------------------------------------------ */

// ---- Small-caps helper (used by header/section styles) -------------
const SMALL_CAPS = {
  a: "ᴀ", b: "ʙ", c: "ᴄ", d: "ᴅ", e: "ᴇ", f: "ꜰ", g: "ɢ", h: "ʜ", i: "ɪ",
  j: "ᴊ", k: "ᴋ", l: "ʟ", m: "ᴍ", n: "ɴ", o: "ᴏ", p: "ᴘ", q: "ǫ", r: "ʀ",
  s: "ꜱ", t: "ᴛ", u: "ᴜ", v: "ᴠ", w: "ᴡ", x: "x", y: "ʏ", z: "ᴢ",
};

function toSmallCaps(text) {
  return String(text)
    .toLowerCase()
    .split("")
    .map((c) => SMALL_CAPS[c] || c)
    .join("");
}

const config = {
  // ================= MY DETAILS (edit these) =================
  BOT_NAME: "Chatbot Service",
  AI_NAME: "Sara",
  CREATOR_NAME: "Chatbot Service", // used as the business name in the prompt
  CREATOR_INFO: "WhatsApp chatbot and automation services",
  OWNER_NUMBER: "923060492398", // your number: lead alerts arrive here
  PAIR_NUMBER: "923144335854",  // the number the bot runs on (gets linked)
  GROQ_API_KEY: "",             // free key from console.groq.com
  BOT_IMAGE: "https://i.postimg.cc/L4ZqmnLX/images-%289%29.jpg", // direct image link

  // Your services, written in simple Urdu. The AI answers only from this.
  SERVICES:
    "ہم واٹس ایپ چیٹ بوٹ اور واٹس ایپ آٹومیشن کی سروسز دیتے ہیں۔ " +
    "ہماری سروسز: (1) واٹس ایپ چیٹ بوٹ، (2) واٹس ایپ چیٹ بوٹ ورک فلو، (3) واٹس ایپ آٹومیشن، " +
    "(4) آٹو ریپلائی اور عام سوالوں کے جواب، دن رات 24 گھنٹے، " +
    "(5) فیڈ بیک اور ریویو، یعنی گاہک سے ریٹنگ لینا۔ " +
    "ہم یہ سروسز ہر قسم کے کاروبار کو دیتے ہیں، مثلاً: ریئل اسٹیٹ، ای کامرس، B2B سیلز، ٹریول اور ٹورزم، " +
    "آرکیٹیکچر اور انٹیریئر ڈیزائن، فرنیچر، ریسٹورنٹ اور فوڈ بزنس، اسپا اور سیلون، ہیلتھ اور ویلنیس، " +
    "بیوٹی اور کاسمیٹکس، ہیلتھ کیئر، ہسپتال، تعلیمی ادارے، اسکول، ایڈٹیک، آٹوموٹو، ہوم ڈیکور، " +
    "مارکیٹنگ ایجنسی، فنانس اور بینکنگ۔",

  // ================= LEAVE AS THEY ARE =================
  GROQ_URL: "https://fei-ai.vercel.app/api/groq",
  GROQ_MODEL: "openai/gpt-oss-20b",
  REASONING_EFFORT: "low",
  PREFIX: ".",
  MODE: "PUBLIC", // PUBLIC or PRIVATE (owner only)
  VERSION: "1.0.0",
  TIMEZONE: "Asia/Karachi",
  AUTO_REPLY: true, // starting value
  MAX_HISTORY: 12,  // 12 so the bot remembers the answers to its questions
  COOLDOWN_SECONDS: 5,

  // Folder where the WhatsApp login session is stored
  SESS
