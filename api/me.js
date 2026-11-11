// GET /api/me — the student's page data: focus, homework (no answer keys), her saved answers.
const { db, studentFromReq, publicTasks, send } = require("./_lib");

module.exports = async (req, res) => {
  try {
    const s = await studentFromReq(req);
    if (!s) return send(res, 401, { error: "unknown" });

    const { data: hw } = await db()
      .from("homework")
      .select("id,title,intro,due,tasks,started_at,completed_at,created_at")
      .eq("student_id", s.id).eq("published", true)
      .order("created_at", { ascending: false }).limit(10);

    const ids = (hw || []).map((h) => h.id);
    let answers = [];
    if (ids.length) {
      const { data } = await db().from("answers")
        .select("homework_id,task_id,item_id,response,correct,attempt")
        .in("homework_id", ids).order("id", { ascending: true });
      answers = data || [];
    }

    // Latest attempt per item; solution shown only for items already attempted.
    const last = {};
    for (const a of answers) last[`${a.homework_id}|${a.task_id}|${a.item_id}`] = a;

    const out = (hw || []).map((h) => {
      const saved = {};
      for (const t of h.tasks || []) {
        for (const it of t.items || []) {
          const a = last[`${h.id}|${t.id}|${it.id}`];
          if (!a) continue;
          let solution = null;
          if (a.correct === false && a.attempt >= 2) {
            if (t.type === "gap") solution = (it.answers || []).map((x) => (Array.isArray(x) ? x[0] : x));
            if (t.type === "choice") solution = it.answer;
            if (t.type === "order") solution = Array.isArray(it.answer) ? it.answer[0] : it.answer;
          }
          saved[`${t.id}|${it.id}`] = { response: a.response, correct: a.correct, attempt: a.attempt, solution };
        }
      }
      return { id: h.id, title: h.title, intro: h.intro, due: h.due, done: !!h.completed_at,
               completed_at: h.completed_at, tasks: publicTasks(h.tasks), saved };
    });

    send(res, 200, { name: s.name, focus: s.focus, tz: s.tz, linkedTelegram: !!s.tg_user_id, homework: out });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: "server" });
  }
};
