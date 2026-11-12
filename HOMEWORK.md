# Student app — how to add homework and update a student (for Claude)

App students have their page in this repo (`docs/p/<slug>/`) and a row in the Supabase table `students`
(project ref `nrnjubhnpaicuokidnjl`, column `page` = `p/<slug>/`). Who is an app student:
`select name, page from students order by name;`. Everyone else still has an old artifact page.

The site is GitHub Pages from `docs/` on `main` → `https://stacytesolcn-oss.github.io/student-app/`.
Publishing = commit + push to `main` (Stacy has approved this; no pull request). Pages can lag up to 10 minutes;
add `?v=<anything>` to a direct link to see a change at once. The repo is public: no secrets, no student keys, nothing private.

## 1. Homework (answers save; Stacy sees them in Teacher view)

A homework is one page: `docs/p/<slug>/<hwId>/index.html` (+ `img/` next to it). `<hwId>` = next free `hwN` for that student
(`select profile->'homework' from students where page='p/<slug>/'`). Never reuse an id.

Start from `docs/kit/template.html`. The page must:
- include `<script src="../../../kit/hw.js"></script>` before its own script;
- keep ALL answers in one plain state object and call `HW.start({ id, title, get, set, summary, render })`;
- call `HW.save()` at the end of `render()` and on every text input;
- record every attempt (wrong tries too), so the summary can show them;
- end with `HW.sendBlock()` (the "Готово — отправить Stacy" button; `{lang:"en"}` for English-interface pages);
- have a back link `<a href="../" data-hw-back>← My English</a>`;
- NOT have Copy / copy-to-Telegram buttons or any "send me your answers" text. Voice messages are the exception:
  the task says to record a voice message in Telegram and not to read it aloud.

`summary()` is the text Stacy reads. Format: a line `Task N · name` starts a task (shown bold); one line per item;
put `✓` in lines that went well and `✗` in lines that didn't (shown green / red); say what the student typed and how many
tries; add one headline line per task (e.g. `Found 4 of 6 mistakes on his own`). Plain text, `\n` between lines.

`set(saved)` must check array lengths before restoring (the task may have been edited since the student started).

Check before publishing: every `<script>` parses (`node -e`), and the page works with `HW` saving (a jsdom run or a careful read).
Images: real photos only, small `.webp`, in `img/`.

Publish in two steps, so Stacy can look before the student sees it:
1. Commit + push the page. Give Stacy the direct link `https://stacytesolcn-oss.github.io/student-app/p/<slug>/<hwId>/?v=1`
   (opened without a student link it works but saves only on that device).
2. After her OK, put it on the student's page — one SQL call:
   `select app_add_homework('<slug>', '{"id":"hw7","title":"…","note":"… (Russian, short)","url":"hw7/","due":"YYYY-MM-DD","mins":"~20 мин"}'::jsonb);`
   `url` is relative (`hw7/`). The homework list lives in the database (`profile.homework`); it overrides the list inside the page file.
   Mark an old one finished: `select app_homework_done('<slug>', 'hw6');`

When the student taps the send button: it is ticked done on their page, homework reminders stop, Stacy gets a Telegram message,
and the answers show in Teacher view → student → Homework, with "Open it the way he/she did it".

Editing a published homework: changing texts is safe; adding/removing items resets that task for a student who already started.

## 2. Weekly updates for an app student

Anything in the page's `PROFILE` → the database, never the page file (the database wins):
`select app_profile_patch('<slug>', '{"note":"Focus of the week text"}'::jsonb);`
Fields: `note` (Focus of the week), `ideas` (Watch & listen), `lessons`, `price`, `minutes`, `zoom`, `stripe`, `miro`, `goals`,
`cardsNote`, `welcome`, `remindersOff`, `noDiary`, `pronReminder`, `pronDays`.
Payment rules (keep them when moving a student or touching `pack`):
- One payment = one package. A student's "I've paid" marks the CURRENT package paid if it is unpaid; only when the current
  package is already paid does it start the next one. Stacy's "✓ Payment received" after that only confirms.
- Moving a student whose current package is not paid yet: `pack.paid` must be absent (never a guessed date), `pack.start` =
  first lesson of that package. Then the page shows "Payment due" and the first payment lands on this package.
- Never add `prevPacks` by hand. To repair a wrong package: set `pack` back (`start`, `size`, `paid`), set `prevPacks` to `[]`
  (or remove the wrong entries), `nextPaymentManual` false, and `nextPayment` = first lesson after the package ends.
- After any payment change, read the row back and check: lessons taught, paid date, next payment date.

Payment and package: Stacy does it in Teacher view ("✓ Payment received", "Change package or date"). If she asks Claude:
`app_profile_patch` with `{"nextPayment":"YYYY-MM-DD","nextPaymentManual":true}` and/or `pack` `{size,start,paid,skip,add}`.
A cancelled lesson: add its date to `pack.skip`. Lesson times must match Google Calendar.

Word cards (`CARDS`, `META`, `TOPICS`) live in the page file `docs/p/<slug>/index.html`: edit them there, put new audio in
`docs/p/<slug>/audio/`, images in `img/`, then commit + push. Card rules are the same as for artifact pages.
Do not touch the boot/sync scripts at the top and bottom of the page file, and never change `KEY`.

## 3. Moving a student into the app
See `claude/Student-app-spec.md` and `claude/Student-app-homework.md` in the "My Dashboard" project: download the artifact page and its files,
`python3 tools/build_page.py old.html docs/p/<slug>/index.html`, copy assets, insert the `students` row (profile from the page,
lessons from Google Calendar, Russian `welcome`), test with a temporary copy, then Stacy sends the two links.
