create table if not exists public.openclaw_records (
  tab text not null,
  key text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tab, key)
);

create index if not exists openclaw_records_tab_created_at_idx
  on public.openclaw_records (tab, created_at);

create or replace function public.set_openclaw_records_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_openclaw_records_updated_at on public.openclaw_records;

create trigger set_openclaw_records_updated_at
before update on public.openclaw_records
for each row
execute function public.set_openclaw_records_updated_at();

alter table public.openclaw_records enable row level security;

drop policy if exists "service role can manage openclaw records" on public.openclaw_records;

create policy "service role can manage openclaw records"
on public.openclaw_records
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
