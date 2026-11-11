// POST /api/bot — Telegram webhook.
// /start <access_key>  → links this Telegram account to that student
// /start               → shows the "Open" button (or a hint if unknown)
// /id                  → replies with the sender's Telegram ID (Stacy needs hers once)
const { db, tg, openButton, send, readBody, safeEq } = require("./_lib");

module.exports = async (req, res) => {
  if (req.method !== "POST") return send(res, 405, { error: "method" });
  if (!safeEq(req.headers["x-telegram-bot-api-secret-token"] || "", process.env.WEBHOOK_SECRET || "-")) {
    return send(res, 401, { error: "secret" });
  }
  try {
    const upd = await readBody(req);
    const m = upd.message;
    if (!m || !m.text || m.chat.type !== "private") return send(res, 200, { ok: true });
    const text = m.text.trim();
    const uid = m.from.id;
    const isTeacher = String(uid) === String(process.env.TEACHER_TG_ID || "");

    if (text === "/id") {
      await tg("sendMessage", { chat_id: m.chat.id, text: `Your Telegram ID: ${uid}` });
      return send(res, 200, { ok: true });
    }

    if (text.startsWith("/start")) {
      const key = text.split(/\s+/)[1];
      if (isTeacher && !key) {
        await tg("sendMessage", { chat_id: m.chat.id, text: "Teacher view:", reply_markup: {
          inline_keyboard: [[{ text: "Open teacher view", web_app: { url: (process.env.APP_URL || "").replace(/\/$/, "") + "/teacher.html" } }]] } });
        return send(res, 200, { ok: true });
      }
      if (key && /^[a-f0-9]{20,64}$/.test(key)) {
        const { data: s } = await db().from("students").select("id,name").eq("access_key", key).maybeSingle();
        if (s) {
          // one Telegram account per student
          await db().from("students").update({ tg_user_id: null, tg_chat_id: null }).eq("tg_user_id", uid).neq("id", s.id);
          await db().from("students").update({ tg_user_id: uid, tg_chat_id: m.chat.id }).eq("id", s.id);
          await tg("sendMessage", { chat_id: m.chat.id,
            text: `Hi ${s.name}! 👋 Your English page is here. I'll also remind you about homework.`,
            reply_markup: openButton() });
          return send(res, 200, { ok: true });
        }
      }
      const { data: known } = await db().from("students").select("name").eq("tg_user_id", uid).maybeSingle();
      await tg("sendMessage", known
        ? { chat_id: m.chat.id, text: `Hi ${known.name}!`, reply_markup: openButton() }
        : { chat_id: m.chat.id, text: "Hi! Please use the personal link from your teacher to get started." });
      return send(res, 200, { ok: true });
    }

    // Any other message from a student: a gentle pointer
    const { data: known } = await db().from("students").select("name").eq("tg_user_id", uid).maybeSingle();
    if (known) {
      await tg("sendMessage", { chat_id: m.chat.id,
        text: "I'm just a helper bot — please message Stacy directly 🙂", reply_markup: openButton() });
    }
    send(res, 200, { ok: true });
  } catch (e) {
    console.error(e);
    send(res, 200, { ok: true }); // never make Telegram retry forever
  }
};
