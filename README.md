# Student app — Phase 1

Telegram mini-app + personal web link for Stacy's students. Hosted on Vercel (`*.vercel.app`, no custom domain: reachable from Russia without VPN). Data in Supabase, reached only from the server.

- `public/index.html` — student page (homework, focus of the week). Opens in Telegram or via `/#k=<access_key>`.
- `public/teacher.html` — Stacy's view. Opens from the bot, or `/teacher.html#k=<TEACHER_KEY>`.
- `api/` — server: `me`, `answer` (checks on the server, keys never sent), `submit`, `teacher`, `bot` (webhook), `cron` (daily reminder, 14:00 UTC), `setup` (one-time webhook + menu button).
- `supabase/schema.sql` — tables (already applied).

## Vercel environment variables
SUPABASE_URL, SUPABASE_SERVICE_KEY, BOT_TOKEN, BOT_USERNAME, APP_URL, TEACHER_KEY, TEACHER_TG_ID, WEBHOOK_SECRET, CRON_SECRET

After the first deploy: open `/api/setup?k=<TEACHER_KEY>` once.
