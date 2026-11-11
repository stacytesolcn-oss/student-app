// POST /api/submit {homework_id} — marks homework done and pings Stacy in Telegram.
const { db, tg, studentFromReq, send, readBody, appUrl } = require("./_lib");

module.exports = async (req, res) => {
  if (req.method !== "POST") return send(res, 405, { error: "method" });
  try {
    const s = await studentFromReq(req);
    if (!s) return send(res, 401, { error: "unknown" });
    const { homework_id } = await readBody(req);

    const { data: hw } = await db().from("homework").select("id,title,completed_at")
      .eq("id", homework_id).eq("student_id", s.id).eq("published", true).maybeSingle();
    if (!hw) return send(res, 404, { error: "homework" });

    if (!hw.completed_at) {
      const now = new Date().toISOString();
      await db().from("homework").update({ completed_at: now }).eq("id", hw.id);
      const teacher = process.env.TEACHER_TG_ID;
      if (teacher) {
        await tg("sendMessage", {
          chat_id: teacher,
          text: `✅ ${s.name} finished "${hw.title}".`,
          reply_markup: { inline_keyboard: [[{ text: "See answers", web_app: { url: appUrl() + "/teacher.html" } }]] },
        });
      }
    }
    send(res, 200, { ok: true });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: "server" });
  }
};
