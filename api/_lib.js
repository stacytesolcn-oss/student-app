// Shared helpers. Files starting with "_" are not deployed as endpoints by Vercel.
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error("Missing env " + k);
  return v;
};

let _db;
const db = () =>
  (_db ||= createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_KEY"), {
    auth: { persistSession: false },
  }));

const appUrl = () => (process.env.APP_URL || "").replace(/\/$/, "");

// ---------- Telegram ----------
async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env("BOT_TOKEN")}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) console.error("tg", method, j);
  return j;
}

const openButton = (text = "Open my English") => ({
  inline_keyboard: [[{ text, web_app: { url: appUrl() + "/" } }]],
});

// Validates Telegram Mini App initData (HMAC with the bot token).
function verifyInitData(initData) {
  if (!initData) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const check = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(env("BOT_TOKEN")).digest();
  const calc = crypto.createHmac("sha256", secret).update(check).digest("hex");
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  const age = Date.now() / 1000 - Number(p.get("auth_date") || 0);
  if (age > 7 * 86400) return null; // a week-old session is too old
  try { return JSON.parse(p.get("user")); } catch { return null; }
}

const safeEq = (a, b) =>
  typeof a === "string" && typeof b === "string" && a.length === b.length &&
  crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Header "x-auth": "tg <initData>" or "key <secret>"
function parseAuth(req) {
  const h = req.headers["x-auth"] || "";
  const i = h.indexOf(" ");
  return i < 0 ? {} : { kind: h.slice(0, i), value: h.slice(i + 1) };
}

async function studentFromReq(req) {
  const { kind, value } = parseAuth(req);
  if (kind === "key" && /^[a-f0-9]{20,64}$/.test(value)) {
    const { data } = await db().from("students").select("*").eq("access_key", value).eq("active", true).maybeSingle();
    return data;
  }
  if (kind === "tg") {
    const u = verifyInitData(value);
    if (!u) return null;
    const { data } = await db().from("students").select("*").eq("tg_user_id", u.id).eq("active", true).maybeSingle();
    return data;
  }
  return null;
}

function isTeacher(req) {
  const { kind, value } = parseAuth(req);
  if (kind === "key") return safeEq(value, process.env.TEACHER_KEY || "");
  if (kind === "tg") {
    const u = verifyInitData(value);
    return !!u && String(u.id) === String(process.env.TEACHER_TG_ID || "");
  }
  return false;
}

// ---------- homework ----------
const norm = (s) =>
  String(s || "").toLowerCase().replace(/[’‘`]/g, "'").replace(/[.!?,;:"]+/g, " ").replace(/\s+/g, " ").trim();

// Removes everything a student must not see before trying.
function publicTasks(tasks) {
  return (tasks || []).map((t) => ({
    id: t.id, type: t.type, title: t.title, instructions: t.instructions,
    items: (t.items || []).map(({ answers, answer, ...rest }) => rest),
  }));
}

// Returns {correct, solution} — solution only goes back after an attempt.
function checkItem(task, item, response) {
  if (task.type === "gap") {
    const given = Array.isArray(response) ? response : [response];
    // answers: ["go"] for one gap, or [["go"],["at","in"]] for several gaps / alternatives
    const keys = (item.answers || []).map((a) => (Array.isArray(a) ? a : [a]));
    const ok = keys.length > 0 && keys.every((alts, i) => alts.some((a) => norm(a) === norm(given[i])));
    return { correct: ok, solution: keys.map((a) => a[0]) };
  }
  if (task.type === "choice") {
    return { correct: Number(response) === Number(item.answer), solution: item.answer };
  }
  if (task.type === "order") {
    const alts = Array.isArray(item.answer) ? item.answer : [item.answer];
    return { correct: alts.some((a) => norm(a) === norm(response)), solution: alts[0] };
  }
  return { correct: null, solution: null }; // write / voice: open
}

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

// Today's date (YYYY-MM-DD) in a time zone
const dateIn = (tz, d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);

module.exports = { db, tg, openButton, appUrl, studentFromReq, isTeacher, publicTasks, checkItem, send, readBody, dateIn, safeEq };
