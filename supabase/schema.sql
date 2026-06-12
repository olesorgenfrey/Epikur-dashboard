-- ============================================================
-- PRACTIO DASHBOARD — Supabase Schema
-- ============================================================
-- Ausführen in: Supabase Dashboard → SQL Editor → Run
-- ============================================================

-- Enable UUID extension
create extension if not exists "pgcrypto";

-- ============================================================
-- PERSONS (Team-Mitglieder)
-- ============================================================
create table if not exists persons (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  color       text default 'blue',   -- blue | purple | green | yellow | red
  created_at  timestamptz default now()
);

insert into persons (name, color) values
  ('Ole',    'blue'),
  ('Kumpel', 'purple')
on conflict do nothing;

-- ============================================================
-- LEADS
-- ============================================================
create type lead_status as enum (
  'offen',
  'angerufen',
  'einwilligung',
  'mail_gesendet',
  'follow_up',
  'abgeschlossen',
  'abgelehnt'
);

create type praxis_type as enum (
  'Psychotherapie',
  'Privatpraxis',
  'Gruppenpraxis'
);

create table if not exists leads (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  city        text,
  type        praxis_type default 'Psychotherapie',
  status      lead_status default 'offen',
  notes       text,
  assignee_id uuid references persons(id) on delete set null,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- Seed leads
insert into leads (name, city, type, status, notes) values
  ('Praxis Mehner',  'Hamburg',   'Psychotherapie', 'angerufen',     'Interesse gezeigt, Mail folgt'),
  ('Dr. Braun',      'Lüneburg',  'Privatpraxis',   'einwilligung',  'Mail raus am 05.06'),
  ('Praxis Müller',  'Stade',     'Psychotherapie', 'mail_gesendet', 'Follow-up in 1 Woche'),
  ('Zentrum Wedel',  'Wedel',     'Gruppenpraxis',  'offen',         null),
  ('Dr. Fischer',    'Buxtehude', 'Psychotherapie', 'abgelehnt',     'Hat Vertrag bis 2026'),
  ('Praxis Vogel',   'Harburg',   'Privatpraxis',   'angerufen',     null)
on conflict do nothing;

-- Auto-update updated_at
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

create trigger leads_updated_at before update on leads
  for each row execute function update_updated_at();

-- ============================================================
-- TASKS
-- ============================================================
create type task_priority as enum ('low', 'medium', 'high');

create table if not exists tasks (
  id          uuid primary key default gen_random_uuid(),
  text        text not null,
  meta        text,                                           -- Kategorie / Tag
  assignee_id uuid references persons(id) on delete set null,
  done        boolean default false,
  priority    task_priority default 'medium',
  due_date    date,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

create trigger tasks_updated_at before update on tasks
  for each row execute function update_updated_at();

-- Seed tasks (assignee_id wird per subquery aufgelöst)
insert into tasks (text, meta, assignee_id, done, priority) values
  ('Onboarding-Flow fertigstellen',       'Practio · Feature', (select id from persons where name='Ole'    limit 1), false, 'high'),
  ('§7 UWG Telefonleitfaden erstellen',  'Akquise · Doku',    (select id from persons where name='Kumpel' limit 1), true,  'high'),
  ('Datenschutzerklärung aktualisieren', 'Legal · Prio hoch', (select id from persons where name='Ole'    limit 1), false, 'high'),
  ('Demo-Video aufnehmen',               'Marketing',         (select id from persons where name='Ole'    limit 1), false, 'medium'),
  ('Lead-Liste auf 50 erweitern',        'Akquise',           (select id from persons where name='Kumpel' limit 1), false, 'medium'),
  ('E-Mail-Vorlage finalisieren',        'Akquise',           (select id from persons where name='Kumpel' limit 1), true,  'medium'),
  ('Stripe Integration testen',          'Practio · Tech',    (select id from persons where name='Ole'    limit 1), false, 'high'),
  ('Servermonitoring einrichten',        'Infra',             (select id from persons where name='Ole'    limit 1), false, 'low')
on conflict do nothing;

-- ============================================================
-- MILESTONES
-- ============================================================
create table if not exists milestones (
  id          uuid primary key default gen_random_uuid(),
  label       text not null,
  target_date date,
  done        boolean default false,
  progress    int default 0 check (progress between 0 and 100),
  color       text default '#6EA8FF',
  sort_order  int default 0,
  created_at  timestamptz default now()
);

insert into milestones (label, target_date, done, progress, color, sort_order) values
  ('MVP Live',                   '2025-05-01', true,  100, '#4ADE80', 1),
  ('Marketing-Website',          '2025-06-01', true,  100, '#4ADE80', 2),
  ('Erste 5 Leads kontaktiert',  null,         false,  60, '#FBBf24', 3),
  ('Erster Kunde',               '2025-07-01', false,  15, '#6EA8FF', 4),
  ('10 aktive Praxen',           '2025-10-01', false,   0, '#C084FC', 5),
  ('Breakeven',                  '2026-01-01', false,   0, '#9CA3AF', 6)
on conflict do nothing;

-- ============================================================
-- FINANCE
-- ============================================================
create table if not exists finance_costs (
  id       uuid primary key default gen_random_uuid(),
  label    text not null,
  amount   numeric(10,2) not null,
  currency text default 'EUR',
  recurring boolean default true   -- monatlich wiederkehrend
);

insert into finance_costs (label, amount) values
  ('Strato Server', 10.00),
  ('OpenAI API',    20.00),
  ('Domain & SSL',   2.00),
  ('Tools & SaaS',  30.00)
on conflict do nothing;

create table if not exists finance_scenarios (
  id            uuid primary key default gen_random_uuid(),
  label         text not null,
  customers     int not null,
  mrr           numeric(10,2) not null,
  color         text default '#6EA8FF',
  sort_order    int default 0
);

insert into finance_scenarios (label, customers, mrr, color, sort_order) values
  ('1 Kunde',               1,   99.00, '#F87171', 1),
  ('3 Kunden',              3,  297.00, '#FBBf24', 2),
  ('5 Kunden (Break-even)', 5,  495.00, '#4ADE80', 3),
  ('10 Kunden',            10,  990.00, '#6EA8FF', 4),
  ('20 Kunden',            20, 1980.00, '#C084FC', 5)
on conflict do nothing;

-- Tatsächliche MRR-Einträge (wird laufend befüllt)
create table if not exists finance_mrr (
  id          uuid primary key default gen_random_uuid(),
  month       date not null,           -- erster Tag des Monats
  mrr         numeric(10,2) default 0,
  customers   int default 0,
  notes       text,
  created_at  timestamptz default now()
);

-- ============================================================
-- PRACTIO PROJECT CONTROL
-- ============================================================
create table if not exists projects (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  name        text not null,
  description text,
  repository  text,
  active      boolean default true,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

create table if not exists masterplans (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references projects(id) on delete cascade,
  product_goal   text not null default '',
  mvp_goal       text not null default '',
  modules        jsonb not null default '[]'::jsonb,
  risks          jsonb not null default '[]'::jsonb,
  open_questions jsonb not null default '[]'::jsonb,
  version        int not null default 1,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

create table if not exists team_members (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references projects(id) on delete cascade,
  name             text not null,
  role             text not null,
  responsibilities jsonb not null default '[]'::jsonb,
  color            text default 'blue',
  active           boolean default true,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now(),
  unique(project_id, name)
);

-- Bestehende Tabellen werden erweitert, damit alte Dashboard-Daten erhalten bleiben.
alter table milestones add column if not exists project_id uuid references projects(id) on delete cascade;
alter table milestones add column if not exists description text;
alter table milestones add column if not exists updated_at timestamptz default now();

alter table tasks add column if not exists project_id uuid references projects(id) on delete cascade;
alter table tasks add column if not exists milestone_id uuid references milestones(id) on delete set null;
alter table tasks add column if not exists title text;
alter table tasks add column if not exists description text default '';
alter table tasks add column if not exists acceptance_criteria jsonb not null default '[]'::jsonb;
alter table tasks add column if not exists module text default '';
alter table tasks add column if not exists effort text default 'M';
alter table tasks add column if not exists team_member_id uuid references team_members(id) on delete set null;
alter table tasks add column if not exists dependencies uuid[] not null default '{}';
alter table tasks add column if not exists definition_of_done jsonb not null default '[]'::jsonb;
alter table tasks add column if not exists status text not null default 'backlog';
alter table tasks add column if not exists sort_order int default 0;

create table if not exists task_comments (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references tasks(id) on delete cascade,
  author     text not null,
  body       text not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists task_checklist_items (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references tasks(id) on delete cascade,
  label      text not null,
  done       boolean default false,
  sort_order int default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists github_links (
  id              uuid primary key default gen_random_uuid(),
  task_id         uuid not null unique references tasks(id) on delete cascade,
  repository      text not null,
  branch_name     text,
  commit_hash     text,
  pr_url          text,
  branch_exists   boolean default false,
  pr_open         boolean default false,
  checks_passed   boolean default false,
  review_needed   boolean default true,
  merge_ready     boolean default false,
  last_synced_at  timestamptz,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create table if not exists ai_reviews (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references tasks(id) on delete cascade,
  commit_hash text,
  pr_url      text,
  result      text not null check (result in ('ready', 'changes_needed', 'reject')),
  summary     text,
  findings    jsonb not null default '[]'::jsonb,
  suggestions jsonb not null default '[]'::jsonb,
  next_task   text,
  provider    text,
  raw_excerpt text,
  created_at  timestamptz default now()
);

create table if not exists activity_log (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  task_id    uuid references tasks(id) on delete set null,
  actor      text not null,
  action     text not null,
  source     text not null,
  details    jsonb not null default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists tasks_project_status_idx on tasks(project_id, status);
create index if not exists task_comments_task_idx on task_comments(task_id, created_at);
create index if not exists checklist_task_idx on task_checklist_items(task_id, sort_order);
create index if not exists ai_reviews_task_idx on ai_reviews(task_id, created_at desc);
create index if not exists activity_project_idx on activity_log(project_id, created_at desc);

insert into projects (id, slug, name, description, repository)
values (
  '10000000-0000-4000-8000-000000000001',
  'practio',
  'Practio',
  'Produktentwicklung und Markteinführung von Practio.',
  'olesorgenfrey/epikur'
)
on conflict (slug) do update set
  name = excluded.name,
  description = excluded.description,
  repository = excluded.repository;

insert into masterplans (
  id, project_id, product_goal, mvp_goal, modules, risks, open_questions, version
) values (
  '10000000-0000-4000-8000-000000000002',
  (select id from projects where slug = 'practio'),
  'Practio wird die verlässliche digitale Arbeitsumgebung für psychotherapeutische Praxen.',
  'Ein sicherer, verständlicher Kernworkflow, der im Praxisalltag ohne Schulungsaufwand nutzbar ist.',
  '["Praxisverwaltung","Patientenportal","Dokumentation","Abrechnung","Betrieb & Sicherheit"]'::jsonb,
  '["Datenschutz und Schweigepflicht","Zu großer MVP-Umfang","Fehlende echte Praxis-Tests"]'::jsonb,
  '["Welche drei Workflows sparen Praxen zuerst messbar Zeit?","Welche Daten müssen zum MVP exportierbar sein?"]'::jsonb,
  1
)
on conflict (id) do nothing;

insert into team_members (id, project_id, name, role, responsibilities, color) values
  (
    '10000000-0000-4000-8000-000000000003',
    (select id from projects where slug = 'practio'),
    'Ole',
    'Product & Tech Lead',
    '["Produktentscheidungen","Technische Hauptaufgaben","Reviews","Feature-Priorisierung"]'::jsonb,
    'blue'
  ),
  (
    '10000000-0000-4000-8000-000000000004',
    (select id from projects where slug = 'practio'),
    'Henry',
    'Research & Operations',
    '["Recherche","Dokumentation","Tests","Einfache UI- und Content-Aufgaben","Praxislisten","Wettbewerbsanalyse","Marketing-Vorbereitung"]'::jsonb,
    'purple'
  )
on conflict (project_id, name) do update set
  role = excluded.role,
  responsibilities = excluded.responsibilities,
  color = excluded.color;

update milestones
set project_id = (select id from projects where slug = 'practio')
where project_id is null;

update tasks
set
  project_id = coalesce(project_id, (select id from projects where slug = 'practio')),
  title = coalesce(nullif(title, ''), text),
  status = case when done then 'done' else coalesce(nullif(status, ''), 'backlog') end;

update tasks t
set team_member_id = tm.id
from persons p
join team_members tm
  on lower(tm.name) = case when lower(p.name) = 'kumpel' then 'henry' else lower(p.name) end
where t.assignee_id = p.id
  and t.team_member_id is null;

-- ============================================================
-- ROW LEVEL SECURITY (RLS) — Basis-Setup
-- ============================================================
alter table persons         enable row level security;
alter table leads           enable row level security;
alter table tasks           enable row level security;
alter table milestones      enable row level security;
alter table finance_costs   enable row level security;
alter table finance_scenarios enable row level security;
alter table finance_mrr     enable row level security;
alter table projects        enable row level security;
alter table masterplans     enable row level security;
alter table team_members    enable row level security;
alter table task_comments   enable row level security;
alter table task_checklist_items enable row level security;
alter table github_links    enable row level security;
alter table ai_reviews      enable row level security;
alter table activity_log    enable row level security;

-- Für internes Dashboard: alle authentifizierten User dürfen alles lesen/schreiben
-- Später einschränken auf spezifische User-IDs oder Rollen

create policy "auth users read all" on persons         for select using (auth.role() = 'authenticated');
create policy "auth users read all" on leads           for select using (auth.role() = 'authenticated');
create policy "auth users read all" on tasks           for select using (auth.role() = 'authenticated');
create policy "auth users read all" on milestones      for select using (auth.role() = 'authenticated');
create policy "auth users read all" on finance_costs   for select using (auth.role() = 'authenticated');
create policy "auth users read all" on finance_scenarios for select using (auth.role() = 'authenticated');
create policy "auth users read all" on finance_mrr     for select using (auth.role() = 'authenticated');
create policy "auth users read all" on projects        for select using (auth.role() = 'authenticated');
create policy "auth users read all" on masterplans     for select using (auth.role() = 'authenticated');
create policy "auth users read all" on team_members    for select using (auth.role() = 'authenticated');
create policy "auth users read all" on task_comments   for select using (auth.role() = 'authenticated');
create policy "auth users read all" on task_checklist_items for select using (auth.role() = 'authenticated');
create policy "auth users read all" on github_links    for select using (auth.role() = 'authenticated');
create policy "auth users read all" on ai_reviews      for select using (auth.role() = 'authenticated');
create policy "auth users read all" on activity_log    for select using (auth.role() = 'authenticated');

create policy "auth users write all" on persons        for all using (auth.role() = 'authenticated');
create policy "auth users write all" on leads          for all using (auth.role() = 'authenticated');
create policy "auth users write all" on tasks          for all using (auth.role() = 'authenticated');
create policy "auth users write all" on milestones     for all using (auth.role() = 'authenticated');
create policy "auth users write all" on finance_costs  for all using (auth.role() = 'authenticated');
create policy "auth users write all" on finance_scenarios for all using (auth.role() = 'authenticated');
create policy "auth users write all" on finance_mrr    for all using (auth.role() = 'authenticated');
create policy "auth users write all" on projects       for all using (auth.role() = 'authenticated');
create policy "auth users write all" on masterplans    for all using (auth.role() = 'authenticated');
create policy "auth users write all" on team_members   for all using (auth.role() = 'authenticated');
create policy "auth users write all" on task_comments  for all using (auth.role() = 'authenticated');
create policy "auth users write all" on task_checklist_items for all using (auth.role() = 'authenticated');
create policy "auth users write all" on github_links   for all using (auth.role() = 'authenticated');
create policy "auth users write all" on ai_reviews     for all using (auth.role() = 'authenticated');
create policy "auth users write all" on activity_log   for all using (auth.role() = 'authenticated');

-- ============================================================
-- NÜTZLICHE VIEWS
-- ============================================================

-- Funnel-Übersicht
create or replace view lead_funnel as
  select status, count(*) as count
  from leads
  group by status
  order by case status
    when 'offen'         then 1
    when 'angerufen'     then 2
    when 'einwilligung'  then 3
    when 'mail_gesendet' then 4
    when 'follow_up'     then 5
    when 'abgeschlossen' then 6
    when 'abgelehnt'     then 7
  end;

-- Tasks pro Person
create or replace view tasks_by_person as
  select p.name, p.color,
    count(*) filter (where not t.done) as open_tasks,
    count(*) filter (where t.done)     as done_tasks
  from persons p
  left join tasks t on t.assignee_id = p.id
  group by p.id, p.name, p.color;

-- Gesamtkosten
create or replace view total_monthly_costs as
  select sum(amount) as total from finance_costs where recurring = true;
