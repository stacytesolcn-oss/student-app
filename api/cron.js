// GET /api/cron — runs once a day (vercel.json). Homework reminders + keeps Supabase awake.
// Reminds when unfinished homework is due today or tomorrow (student's own time zone), once per day.
const { db, tg, openButton, send, dateIn } = require("./_lib");

module.exports = async (req, res) => {
  const auth = req.headers["authorization"] || "";
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) return send(res, 401, { error: "cron" });
  try {
    const { data: rows } = await db().from("homework")
      .select("id,title,due,reminded_on,student:students(id,name,tz,tg_chat_id,active)")
      .eq("published", true).is("completed_at", null).not("due", "is", null);

    let sent = 0;
    for (const h of rows || []) {
      const s = h.student;
      if (!s || !s.active || !s.tg_chat_id) continue;
      const today = dateIn(s.tz);
      const tomorrow = dateIn(s.tz, new Date(Date.now() + 864e5));
      if (h.reminded_on === today) continue;
      if (h.due !== today && h.due !== tomorrow) continue;
      const when = h.due === today ? "today" : "tomorrow";
      const r = await tg("sendMessage", {
        chat_id: s.tg_chat_id,
        text: `Hi ${s.name}! Friendly reminder: your homework "${h.title}" is for ${when}. It takes just a few minutes 🙂`,
        reply_markup: openButton("Do my homework"),
      });
      if (r.ok) {
        sent++;
        await db().from("homework").update({ reminded_on: today }).eq("id", h.id);
      }
    }
    send(res, 200, { ok: true, sent });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: "server" });
  }
};
