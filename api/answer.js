// POST /api/answer {homework_id, task_id, item_id, response}
// Checks one item on the server and saves the attempt. Returns the solution only after a second wrong attempt.
const { db, studentFromReq, checkItem, send, readBody } = require("./_lib");

module.exports = async (req, res) => {
  if (req.method !== "POST") return send(res, 405, { error: "method" });
  try {
    const s = await studentFromReq(req);
    if (!s) return send(res, 401, { error: "unknown" });
    const { homework_id, task_id, item_id, response } = await readBody(req);
    if (JSON.stringify(response ?? "").length > 4000) return send(res, 413, { error: "too long" });

    const { data: hw } = await db().from("homework").select("id,tasks,started_at,completed_at")
      .eq("id", homework_id).eq("student_id", s.id).eq("published", true).maybeSingle();
    if (!hw) return send(res, 404, { error: "homework" });

    const task = (hw.tasks || []).find((t) => t.id === task_id);
    const item = task && (task.items || []).find((i) => i.id === item_id);
    if (!item) return send(res, 404, { error: "item" });

    const { count } = await db().from("answers").select("id", { count: "exact", head: true })
      .eq("homework_id", hw.id).eq("task_id", task_id).eq("item_id", item_id);

    const { correct, solution } = checkItem(task, item, response);
    await db().from("answers").insert({
      homework_id: hw.id, student_id: s.id, task_id, item_id, response, correct, attempt: (count || 0) + 1,
    });
    if (!hw.started_at) await db().from("homework").update({ started_at: new Date().toISOString() }).eq("id", hw.id);

    const attempt = (count || 0) + 1;
    // First miss: "try again". The answer appears only after a second miss.
    send(res, 200, { correct, solution: correct === false && attempt >= 2 ? solution : null, attempt });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: "server" });
  }
};
