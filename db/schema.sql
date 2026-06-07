-- Milo — schéma Postgres
-- Extensions
create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists vector;     -- pgvector (mémoire sémantique)
create extension if not exists pg_trgm;    -- repli recherche plein-texte

-- Utilisateurs (liste blanche + profil + préférences)
create table if not exists users (
  id                 uuid primary key default gen_random_uuid(),
  phone              text unique not null,
  display_name       text,
  timezone           text not null default 'Europe/Paris',
  quiet_hours_start  int  not null default 22,   -- heure locale (pas de proactif après)
  quiet_hours_end    int  not null default 8,    -- ... ni avant
  is_allowed         boolean not null default false,
  profile            jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

-- Compaction : résumé glissant des échanges anciens (discussions longues)
alter table users add column if not exists summary text;

-- Historique des messages (+ idempotence via provider_msg_id)
create table if not exists messages (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  direction       text not null check (direction in ('inbound','outbound')),
  body            text not null,
  provider_msg_id text unique,                   -- dédup des webhooks rejoués
  created_at      timestamptz not null default now()
);
create index if not exists messages_user_created_idx on messages(user_id, created_at desc);

-- Mémoire long terme (« second cerveau »)
create table if not exists memories (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  kind       text not null,                       -- profil|preference|fait|relation|projet
  content    text not null,
  embedding  vector(1024),                        -- nullable ; rempli si modèle d'embedding branché (Voyage voyage-3 = 1024)
  source     text,
  created_at timestamptz not null default now()
);
create index if not exists memories_user_idx on memories(user_id);
create index if not exists memories_content_trgm on memories using gin (content gin_trgm_ops);  -- repli FTS
-- Index vectoriel à activer quand les embeddings sont en place :
-- create index on memories using hnsw (embedding vector_cosine_ops);

-- Todo par utilisateur
create table if not exists tasks (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  text         text not null,
  status       text not null default 'open' check (status in ('open','done')),
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);

-- Rappels datés (déclenchés par BullMQ)
create table if not exists reminders (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  text       text not null,
  due_at     timestamptz not null,
  job_id     text,
  status     text not null default 'scheduled' check (status in ('scheduled','sent','cancelled')),
  created_at timestamptz not null default now()
);
create index if not exists reminders_due_idx on reminders(due_at) where status = 'scheduled';

-- Veille de sujets
create table if not exists monitored_topics (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  topic      text not null,
  cadence    text not null default 'daily',
  last_seen  jsonb not null default '{}'::jsonb,   -- état comparatif (URLs/hash déjà vus)
  job_id     text,
  status     text not null default 'active' check (status in ('active','paused')),
  created_at timestamptz not null default now()
);

-- Journal des messages proactifs (garde-fous anti-spam / plafonds)
create table if not exists proactive_log (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  kind       text not null,                        -- reminder|watch|nudge
  body       text not null,
  created_at timestamptz not null default now()
);
create index if not exists proactive_log_user_created_idx on proactive_log(user_id, created_at desc);
