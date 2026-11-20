// Teacher-only: send one message from the bot to a student right now (e.g. "new homework"),
// with a button that opens their page. Separate from "app" so the main server is untouched.
// POST { page: "p/michael/" , text, button? }  header x-auth: "key <TEACHER_KEY>"
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const send = (code: number, obj: unknown) => new Response(JSON.stringify(obj), { status: code, headers: { "content-type": "application/json" } });
function safeEq(a: string, b: string) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || !a.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return send(405, {});
  try {
    const { data: rows } = await db.from("app_config").select("key,value").in("key", ["TEACHER_KEY", "APP_URL"]);
    const c = Object.fromEntries((rows || []).map((r: any) => [r.key, r.value]));
    const h = req.headers.get("x-auth") || "";
    if (!h.startsWith("key ") || !safeEq(h.slice(4), c.TEACHER_KEY || "")) return send(401, { error: "teacher only" });
    const { page, text, button } = await req.json();
    if (typeof text !== "string" || !text.trim() || text.length > 2000) return send(400, { error: "text" });
    const { data: s } = await db.from("students").select("page,tg_chat_id").eq("active", true).eq("page", page).maybeSingle();
    if (!s || !s.tg_chat_id) return send(404, { error: "student not linked" });
    const url = String(c.APP_URL || "").replace(/\/$/, "") + "/" + (s.page || "");
    const r = await fetch(`https://api.telegram.org/bot${Deno.env.get("BOT_TOKEN")}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: s.tg_chat_id, text, reply_markup: { inline_keyboard: [[{ text: button || "Open my English", web_app: { url } }]] } }),
    });
    const j = await r.json().catch(() => ({}));
    return send(j.ok ? 200 : 502, { ok: !!j.ok });
  } catch (e) {
    console.error(e);
    return send(500, { error: "server" });
  }
});
