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

Student names (`students.name`) are short first names only ("Jane", "Anna"): students see them ("Hi {name}!").
Stacy sees `profile.fullName` = the calendar name ("Jane Munich", "Anna Belgrade") in Teacher view and in the bot's messages to her
(server v27). Set both when moving a student. Access key = `encode(gen_random_bytes(18),'hex')` (letters/digits only; a uuid with dashes is rejected). Two rows can share a short name; tell students apart by `page`.

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

## Lesson time changed for one week

Do not edit the page. Split the weekday in `profile.lessons` with `from` / `until` (dates in the student's time zone):
`[{"day":"Saturday","time":"08:15","until":"<day before>"},{"day":"Saturday","time":"10:40","from":"<date>","until":"<date>"},{"day":"Saturday","time":"08:15","from":"<day after>"}]`.
Reminders, the "Next lesson" tile, "My lessons" and Teacher view all follow it; it goes back to normal by itself.
A lesson moved to another DAY: put the old date in `pack.skip` and the new date in `pack.add`, plus a one-day entry
`{"day":"<new weekday>","time":"..","from":"<date>","until":"<date>"}`. Jane's page (older template) does not read from/until yet.

## State on Nov 12 (evening) — read before moving the next student

Students in the app: Jane (not connected yet, older page template), Michael (connected), Sabina (connected, English page),
Lilia (moved Nov 13, Belgrade time, English page, older template; live, link with Stacy to send).
Inna (moved Nov 15, slug `inna`, Moscow time, English page with an `archived` homework list (build_page.py patches it);
lessons Tue 11:15 / Fri 11:20; 10-lesson package from Nov 10 paid Nov 9, next payment Dec 15; hw1–hw5 are old artifact links).
Jane Munich (moved Nov 13, slug `jane-munich`, Berlin time, English page, newer template; lessons Tue 10:20 / Thu 10:15;
5-lesson Nov package paid, next payment Nov 19; no Stripe link yet; `hw1` built but not added to her page yet).
Anna (Belgrade) (moved Nov 16, slug `anna-belgrade`, row name "Anna", Belgrade time, English page, own template: the package
dots are built from `pack` by `packLessons()` in the page; homework list + `pastHomework`; Mon 09:30 / Fri 10:30;
9-lesson package from Nov 2, paid, Nov 13 cancelled (`pack.skip`) → last lesson Dec 4, next payment Dec 7; `hw1` = Girls' trip stories in the app).
Server: Edge Function `app` v27 (fullName), repo file in sync.

Reminders now (all students, student time):
- One practice message a day (homework day > pronunciation day > cards). Texts rotate; they live in `app_config` key
  `REMINDER_TEXTS` (JSON: cards / hw / pron arrays, `{name}` `{cards}`) — change texts there with SQL, no deploy.
  Stacy's rules: no card emoji; Miso/Nori only in cards + homework lines; pronunciation, lesson, payment stay plain.
- 18:00 the evening before a lesson: ONE message = lesson tomorrow + homework line if open + payment line and
  Pay / I've paid buttons if a payment is due at that lesson or overdue. No other payment messages.
- 1 hour before the lesson. Lesson texts name the city of the student's `tzName` ("Moscow time", "Belgrade time"; v25).
- Welcome text: no "helper", no cats: "You'll get short, friendly reminders here about your cards, homework and lessons."

Pages:
- Homework with its own page in the app is done only when sent (cards.hwServer); no hand "mark as done" for it.
  Finished homework is folded under "Previous homework" (Michael's page; Sabina's template has its own past list).
- Daily cards: up to 12 (new ones first). Do not keep any "new cards only" limit when converting a page.
- Teacher view: a paid package shows no "Payment received" button; "Next package paid already?" needs two taps.
- Test a moved student with a temporary "<Name> TEST" row (remindersOff), then delete it and call /setup.
- After every page or data change, run the page in jsdom with TODAY's date and read: next lesson, lessons done, payment, homework.

## Homework links on student pages (Nov 17, 2026)
In-app homework (`url` like `hw6/`) must open in the **same window** with the login in the hash (`hwHref(h)` on every student page; `tools/build_page.py` step 6 adds it). Never `target="_blank"` for in-app homework: inside Telegram it can leave the mini-app, the kit then has no login and answers stay on the phone only (Inna, hw6). The kit now shows a red-flag banner when it has no login.

## Telling a student about new homework right away (Nov 20, 2026)
Separate Edge Function `notify` (repo: `supabase/functions/notify/`, the main `app` function is untouched). Teacher-only.
Send from SQL with pg_net, the key stays in the database:
`select net.http_post(url := 'https://nrnjubhnpaicuokidnjl.supabase.co/functions/v1/notify', body := jsonb_build_object('page','p/<slug>/','button','Do my homework','text','Hi <Name>! …'), headers := jsonb_build_object('content-type','application/json','x-auth','key '||(select value from app_config where key='TEACHER_KEY')));`
Check: `select status_code, content from net._http_response where id = <request_id>;` → 200 {"ok":true}. Messages in English, student's name.
Sabina only (not other students): her new-homework message must tell her to open it right there — with the button under the message or from My English in the Telegram bot — so the app saves her answers. This line is in Russian (ты): "Открой домашку кнопкой ниже или через My English здесь в Telegram — тогда твои ответы сохранятся и я их увижу." (Nov 2026 she did hw-gives-helps on an old copy-paste tab and nothing reached the app.)

## Removing checked homework from Teacher view (Nov 20, 2026)
Teacher view lists every `student_state` key that starts with `hw:`. To hide one Stacy has checked, keep the answers but rename the key:
`update student_state set key='checked:<hwId>' where key='hw:<hwId>' and student_id=(select id from students where page='p/<slug>/');`
Also mark it finished on the student's page: `select app_homework_done('<slug>','<hwId>');`
Note: the front "Homework" card on a student page shows only the open homework with the earliest due date, so an old open one hides a new one.

## Homework troubleshooting (Nov 21, 2026 — Maria hw1)
- Kit (`hw.js`): if a homework page can't draw itself, it shows a pink box "Домашка не загрузилась" with an «Обновить» button
  (drops that phone's saved copy, reloads) and a grey technical line (error + iOS version). Ask the student for a screenshot of it.
- Student pages: when a homework link has no login in it (device blocks browser storage, seen on Maria's iPad), the click handler
  adds the login from the page itself, so the kit doesn't fall back to "saves only on this phone".
