-- Rode uma vez no Supabase: SQL Editor > New query > Run
create table if not exists rifa_dados (
  id text primary key,
  dados jsonb not null,
  atualizado_em timestamptz not null default now()
);

-- Trava de segurança: ninguém acessa a tabela pela chave pública.
-- O site usa a chave "service_role" (só no servidor), que ignora essa trava.
alter table rifa_dados enable row level security;
