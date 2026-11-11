// Student app — Phase 1 server (Supabase Edge Function "app").
// Routes: GET /me · POST /answer · POST /submit · GET /teacher · POST /bot · POST /cron · GET /setup
// Auth header "x-auth": "tg <initData>" (inside Telegram) or "key <access key>" (personal link).
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const BOT_TOKEN = () => Deno.env.get("BOT_TOKEN") || "";

// ---------- config (secrets live in the locked app_config table) ----------
let cfgCache: Record<string, string> | null = null, cfgAt = 0;
async function cfg(): Promise<Record<string, string>> {
  if (cfgCache && Date.now() - cfgAt < 60_000) return cfgCache;
  const { data } = await db.from("app_config").select("key,value");
  cfgCache = Object.fromEntries((data || []).map((r: any) => [r.key, r.value]));
  cfgAt = Date.now();
  return cfgCache!;
}
const appUrl = async () => ((await cfg()).APP_URL || "").replace(/\/$/, "");

// ---------- http ----------
// Auth travels in a header (not cookies), so any origin is safe.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "x-auth, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};
const send = (code: number, obj: unknown) =>
  new Response(JSON.stringify(obj), {
    status: code,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS },
  });

// ---------- crypto ----------
const enc = new TextEncoder();
async function hmac(key: Uint8Array, msg: string) {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
function safeEq(a: string, b: string) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || !a.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Telegram Mini App initData check
async function verifyInitData(initData: string) {
  if (!initData || !BOT_TOKEN()) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const check = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac(enc.encode("WebAppData"), BOT_TOKEN());
  if (!safeEq(hex(await hmac(secret, check)), hash)) return null;
  if (Date.now() / 1000 - Number(p.get("auth_date") || 0) > 7 * 86400) return null;
  try { return JSON.parse(p.get("user") || "null"); } catch { return null; }
}

function parseAuth(req: Request) {
  const h = req.headers.get("x-auth") || "";
  const i = h.indexOf(" ");
  return i < 0 ? { kind: "", value: "" } : { kind: h.slice(0, i), value: h.slice(i + 1) };
}

async function studentFromReq(req: Request) {
  const { kind, value } = parseAuth(req);
  if (kind === "key" && /^[a-f0-9]{20,64}$/.test(value)) {
    const { data } = await db.from("students").select("*").eq("access_key", value).eq("active", true).maybeSingle();
    return data;
  }
  if (kind === "tg") {
    const u = await verifyInitData(value);
    if (!u) return null;
    const { data } = await db.from("students").select("*").eq("tg_user_id", u.id).eq("active", true).maybeSingle();
    return data;
  }
  return null;
}

async function isTeacher(req: Request) {
  const c = await cfg();
  const { kind, value } = parseAuth(req);
  if (kind === "key") return safeEq(value, c.TEACHER_KEY || "");
  if (kind === "tg") {
    const u = await verifyInitData(value);
    return !!u && !!c.TEACHER_TG_ID && String(u.id) === c.TEACHER_TG_ID;
  }
  return false;
}

// ---------- Telegram ----------
async function tg(method: string, body: unknown) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN()}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) console.error("tg", method, JSON.stringify(j));
  return j;
}
const openButton = async (text = "Open my English", page = "/") => ({
  inline_keyboard: [[{ text, web_app: { url: (await appUrl()) + page } }]],
});

// ---------- homework ----------
const norm = (s: unknown) =>
  String(s ?? "").toLowerCase().replace(/[’‘`]/g, "'").replace(/[.!?,;:"]+/g, " ").replace(/\s+/g, " ").trim();

function publicTasks(tasks: any[]) {
  return (tasks || []).map((t) => ({
    id: t.id, type: t.type, title: t.title, instructions: t.instructions,
    items: (t.items || []).map(({ answers: _a, answer: _b, ...rest }: any) => rest),
  }));
}

function checkItem(task: any, item: any, response: any) {
  if (task.type === "gap") {
    const given = Array.isArray(response) ? response : [response];
    const keys = (item.answers || []).map((a: any) => (Array.isArray(a) ? a : [a]));
    const ok = keys.length > 0 && keys.every((alts: any[], i: number) => alts.some((a) => norm(a) === norm(given[i])));
    return { correct: ok, solution: keys.map((a: any[]) => a[0]) };
  }
  if (task.type === "choice") return { correct: Number(response) === Number(item.answer), solution: item.answer };
  if (task.type === "order") {
    const alts = Array.isArray(item.answer) ? item.answer : [item.answer];
    return { correct: alts.some((a: string) => norm(a) === norm(response)), solution: alts[0] };
  }
  return { correct: null, solution: null };
}
function solutionOf(t: any, it: any) {
  if (t.type === "gap") return (it.answers || []).map((x: any) => (Array.isArray(x) ? x[0] : x));
  if (t.type === "choice") return it.answer;
  if (t.type === "order") return Array.isArray(it.answer) ? it.answer[0] : it.answer;
  return null;
}
const dateIn = (tz: string, d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);

// ---------- routes ----------
async function me(req: Request) {
  const s = await studentFromReq(req);
  if (!s) return send(401, { error: "unknown" });
  const { data: hw } = await db.from("homework")
    .select("id,title,intro,due,tasks,started_at,completed_at,created_at")
    .eq("student_id", s.id).eq("published", true).order("created_at", { ascending: false }).limit(10);
  const ids = (hw || []).map((h: any) => h.id);
  let answers: any[] = [];
  if (ids.length) {
    const { data } = await db.from("answers").select("homework_id,task_id,item_id,response,correct,attempt")
      .in("homework_id", ids).order("id", { ascending: true });
    answers = data || [];
  }
  const last: Record<string, any> = {};
  for (const a of answers) last[`${a.homework_id}|${a.task_id}|${a.item_id}`] = a;
  const out = (hw || []).map((h: any) => {
    const saved: Record<string, unknown> = {};
    for (const t of h.tasks || []) for (const it of t.items || []) {
      const a = last[`${h.id}|${t.id}|${it.id}`];
      if (!a) continue;
      saved[`${t.id}|${it.id}`] = { response: a.response, correct: a.correct, attempt: a.attempt,
        solution: a.correct === false && a.attempt >= 2 ? solutionOf(t, it) : null };
    }
    return { id: h.id, title: h.title, intro: h.intro, due: h.due, done: !!h.completed_at,
             completed_at: h.completed_at, tasks: publicTasks(h.tasks), saved };
  });
  return send(200, { name: s.name, focus: s.focus, tz: s.tz, linkedTelegram: !!s.tg_user_id, homework: out });
}

async function answer(req: Request) {
  const s = await studentFromReq(req);
  if (!s) return send(401, { error: "unknown" });
  const { homework_id, task_id, item_id, response } = await req.json();
  if (JSON.stringify(response ?? "").length > 4000) return send(413, { error: "too long" });
  const { data: hw } = await db.from("homework").select("id,tasks,started_at")
    .eq("id", homework_id).eq("student_id", s.id).eq("published", true).maybeSingle();
  if (!hw) return send(404, { error: "homework" });
  const task = (hw.tasks || []).find((t: any) => t.id === task_id);
  const item = task && (task.items || []).find((i: any) => i.id === item_id);
  if (!item) return send(404, { error: "item" });
  const { count } = await db.from("answers").select("id", { count: "exact", head: true })
    .eq("homework_id", hw.id).eq("task_id", task_id).eq("item_id", item_id);
  const attempt = (count || 0) + 1;
  const { correct, solution } = checkItem(task, item, response);
  await db.from("answers").insert({ homework_id: hw.id, student_id: s.id, task_id, item_id, response, correct, attempt });
  if (!hw.started_at) await db.from("homework").update({ started_at: new Date().toISOString() }).eq("id", hw.id);
  // First miss: "try again". The answer appears only after a second miss.
  return send(200, { correct, solution: correct === false && attempt >= 2 ? solution : null, attempt });
}

async function submit(req: Request) {
  const s = await studentFromReq(req);
  if (!s) return send(401, { error: "unknown" });
  const { homework_id } = await req.json();
  const { data: hw } = await db.from("homework").select("id,title,completed_at")
    .eq("id", homework_id).eq("student_id", s.id).eq("published", true).maybeSingle();
  if (!hw) return send(404, { error: "homework" });
  if (!hw.completed_at) {
    await db.from("homework").update({ completed_at: new Date().toISOString() }).eq("id", hw.id);
    const teacher = (await cfg()).TEACHER_TG_ID;
    if (teacher) await tg("sendMessage", { chat_id: teacher, text: `✅ ${s.name} finished "${hw.title}".`,
      reply_markup: await openButton("See answers", "/teacher.html") });
  }
  return send(200, { ok: true });
}

async function teacher(req: Request) {
  if (!(await isTeacher(req))) return send(401, { error: "teacher only" });
  const [{ data: students }, { data: hw }] = await Promise.all([
    db.from("students").select("id,name,tz,access_key,tg_user_id,focus,active").order("name"),
    db.from("homework").select("id,student_id,title,due,tasks,published,started_at,completed_at,created_at")
      .order("created_at", { ascending: false }).limit(100),
  ]);
  const ids = (hw || []).map((h: any) => h.id);
  let answers: any[] = [];
  if (ids.length) {
    const { data } = await db.from("answers").select("homework_id,task_id,item_id,response,correct,attempt,created_at")
      .in("homework_id", ids).order("id");
    answers = data || [];
  }
  const c = await cfg(), base = await appUrl();
  return send(200, {
    students: (students || []).map((s: any) => ({ ...s, link: `${base}/#k=${s.access_key}`,
      telegramLink: c.BOT_USERNAME ? `https://t.me/${c.BOT_USERNAME}?start=${s.access_key}` : null })),
    homework: hw || [], answers,
  });
}

async function bot(req: Request) {
  const c = await cfg();
  if (!safeEq(req.headers.get("x-telegram-bot-api-secret-token") || "", c.WEBHOOK_SECRET || "")) return send(401, {});
  try {
    const m = (await req.json()).message;
    if (!m || !m.text || m.chat.type !== "private") return send(200, { ok: true });
    const text = m.text.trim(), uid = m.from.id;
    const arg = text.split(/\s+/)[1] || "";

    // Stacy links her own account once: t.me/<bot>?start=teacher_<TEACHER_KEY>
    if (text.startsWith("/start") && arg.startsWith("teacher_") && safeEq(arg.slice(8), c.TEACHER_KEY || "")) {
      await db.from("app_config").upsert({ key: "TEACHER_TG_ID", value: String(uid) });
      cfgCache = null;
      await tg("sendMessage", { chat_id: m.chat.id, text: "Done — you're set as the teacher. You'll get a message whenever a student finishes homework.",
        reply_markup: await openButton("Open teacher view", "/teacher.html") });
      return send(200, { ok: true });
    }
    const isT = c.TEACHER_TG_ID && String(uid) === c.TEACHER_TG_ID;
    if (text.startsWith("/start") && isT && !arg) {
      await tg("sendMessage", { chat_id: m.chat.id, text: "Teacher view:", reply_markup: await openButton("Open teacher view", "/teacher.html") });
      return send(200, { ok: true });
    }
    if (text.startsWith("/start") && /^[a-f0-9]{20,64}$/.test(arg)) {
      const { data: s } = await db.from("students").select("id,name").eq("access_key", arg).maybeSingle();
      if (s) {
        await db.from("students").update({ tg_user_id: null, tg_chat_id: null }).eq("tg_user_id", uid).neq("id", s.id);
        await db.from("students").update({ tg_user_id: uid, tg_chat_id: m.chat.id }).eq("id", s.id);
        await tg("sendMessage", { chat_id: m.chat.id,
          text: `Hi ${s.name}! 👋 Your English page is here. I'll also remind you about homework.`,
          reply_markup: await openButton() });
        return send(200, { ok: true });
      }
    }
    const { data: known } = await db.from("students").select("name").eq("tg_user_id", uid).maybeSingle();
    if (text.startsWith("/start")) {
      await tg("sendMessage", known
        ? { chat_id: m.chat.id, text: `Hi ${known.name}!`, reply_markup: await openButton() }
        : { chat_id: m.chat.id, text: "Hi! Please use the personal link from your teacher to get started." });
    } else if (known) {
      await tg("sendMessage", { chat_id: m.chat.id, text: "I'm just a helper bot — please message Stacy directly 🙂",
        reply_markup: await openButton() });
    }
  } catch (e) { console.error(e); }
  return send(200, { ok: true }); // never make Telegram retry forever
}

async function cron(req: Request) {
  const c = await cfg();
  if (!safeEq(req.headers.get("x-cron") || "", c.CRON_SECRET || "")) return send(401, {});
  const { data: rows } = await db.from("homework")
    .select("id,title,due,reminded_on,student:students(id,name,tz,tg_chat_id,active)")
    .eq("published", true).is("completed_at", null).not("due", "is", null);
  let sent = 0;
  for (const h of (rows || []) as any[]) {
    const s = h.student;
    if (!s || !s.active || !s.tg_chat_id) continue;
    const today = dateIn(s.tz), tomorrow = dateIn(s.tz, new Date(Date.now() + 864e5));
    if (h.reminded_on === today || (h.due !== today && h.due !== tomorrow)) continue;
    const r = await tg("sendMessage", { chat_id: s.tg_chat_id,
      text: `Hi ${s.name}! Friendly reminder: your homework "${h.title}" is for ${h.due === today ? "today" : "tomorrow"}. It takes just a few minutes 🙂`,
      reply_markup: await openButton("Do my homework") });
    if (r.ok) { sent++; await db.from("homework").update({ reminded_on: today }).eq("id", h.id); }
  }
  return send(200, { ok: true, sent });
}

async function setup(req: Request) {
  const c = await cfg();
  const k = new URL(req.url).searchParams.get("k") || "";
  if (!safeEq(k, c.TEACHER_KEY || "")) return send(401, { error: "teacher only" });
  if (!BOT_TOKEN()) return send(400, { error: "BOT_TOKEN secret is not set yet" });
  const fn = `${Deno.env.get("SUPABASE_URL")}/functions/v1/app/bot`;
  const base = await appUrl();
  const hook = await tg("setWebhook", { url: fn, secret_token: c.WEBHOOK_SECRET, allowed_updates: ["message"], drop_pending_updates: true });
  const menu = await tg("setChatMenuButton", { menu_button: { type: "web_app", text: "My English", web_app: { url: base + "/" } } });
  const cmds = await tg("setMyCommands", { commands: [{ command: "start", description: "Open my English" }] });
  const me = await tg("getMe", {});
  return send(200, { webhook: hook.ok, menu: menu.ok, commands: cmds.ok, bot: me.result?.username, app: base });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const path = new URL(req.url).pathname.replace(/^.*\/app/, "") || "/";
  try {
    if (path === "/me" && req.method === "GET") return await me(req);
    if (path === "/answer" && req.method === "POST") return await answer(req);
    if (path === "/submit" && req.method === "POST") return await submit(req);
    if (path === "/teacher" && req.method === "GET") return await teacher(req);
    if (path === "/bot" && req.method === "POST") return await bot(req);
    if (path === "/cron" && req.method === "POST") return await cron(req);
    if (path === "/setup" && req.method === "GET") return await setup(req);
    return send(404, { error: "not found" });
  } catch (e) {
    console.error(e);
    return send(500, { error: "server" });
  }
});
