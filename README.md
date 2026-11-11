# Student Hub — Phase 1

Telegram mini-app + personal web link for Stacy's students.

- `docs/` — the page, served by GitHub Pages (Settings → Pages → main / docs).
  - `index.html` — student page. Opens in Telegram or via `…/#k=<access_key>`.
  - `teacher.html` — Stacy's view. Opens from the bot, or `…/teacher.html#k=<TEACHER_KEY>`.
- `supabase/functions/app/index.ts` — server (Supabase Edge Function `app`): answers checked server-side (keys never sent to students), bot webhook, daily reminder, setup.
- `supabase/schema.sql` — tables. Secrets live in the locked `app_config` table; the bot token is an Edge Function secret.
- Daily reminder: pg_cron job `daily-homework-reminder`, 14:00 UTC (17:00 Moscow).

No passwords, keys or student data are stored in this repo.
