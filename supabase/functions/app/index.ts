// Student app server (Supabase Edge Function "app").
// Routes: /me /answer /submit /state /paid /teacher /test-reminders /bot /cron /setup
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
  const fresh = Object.fromEntries((data || []).map((r: any) => [r.key, r.value]));
  if (Object.keys(fresh).length) { cfgCache = fresh; cfgAt = Date.now(); }
  return fresh;
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

// Teacher's own chat: menu button = teacher view; /teacher = teacher view + each student's page (preview)
async function teacherKeyboard() {
  const base = await appUrl();
  return { inline_keyboard: [[{ text: "👩‍🏫 Teacher view", web_app: { url: base + "/teacher.html" } }]] };
}
async function teacherMenu(chatId: number | string) {
  await tg("setChatMenuButton", { chat_id: chatId, menu_button: { type: "web_app", text: "Teacher view", web_app: { url: (await appUrl()) + "/teacher.html" } } });
  await tg("setMyCommands", { commands: [{ command: "teacher", description: "Teacher view" }], scope: { type: "chat", chat_id: chatId } });
}

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
  return send(200, { name: s.name, focus: s.focus, tz: s.tz, page: s.page || null, linkedTelegram: !!s.tg_user_id, homework: out });
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
    db.from("students").select("id,name,tz,access_key,tg_user_id,focus,active,profile,page,pay_check_at").order("name"),
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
  const { data: states } = await db.from("student_state").select("student_id,key,data,updated_at");
  const summary: Record<string, unknown> = {};
  for (const s of (students || []) as any[]) {
    const st: Record<string, any> = {}, upd: Record<string, string> = {};
    for (const r of (states || []) as any[]) if (r.student_id === s.id) { st[r.key] = r.data; upd[r.key] = r.updated_at; }
    summary[s.id] = { cards: cardSummary(s, st), diary: diarySummary(s, st), updated: upd };
  }
  return send(200, {
    summary,
    students: (students || []).map((s: any) => ({ ...s, link: `${base}/${s.page || ""}#k=${s.access_key}`,
      telegramLink: c.BOT_USERNAME ? `https://t.me/${c.BOT_USERNAME}?start=${s.access_key}` : null })),
    homework: hw || [], answers,
  });
}

async function bot(req: Request) {
  const c = await cfg();
  if (!safeEq(req.headers.get("x-telegram-bot-api-secret-token") || "", c.WEBHOOK_SECRET || "")) return send(401, {});
  try {
    const upd = await req.json();
    const cq = upd.callback_query;
    if (cq && cq.data === "paid") {
      const { data: st } = await db.from("students").select("*").eq("tg_user_id", cq.from.id).maybeSingle();
      if (st) await markPaid(st);
      await tg("answerCallbackQuery", { callback_query_id: cq.id, text: st ? "Thank you! Stacy will check it 🙂" : "" });
      if (st && cq.message) await tg("editMessageReplyMarkup", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } });
      if (st && cq.message) await tg("sendMessage", { chat_id: cq.message.chat.id, text: "Thank you! 💛 Stacy will check the payment." });
      return send(200, { ok: true });
    }
    const m = upd.message;
    if (!m || !m.text || m.chat.type !== "private") return send(200, { ok: true });
    const text = m.text.trim(), uid = m.from.id;
    const arg = text.split(/\s+/)[1] || "";

    // Stacy links her own account once: t.me/<bot>?start=teacher_<TEACHER_KEY>
    if (text.startsWith("/start") && arg.startsWith("teacher_") && safeEq(arg.slice(8), c.TEACHER_KEY || "")) {
      await db.from("app_config").upsert({ key: "TEACHER_TG_ID", value: String(uid) });
      cfgCache = null;
      await tg("sendMessage", { chat_id: m.chat.id, text: "Done — you're set as the teacher. Your menu button opens the teacher view.",
        reply_markup: await teacherKeyboard() });
      await teacherMenu(m.chat.id);
      return send(200, { ok: true });
    }
    const isT = c.TEACHER_TG_ID && String(uid) === c.TEACHER_TG_ID;
    if (isT && ((text.startsWith("/start") && !arg) || text.startsWith("/teacher"))) {
      await tg("sendMessage", { chat_id: m.chat.id, text: "Teacher tools:", reply_markup: await teacherKeyboard() });
      await teacherMenu(m.chat.id);
      return send(200, { ok: true });
    }
    if (text.startsWith("/start") && /^[a-f0-9]{20,64}$/.test(arg)) {
      const { data: s } = await db.from("students").select("id,name,profile").eq("access_key", arg).maybeSingle();
      if (s) {
        await db.from("students").update({ tg_user_id: null, tg_chat_id: null }).eq("tg_user_id", uid).neq("id", s.id);
        await db.from("students").update({ tg_user_id: uid, tg_chat_id: m.chat.id }).eq("id", s.id);
        // personal welcome (profile.welcome) or the default
        const welcome = s.profile?.welcome ||
          `Hi ${s.name}! 👋 This is your English page: cards, diary and homework. I'll send you friendly reminders about your cards, diary, lessons and payments.`;
        await tg("sendMessage", { chat_id: m.chat.id, text: welcome, reply_markup: await openButton() });
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

// ---------- time helpers (student's own time zone) ----------
const DAY = 864e5;
function tzParts(tz: string, d = new Date()) {
  const p: Record<string, string> = {};
  new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "long" }).formatToParts(d).forEach((x) => (p[x.type] = x.value));
  const date = `${p.year}-${p.month}-${p.day}`;
  const offMs = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - Math.floor(d.getTime() / 6e4) * 6e4;
  return { date, minutes: (+p.hour % 24) * 60 + +p.minute, weekday: p.weekday, dayNum: Math.floor((d.getTime() + offMs) / DAY) };
}
const tzOf = (s: any) => s.profile?.tzName || s.tz || "Europe/Moscow";
const prettyDate = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY);

// ---------- packages: lesson dates and automatic next payment ----------
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// Lesson dates from a start date, following the weekly schedule; skips cancelled dates, includes extra ones.
function lessonDates(P: any, start: string, count: number) {
  const out: string[] = [];
  if (!start) return out;
  const skip = new Set([...(P.pack?.skip || []), ...(P.cancel || [])]);
  const add = new Set(P.pack?.add || []);
  const days = new Set((P.lessons || []).map((l: any) => l.day));
  let t = Date.parse(start + "T12:00:00Z");
  for (let i = 0; i < 400 && out.length < count; i++, t += DAY) {
    const d = new Date(t), iso = d.toISOString().slice(0, 10);
    if ((days.has(WEEKDAYS[d.getUTCDay()]) && !skip.has(iso)) || add.has(iso)) out.push(iso);
  }
  return out;
}
// Unpaid package → due at its first lesson. Paid package → due at the first lesson after it ends.
function autoNextPayment(P: any): string | null {
  const K = P.pack;
  if (!K?.start) return P.nextPayment || null;
  const size = Number(K.size) || 8;
  if (!K.paid) return lessonDates(P, K.start, 1)[0] || K.start;
  return lessonDates(P, K.start, size + 1)[size] || null;
}
function withAutoPayment(P: any) {
  if (!P.nextPaymentManual) P.nextPayment = autoNextPayment(P);
  return P;
}
// A new package starts at the first lesson after the previous one (or today if there's no schedule).
function startNewPack(P: any, today: string, size?: number) {
  const old = P.pack || { size: 8 };
  const n = Number(size) || Number(old.size) || 8;
  const after = old.start ? lessonDates(P, old.start, (Number(old.size) || 8) + 1)[Number(old.size) || 8] : null;
  P.prevPacks = [...(P.prevPacks || []), old].slice(-6);
  P.pack = { size: n, start: after || today, paid: today, skip: [], add: [] };
}

// ---------- progress summaries ----------
function cardCounts(s: any, st: Record<string, any>) {
  const store = st.cards || { s: {}, log: {} }, meta = st.cards_meta || {};
  const words: string[] = meta.words || Object.keys(store.s || {});
  const today = tzParts(tzOf(s)).dayNum;
  const prog = store.s || {};
  const due = words.filter((w) => prog[w] && prog[w].due <= today).length;
  const fresh = words.filter((w) => !prog[w]).length;
  const done = (store.log || {})[today] || 0;
  const cap = meta.cap || 12;
  const todayCount = Math.max(0, Math.min(cap - done, due + fresh));
  return { words, prog, due, fresh, done, todayCount, today, topics: meta.topics || [] };
}
function cardSummary(s: any, st: Record<string, any>) {
  const c = cardCounts(s, st);
  const learned = c.words.filter((w) => c.prog[w] && c.prog[w].n > 0).length;
  const struggling = c.words.filter((w) => c.prog[w] && c.prog[w].n >= 2 && (c.prog[w].i || 0) <= 1);
  const days = Object.keys((st.cards || {}).log || {}).map(Number).filter((d) => (st.cards.log[d] || 0) > 0);
  const last = days.length ? Math.max(...days) : null;
  // this week (Mon–today) from the Progress ticks: activity → number of days
  const act = (st.cards || {}).act || {}, wd = (new Date(c.today * DAY).getUTCDay() + 6) % 7, mon = c.today - wd;
  const week: Record<string, number> = {};
  let activeDays = 0;
  for (let d = mon; d <= c.today; d++) {
    const l: string[] = act[d] || [];
    if (l.length) activeDays++;
    for (const k of l) week[k] = (week[k] || 0) + 1;
  }
  return { total: c.words.length, learned, dueToday: c.todayCount, doneToday: c.done, struggling, week, activeDays,
           lastPractice: last === null ? null : new Date(last * DAY).toISOString().slice(0, 10) };
}
function diarySummary(s: any, st: Record<string, any>) {
  const e = (st.diary || {}).e || {};
  const days = Object.keys(e).filter((k) => String(e[k] || "").trim()).map(Number).sort((a, b) => b - a);
  const today = tzParts(tzOf(s)).dayNum;
  return { entries: days.length, wroteToday: !!String(e[today] || "").trim(),
           last: days.length ? { date: new Date(days[0] * DAY).toISOString().slice(0, 10), text: String(e[days[0]]).slice(0, 400) } : null };
}
async function loadState(studentId: string) {
  const { data } = await db.from("student_state").select("key,data").eq("student_id", studentId);
  return Object.fromEntries((data || []).map((r: any) => [r.key, r.data])) as Record<string, any>;
}

// ---------- reminder messages (English, friendly, short) ----------
type Msg = { kind: string; key: string; text: string; reply_markup?: unknown } | null;
const pageButton = async (s: any, text: string, query = "") => ({ inline_keyboard: [[{ text, web_app: { url: (await appUrl()) + "/" + (s.page || "") + query } }]] });

// One practice reminder a day, ONE topic per message (Stacy, Nov 11). Priority:
// homework (on its mid-week day: 1 day after a lesson, 2 if the gap to the next lesson is 4+ days, not when the
// next lesson is tomorrow — the 18:00 "lesson tomorrow" message carries homework then; only if pending)
// > pronunciation (profile.pronDays, if not done today) > cards (+ diary for diary students). Nothing open → nothing.
// Sent at the student's usual practice time (see practiceTime), default 19:00.
async function practice(s: any, st: Record<string, any>, force = false, only?: string): Promise<Msg> {
  const c = cardCounts(s, st), d = diarySummary(s, st), now = tzParts(tzOf(s)), P = s.profile || {};
  const act: string[] = ((st.cards || {}).act || {})[c.today] || [];
  const h = await homeworkPending(s, st);
  const hwDay = h.back > 0 && h.fwd > 1 && h.back === (h.back + h.fwd >= 4 ? 2 : 1);
  const hw = force ? h.has : h.pending && hwDay;
  const pron = !!P.pronReminder && (force || ((P.pronDays || ["Sunday"]).includes(now.weekday) && !act.includes("pron")));
  const cards = force ? c.todayCount > 0 : c.done === 0 && c.todayCount > 0;
  const diary = !P.noDiary && (force || !d.wroteToday);
  const topic = only || (hw ? "hw" : pron ? "pron" : (cards || diary) ? "cards" : "");
  const key = now.date;
  if (topic === "hw" && hw) return { kind: "practice", key, reply_markup: await pageButton(s, "Open my English"),
    text: `Hi ${s.name}! 📚 Quick check-in: have you had a chance to do your homework? It's all on your page 🙂` };
  if (topic === "pron" && pron) return { kind: "practice", key, reply_markup: await pageButton(s, "Practise pronunciation", "?open=pron"),
    text: `Hi ${s.name}! 🎬 How about a little pronunciation practice today? Pick a video, listen and repeat — a nice way to refresh what we did.` };
  if (topic === "cards") {
    if (cards && diary) return { kind: "practice", key, reply_markup: await pageButton(s, "Open my English"),
      text: `Hi ${s.name}! 🌙 Two small things: ${c.todayCount} cards are waiting, and your diary — how was your day? A couple of sentences is perfect ✍️` };
    if (cards) return { kind: "practice", key, reply_markup: await pageButton(s, "Practise my cards"),
      text: `Hi ${s.name}! 🃏 ${c.todayCount} cards are waiting for you today. Just a few minutes is enough 🙂` };
    if (diary) return { kind: "practice", key, reply_markup: await pageButton(s, "Open my diary"),
      text: `Hi ${s.name}! ✍️ How was your day? Write a couple of sentences in your diary.` };
  }
  return null;
}
// Usual practice time = median of the first-practice times of the last 14 recorded days (needs 5+),
// minus 30 min, kept between 08:00 and 21:00, on a 15-min step. Default 19:00.
function practiceTime(st: Record<string, any>) {
  const t = st.practice_times || {};
  const mins = Object.keys(t).map(Number).sort((a, b) => b - a).slice(0, 14).map((k) => Number(t[k])).filter((x) => x >= 0).sort((a, b) => a - b);
  if (mins.length < 5) return { at: 19 * 60, learned: false, days: mins.length };
  const med = mins[Math.floor(mins.length / 2)];
  const at = Math.min(21 * 60, Math.max(8 * 60, Math.floor((med - 30) / 15) * 15));
  return { at, learned: true, days: mins.length };
}
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
function nextLessonToday(s: any) {
  const tz = tzOf(s), now = tzParts(tz), P = s.profile || {};
  const skip = new Set([...(P.pack?.skip || []), ...(P.cancel || [])]);
  if (skip.has(now.date)) return null;
  let best: any = null;
  for (const l of P.lessons || []) {
    if (l.day !== now.weekday) continue;
    if ((l.from && now.date < l.from) || (l.until && now.date > l.until)) continue;
    const [hh, mm] = String(l.time).split(":").map(Number);
    const start = hh * 60 + (mm || 0), until = start - now.minutes;
    if (until > 0 && (!best || until < best.until)) best = { time: l.time, until };
  }
  return best ? { ...best, date: now.date } : null;
}
async function lessonSoon(s: any, force = false): Promise<Msg> {
  const n = nextLessonToday(s);
  if (!n && !force) return null;
  const P = s.profile || {}, time = n?.time || (P.lessons?.[0]?.time ?? "");
  const buttons = P.zoom ? { inline_keyboard: [[{ text: "Join Zoom", url: P.zoom }]] } : undefined;
  return { kind: "lesson", key: `${n?.date}:${time}`,
    text: `Hi ${s.name}! 👋 Your English lesson starts in 1 hour, at ${time} (Moscow time). See you soon!`, reply_markup: buttons };
}
function lessonsOn(s: any, when: Date) {
  const P = s.profile || {}, t = tzParts(tzOf(s), when);
  const skip = new Set([...(P.pack?.skip || []), ...(P.cancel || [])]);
  if (skip.has(t.date)) return [];
  return (P.lessons || []).filter((l: any) => l.day === t.weekday && !(l.from && t.date < l.from) && !(l.until && t.date > l.until))
    .map((l: any) => ({ ...l, date: t.date, weekday: t.weekday }));
}
async function lessonTomorrow(s: any, force = false, st?: Record<string, any>): Promise<Msg> {
  let ls = lessonsOn(s, new Date(Date.now() + DAY));
  if (!ls.length && force) ls = (s.profile?.lessons || []).slice(0, 1).map((l: any) => ({ ...l, date: "test", weekday: l.day }));
  if (!ls.length) return null;
  const l = ls.sort((a: any, b: any) => String(a.time).localeCompare(String(b.time)))[0];
  const h = st ? await homeworkPending(s, st) : null;
  const hw = h && (h.pending || (force && h.has)) ? " And if you haven't done your homework yet, there's still time today 📚" : "";
  return { kind: "lesson-eve", key: `${l.date}:${l.time}`,
    text: `Hi ${s.name}! 📅 Just a reminder: your English lesson is tomorrow (${l.weekday}) at ${l.time}, Moscow time. See you there!` + hw,
    reply_markup: hw ? await pageButton(s, "Open my English") : undefined };
}
async function paymentDue(s: any, force = false): Promise<Msg> {
  const P = s.profile || {}, due = P.nextPayment;
  if (!due) return null;
  const today = tzParts(tzOf(s)).date, d = daysBetween(today, due);
  if (P.paidClaimed && daysBetween(P.paidClaimed, due) <= 0) return null; // already paid on/after this due date
  // 2 days before, on the day, and — while overdue — on each lesson day
  const overdueLessonDay = d < 0 && lessonsOn(s, new Date()).length > 0;
  if (!force && d !== 2 && d !== 0 && !overdueLessonDay) return null;
  const text = d === 0
    ? `Hi ${s.name}! 💳 Friendly reminder: your lesson payment is due today.`
    : d < 0
    ? `Hi ${s.name}! 💳 Friendly reminder: your lesson payment (due ${prettyDate(due)}) is still open.`
    : `Hi ${s.name}! 💳 Friendly reminder: your next lesson payment is due on ${prettyDate(due)}.`;
  const row: any[] = [];
  if (P.stripe) row.push({ text: "Pay", url: P.stripe });
  row.push({ text: "I've paid ✓", callback_data: "paid" });
  return { kind: "pay", key: `${due}:${d}`, text, reply_markup: { inline_keyboard: [row] } };
}
async function homeworkDue(s: any): Promise<Msg[]> {
  const { data } = await db.from("homework").select("id,title,due").eq("student_id", s.id).eq("published", true).is("completed_at", null).not("due", "is", null);
  const today = tzParts(tzOf(s)).date, tomorrow = tzParts(tzOf(s), new Date(Date.now() + DAY)).date;
  const out: Msg[] = [];
  for (const h of (data || []) as any[]) {
    if (h.due !== today && h.due !== tomorrow) continue;
    out.push({ kind: "hw", key: `${h.id}:${today}`, reply_markup: await openButton("Do my homework"),
      text: `Hi ${s.name}! Friendly reminder: your homework “${h.title}” is for ${h.due === today ? "today" : "tomorrow"}. It takes just a few minutes 🙂` });
  }
  return out;
}

// Homework (profile.homework or open app homework) not ticked "homework" since the last lesson.
async function homeworkPending(s: any, st: Record<string, any>) {
  const P = s.profile || {};
  const hasHw = (P.homework || []).length > 0;
  const { data: open } = await db.from("homework").select("id").eq("student_id", s.id).eq("published", true).is("completed_at", null).limit(1);
  const has = hasHw || !!(open && open.length);
  const now = tzParts(tzOf(s));
  let back = -1, fwd = -1;
  for (let k = 0; k <= 7; k++) if (lessonsOn(s, new Date(Date.now() - k * DAY)).length) { back = k; break; }
  for (let k = 1; k <= 7; k++) if (lessonsOn(s, new Date(Date.now() + k * DAY)).length) { fwd = k; break; }
  let done = false;
  const act = (st.cards || {}).act || {};
  if (back >= 0) for (let d = now.dayNum - back; d <= now.dayNum; d++) if ((act[d] || []).includes("homework")) done = true;
  return { has, pending: has && !done, back, fwd, date: now.date };
}
async function sendOnce(s: any, m: Msg) {
  if (!m) return false;
  const { error } = await db.from("reminder_log").insert({ student_id: s.id, kind: m.kind, key: m.key });
  if (error) return false; // already sent
  const r = await tg("sendMessage", { chat_id: s.tg_chat_id, text: m.text, reply_markup: m.reply_markup });
  if (!r.ok) await db.from("reminder_log").delete().eq("student_id", s.id).eq("kind", m.kind).eq("key", m.key);
  return !!r.ok;
}
const inWindow = (minutes: number, target: number) => minutes >= target && minutes < target + 15;

async function cron(req: Request) {
  const c = await cfg();
  if (!safeEq(req.headers.get("x-cron") || "", c.CRON_SECRET || "")) return send(401, {});
  const { data: students } = await db.from("students").select("*").eq("active", true).not("tg_chat_id", "is", null);
  let sent = 0;
  for (const s of (students || []) as any[]) {
    if ((s.profile || {}).remindersOff) continue;
    const t = tzParts(tzOf(s));
    const st = await loadState(s.id);
    if (inWindow(t.minutes, practiceTime(st).at)) sent += +(await sendOnce(s, await practice(s, st)));
    if (inWindow(t.minutes, 10 * 60)) sent += +(await sendOnce(s, await paymentDue(s)));
    if (inWindow(t.minutes, 17 * 60)) for (const m of await homeworkDue(s)) sent += +(await sendOnce(s, m));
    if (inWindow(t.minutes, 18 * 60)) sent += +(await sendOnce(s, await lessonTomorrow(s, false, st)));
    const n = nextLessonToday(s);
    if (n && n.until > 45 && n.until <= 60) sent += +(await sendOnce(s, await lessonSoon(s)));
  }
  return send(200, { ok: true, sent });
}

// Teacher: send every reminder type for a student to Stacy's own Telegram, right now.
async function testReminders(req: Request) {
  if (!(await isTeacher(req))) return send(401, { error: "teacher only" });
  const c = await cfg();
  const id = new URL(req.url).searchParams.get("student");
  const q = db.from("students").select("*").eq("active", true);
  const { data: s } = await (id ? q.eq("id", id) : q.order("created_at")).limit(1).maybeSingle();
  if (!s || !c.TEACHER_TG_ID) return send(400, { error: "no student or teacher not linked" });
  const st = await loadState(s.id);
  // the welcome she gets after tapping Start; the button opens a read-only preview of her page
  const welcome = s.profile?.welcome ||
    `Hi ${s.name}! 👋 This is your English page: cards, diary and homework. I'll send you friendly reminders about your cards, diary, lessons and payments.`;
  const prevUrl = `${await appUrl()}/${s.page || ""}?preview=1&k=${s.access_key}`;
  const msgs: Msg[] = [{ kind: "welcome", key: "test", text: welcome, reply_markup: { inline_keyboard: [[{ text: "Open my English", web_app: { url: prevUrl } }]] } },
    await practice(s, st, true, "cards"), await practice(s, st, true, "hw"), await practice(s, st, true, "pron"), await lessonTomorrow(s, true, st), await lessonSoon(s, true), await paymentDue(s, true), ...(await homeworkDue(s))];
  const pt = practiceTime(st);
  const labels: string[] = [];
  for (const m of msgs) {
    if (!m) continue;
    await tg("sendMessage", { chat_id: c.TEACHER_TG_ID, text: `🧪 TEST (${m.kind}) — what ${s.name} would get` + (m.kind === "practice" ? ` (daily at ${hhmm(pt.at)}, ${pt.learned ? `learned from ${pt.days} days` : `default until 5 days of practice — ${pt.days} so far`})` : "") + `:\n\n${m.text}`, reply_markup: m.reply_markup });
    labels.push(m.kind);
  }
  return send(200, { sent: labels });
}

// ---------- package / payment ----------
async function markPaid(s: any) {
  const P = { ...(s.profile || {}) }, today = tzParts(tzOf(s)).date;
  if (P.paidClaimed === today) return P; // double tap
  if (P.pack && !P.pack.paid) P.pack = { ...P.pack, paid: today }; // paying for the package she's in
  else startNewPack(P, today);                                     // next package
  P.paidClaimed = today;
  P.nextPaymentManual = false;
  withAutoPayment(P);
  await db.from("students").update({ profile: P, pay_check_at: new Date().toISOString() }).eq("id", s.id);
  const t = (await cfg()).TEACHER_TG_ID;
  if (t) await tg("sendMessage", { chat_id: t, text: `💳 ${s.name} tapped "I've paid" — please check the payment.`,
    reply_markup: await openButton("Open teacher view", "/teacher.html") });
  return P;
}
async function paid(req: Request) {
  const s = await studentFromReq(req);
  if (!s) return send(401, { error: "unknown" });
  return send(200, { ok: true, profile: await markPaid(s) });
}

// ---------- saved progress (cards, diary) ----------
const STATE_KEYS = new Set(["cards", "diary", "cards_meta"]);
async function stateGet(req: Request) {
  const s = await studentFromReq(req);
  if (!s) return send(401, { error: "unknown" });
  return send(200, { name: s.name, profile: s.profile || {}, state: await loadState(s.id) });
}
async function statePost(req: Request) {
  const s = await studentFromReq(req);
  if (!s) return send(401, { error: "unknown" });
  const raw = await req.text();
  if (raw.length > 400_000) return send(413, { error: "too big" });
  const { key, data } = JSON.parse(raw);
  if (!STATE_KEYS.has(key) || typeof data !== "object" || data === null) return send(400, { error: "key" });
  await db.from("student_state").upsert({ student_id: s.id, key, data, updated_at: new Date().toISOString() });
  if (key === "cards" || key === "diary") await notePracticeTime(s, key, data);
  return send(200, { ok: true });
}

// First practice of the day (cards done, any Progress tick, or a diary entry) → its local time, for practiceTime().
async function notePracticeTime(s: any, key: string, data: any) {
  const now = tzParts(tzOf(s)), day = now.dayNum;
  const did = key === "cards"
    ? ((data.log || {})[day] || 0) > 0 || ((data.act || {})[day] || []).length > 0
    : !!String(((data.e || {})[day]) || "").trim();
  if (!did) return;
  const { data: row } = await db.from("student_state").select("data").eq("student_id", s.id).eq("key", "practice_times").maybeSingle();
  const t: Record<string, number> = { ...((row && row.data) || {}) };
  if (t[day] !== undefined) return;
  t[day] = now.minutes;
  for (const k of Object.keys(t)) if (Number(k) < day - 30) delete t[k];
  await db.from("student_state").upsert({ student_id: s.id, key: "practice_times", data: t, updated_at: new Date().toISOString() });
}

// ---------- teacher edits ----------
async function teacherEdit(req: Request) {
  if (!(await isTeacher(req))) return send(401, { error: "teacher only" });
  const { student_id, action, patch } = await req.json();
  const { data: s } = await db.from("students").select("id,profile").eq("id", student_id).maybeSingle();
  if (!s) return send(404, { error: "student" });
  if (action === "confirm-paid") await db.from("students").update({ pay_check_at: null }).eq("id", s.id);
  if (action === "mark-paid") {
    // One "Payment received" button for Stacy:
    // - she tapped "I've paid" already → that already updated her package; just confirm
    // - current package unpaid → it's now paid
    // - current package already paid → this payment starts a new package today
    const { data: full } = await db.from("students").select("id,profile,pay_check_at,tz").eq("id", s.id).maybeSingle();
    const P = { ...((full || s).profile || {}) }, today = tzParts(tzOf(full || s)).date;
    const lessons = Number(patch?.lessons) || 0;
    if (!full?.pay_check_at) {
      if (P.pack && !P.pack.paid) P.pack = { ...P.pack, paid: today, ...(lessons ? { size: lessons } : {}) };
      else startNewPack(P, today, lessons);
      P.paidClaimed = today;
    } else if (lessons && P.pack) P.pack = { ...P.pack, size: lessons };
    P.nextPaymentManual = false;
    withAutoPayment(P);
    await db.from("students").update({ profile: P, pay_check_at: null }).eq("id", s.id);
  }
  if (action === "profile" && patch && typeof patch === "object") {
    const allowed = ["nextPayment", "price", "stripe", "package", "note", "remindersOff", "welcome"];
    const P = { ...(s.profile || {}) };
    for (const k of allowed) if (k in patch) P[k] = patch[k];
    if ("nextPayment" in patch) P.nextPaymentManual = !!patch.nextPayment;
    if (patch.autoPayment) P.nextPaymentManual = false;
    if (patch.packSize) P.pack = { ...(P.pack || {}), size: Number(patch.packSize) };
    if (patch.packStart) P.pack = { ...(P.pack || {}), start: patch.packStart };
    withAutoPayment(P);
    await db.from("students").update({ profile: P }).eq("id", s.id);
  }
  return send(200, { ok: true });
}

// Texts can be overridden in app_config (BOT_DESCRIPTION / BOT_SHORT) without redeploying.
const BOT_DESCRIPTION = `Твой помощник по английскому от Stacy 🐈

Здесь хранится всё для наших уроков: карточки со словами, дневник, домашка и твой прогресс. Пространство, где легко практиковаться каждый день и видеть, как растёт твой английский.

Для учеников Stacy. Чтобы начать, открой свою личную ссылку.`;
const BOT_SHORT = "Твой помощник по английскому от Stacy: карточки, дневник, домашка и прогресс в одном месте.";

async function setup(req: Request) {
  const c = await cfg();
  const k = new URL(req.url).searchParams.get("k") || "";
  if (!safeEq(k, c.TEACHER_KEY || "")) return send(401, { error: "teacher only" });
  if (!BOT_TOKEN()) return send(400, { error: "BOT_TOKEN secret is not set yet" });
  const fn = `${Deno.env.get("SUPABASE_URL")}/functions/v1/app/bot`;
  const base = await appUrl();
  const hook = await tg("setWebhook", { url: fn, secret_token: c.WEBHOOK_SECRET, allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
  const menu = await tg("setChatMenuButton", { menu_button: { type: "web_app", text: "My English", web_app: { url: base + "/" } } });
  const cmds = await tg("setMyCommands", { commands: [{ command: "start", description: "Open my English" }] });
  if (c.TEACHER_TG_ID) await teacherMenu(c.TEACHER_TG_ID);
  // what people see in an empty chat before Start, and in the bot's profile
  const desc = await tg("setMyDescription", { description: c.BOT_DESCRIPTION || BOT_DESCRIPTION });
  const short = await tg("setMyShortDescription", { short_description: c.BOT_SHORT || BOT_SHORT });
  const me = await tg("getMe", {});
  return send(200, { webhook: hook.ok, menu: menu.ok, commands: cmds.ok, description: desc.ok, short: short.ok, bot: me.result?.username, app: base });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const path = new URL(req.url).pathname.replace(/^.*\/app/, "") || "/";
  try {
    if (path === "/me" && req.method === "GET") return await me(req);
    if (path === "/answer" && req.method === "POST") return await answer(req);
    if (path === "/submit" && req.method === "POST") return await submit(req);
    if (path === "/state" && req.method === "GET") return await stateGet(req);
    if (path === "/state" && req.method === "POST") return await statePost(req);
    if (path === "/paid" && req.method === "POST") return await paid(req);
    if (path === "/teacher" && req.method === "GET") return await teacher(req);
    if (path === "/teacher" && req.method === "POST") return await teacherEdit(req);
    if (path === "/test-reminders" && req.method === "GET") return await testReminders(req);
    if (path === "/bot" && req.method === "POST") return await bot(req);
    if (path === "/cron" && req.method === "POST") return await cron(req);
    if (path === "/setup" && req.method === "GET") return await setup(req);
    return send(404, { error: "not found" });
  } catch (e) {
    console.error(e);
    return send(500, { error: "server" });
  }
});
