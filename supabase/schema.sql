-- Student app — Phase 1 schema.
-- Only the server (service role) touches these tables. RLS is on with no policies,
-- so the public Data API can't read or write anything.

create table if not exists public.students (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  tz           text not null default 'Europe/Moscow',
  access_key   text not null unique default encode(gen_random_bytes(18), 'hex'),
  tg_user_id   bigint unique,
  tg_chat_id   bigint,
  focus        text,                      -- focus of the week (student-facing)
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

-- One row = one homework set.
-- tasks: [{id, type, title?, instructions, items:[...]}]
--   type "gap"    item: {id, text:"I ___ to the gym.", answers:["go"]}
--   type "choice" item: {id, text, options:["a","b","c"], answer:1}
--   type "order"  item: {id, words:["to","I","go"], answer:"I go to"}
--   type "write"  item: {id, stem:"On weekend mornings I ..."}         (max 3 per task)
--   type "voice"  item: {id, prompt:"Tell me about ..."}               (sent in Telegram)
-- answers / answer are stripped by the server before anything reaches the student.
create table if not exists public.homework (
  id            uuid primary key default gen_random_uuid(),
  student_id    uuid not null references public.students(id) on delete cascade,
  title         text not null,
  intro         text,
  due           date,
  tasks         jsonb not null default '[]'::jsonb,
  published     boolean not null default false,
  started_at    timestamptz,
  completed_at  timestamptz,
  reminded_on   date,
  created_at    timestamptz not null default now()
);
create index if not exists homework_student_idx on public.homework(student_id, created_at desc);

-- Every attempt is kept (first-attempt errors are useful for the next lesson).
create table if not exists public.answers (
  id           bigint generated always as identity primary key,
  homework_id  uuid not null references public.homework(id) on delete cascade,
  student_id   uuid not null references public.students(id) on delete cascade,
  task_id      text not null,
  item_id      text not null,
  response     jsonb not null,
  correct      boolean,          -- null for open tasks (write / voice)
  attempt      int not null default 1,
  created_at   timestamptz not null default now()
);
create index if not exists answers_hw_idx on public.answers(homework_id, task_id, item_id);

alter table public.students enable row level security;
alter table public.homework enable row level security;
alter table public.answers  enable row level security;
revoke all on public.students, public.homework, public.answers from anon, authenticated;
