// GET /api/setup?k=TEACHER_KEY — one-time: points Telegram at our webhook and sets the bot's menu button.
const { tg, send, appUrl, safeEq } = require("./_lib");

module.exports = async (req, res) => {
  const k = new URL(req.url, "http://x").searchParams.get("k") || "";
  if (!safeEq(k, process.env.TEACHER_KEY || "")) return send(res, 401, { error: "teacher only" });
  const base = appUrl();
  const hook = await tg("setWebhook", {
    url: base + "/api/bot",
    secret_token: process.env.WEBHOOK_SECRET,
    allowed_updates: ["message"],
    drop_pending_updates: true,
  });
  const menu = await tg("setChatMenuButton", {
    menu_button: { type: "web_app", text: "My English", web_app: { url: base + "/" } },
  });
  const cmds = await tg("setMyCommands", { commands: [{ command: "start", description: "Open my English" }] });
  send(res, 200, { webhook: hook.ok, menu: menu.ok, commands: cmds.ok, url: base });
};
