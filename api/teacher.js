// GET /api/teacher — Stacy's overview: every student, their homework, all attempts (with keys).
const { db, isTeacher, send, appUrl } = require("./_lib");

module.exports = async (req, res) => {
  try {
    if (!isTeacher(req)) return send(res, 401, { error: "teacher only" });
    const [{ data: students }, { data: hw }] = await Promise.all([
      db().from("students").select("id,name,tz,access_key,tg_user_id,focus,active").order("name"),
      db().from("homework").select("id,student_id,title,due,tasks,published,started_at,completed_at,created_at")
        .order("created_at", { ascending: false }).limit(100),
    ]);
    const ids = (hw || []).map((h) => h.id);
    let answers = [];
    if (ids.length) {
      const { data } = await db().from("answers")
        .select("homework_id,task_id,item_id,response,correct,attempt,created_at")
        .in("homework_id", ids).order("id");
      answers = data || [];
    }
    const base = appUrl();
    send(res, 200, {
      students: (students || []).map((s) => ({
        ...s,
        link: `${base}/#k=${s.access_key}`,
        telegramLink: process.env.BOT_USERNAME ? `https://t.me/${process.env.BOT_USERNAME}?start=${s.access_key}` : null,
      })),
      homework: hw || [],
      answers,
    });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: "server" });
  }
};
