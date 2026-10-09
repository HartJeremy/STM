-- Stage Manager Workspace - Supabase schema v0.6
-- Run this once in Supabase -> SQL Editor.
-- The browser app uses only the publishable key. Never expose a secret/service_role key.

create extension if not exists pgcrypto;

create table if not exists public.app_health (
  id uuid primary key default gen_random_uuid(),
  message text not null default 'Stage Manager database ready',
  created_at timestamptz not null default now()
);

alter table public.app_health enable row level security;
drop policy if exists "app health readable" on public.app_health;
create policy "app health readable" on public.app_health for select to anon, authenticated using (true);

insert into public.app_health (message)
select 'Stage Manager database ready'
where not exists (select 1 from public.app_health);

create table if not exists public.workspaces (
  id uuid primary key,
  name text not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'stage_manager' check (role in ('admin','stage_manager','crew','read_only')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create or replace function public.is_workspace_member(wid uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = wid and m.user_id = auth.uid()
  );
$$;

create or replace function public.add_workspace_owner_membership()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.workspace_members(workspace_id,user_id,role)
  values(new.id,new.owner_id,'admin')
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists trg_workspace_owner_membership on public.workspaces;
create trigger trg_workspace_owner_membership
after insert on public.workspaces
for each row execute function public.add_workspace_owner_membership();

create table if not exists public.productions (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  title text not null,
  company text,
  start_date date,
  end_date date,
  status text not null default 'active',
  data_authority text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.people (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  notes text,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.production_people (
  id uuid primary key,
  production_id uuid not null references public.productions(id) on delete cascade,
  person_id uuid references public.people(id) on delete set null,
  name_snapshot text not null,
  role text,
  group_name text,
  active boolean not null default true,
  notes text,
  updated_at timestamptz not null default now()
);

create table if not exists public.acts (
  id uuid primary key,
  production_id uuid not null references public.productions(id) on delete cascade,
  name text not null,
  sort_order integer not null default 1,
  notes text,
  updated_at timestamptz not null default now()
);

create table if not exists public.production_locations (
  id uuid primary key,
  production_id uuid not null references public.productions(id) on delete cascade,
  name text not null,
  sort_order integer not null default 1,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.storage_locations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  parent_id uuid references public.storage_locations(id) on delete set null,
  name text not null,
  notes text,
  updated_at timestamptz not null default now()
);

create table if not exists public.assets (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  asset_number text,
  name text not null,
  aliases text[] not null default '{}',
  category text not null default 'prop',
  tracking_mode text not null default 'unique' check (tracking_mode in ('unique','bulk')),
  quantity integer not null default 1 check (quantity > 0),
  storage_location_id uuid references public.storage_locations(id) on delete set null,
  notes text,
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  unique(workspace_id, asset_number)
);

create table if not exists public.production_assets (
  id uuid primary key,
  production_id uuid not null references public.productions(id) on delete cascade,
  asset_id uuid references public.assets(id) on delete set null,
  display_name text not null,
  notes text,
  ready boolean not null default false,
  needs_review boolean not null default false,
  source_page text,
  source_row text,
  updated_at timestamptz not null default now()
);

create table if not exists public.prop_usages (
  id uuid primary key,
  production_id uuid not null references public.productions(id) on delete cascade,
  production_asset_id uuid references public.production_assets(id) on delete set null,
  act_id uuid references public.acts(id) on delete set null,
  scene text,
  page text,
  person_id uuid references public.people(id) on delete set null,
  person_label text,
  from_location_id uuid references public.production_locations(id) on delete set null,
  to_location_id uuid references public.production_locations(id) on delete set null,
  from_label text,
  to_label text,
  cue text,
  action text,
  notes text,
  sort_order integer not null default 1,
  needs_review boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.presets (
  id uuid primary key,
  production_id uuid not null references public.productions(id) on delete cascade,
  act_id uuid references public.acts(id) on delete cascade,
  location_id uuid references public.production_locations(id) on delete set null,
  production_asset_id uuid references public.production_assets(id) on delete set null,
  item text not null,
  critical boolean not null default false,
  notes text,
  kind text,
  source text,
  updated_at timestamptz not null default now()
);

create table if not exists public.asset_reservations (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  asset_id uuid not null references public.assets(id) on delete cascade,
  production_id uuid not null references public.productions(id) on delete cascade,
  production_asset_id uuid references public.production_assets(id) on delete set null,
  quantity integer not null default 1 check (quantity > 0),
  start_date date,
  end_date date,
  notes text,
  updated_at timestamptz not null default now()
);

create table if not exists public.calls (
  id uuid primary key default gen_random_uuid(),
  production_id uuid not null references public.productions(id) on delete cascade,
  call_date date not null,
  call_time time,
  call_type text not null default 'rehearsal',
  title text,
  notes text,
  updated_at timestamptz not null default now()
);

create table if not exists public.attendance (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.calls(id) on delete cascade,
  production_person_id uuid not null references public.production_people(id) on delete cascade,
  status text not null default 'waiting',
  updated_at timestamptz not null default now(),
  unique(call_id, production_person_id)
);

create table if not exists public.production_images (
  id uuid primary key,
  production_id uuid not null references public.productions(id) on delete cascade,
  act_id uuid references public.acts(id) on delete cascade,
  label text,
  source text,
  storage_path text,
  hidden boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.preset_area_photos (
  id uuid primary key,
  production_id uuid not null references public.productions(id) on delete cascade,
  act_id uuid references public.acts(id) on delete cascade,
  location_id uuid references public.production_locations(id) on delete cascade,
  image_ids uuid[] not null default '{}',
  updated_at timestamptz not null default now()
);

-- RLS
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.productions enable row level security;
alter table public.people enable row level security;
alter table public.production_people enable row level security;
alter table public.acts enable row level security;
alter table public.production_locations enable row level security;
alter table public.storage_locations enable row level security;
alter table public.assets enable row level security;
alter table public.production_assets enable row level security;
alter table public.prop_usages enable row level security;
alter table public.presets enable row level security;
alter table public.asset_reservations enable row level security;
alter table public.calls enable row level security;
alter table public.attendance enable row level security;
alter table public.production_images enable row level security;
alter table public.preset_area_photos enable row level security;

-- Workspace policies
 drop policy if exists "workspace select" on public.workspaces;
create policy "workspace select" on public.workspaces for select to authenticated using (public.is_workspace_member(id) or owner_id=auth.uid());
drop policy if exists "workspace insert" on public.workspaces;
create policy "workspace insert" on public.workspaces for insert to authenticated with check (owner_id=auth.uid());
drop policy if exists "workspace update" on public.workspaces;
create policy "workspace update" on public.workspaces for update to authenticated using (public.is_workspace_member(id) or owner_id=auth.uid()) with check (public.is_workspace_member(id) or owner_id=auth.uid());

drop policy if exists "members select" on public.workspace_members;
create policy "members select" on public.workspace_members for select to authenticated using (user_id=auth.uid() or public.is_workspace_member(workspace_id));

-- Helper policies for direct workspace tables
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['people','storage_locations','assets','asset_reservations'] LOOP
    EXECUTE format('drop policy if exists "workspace member all" on public.%I', t);
    EXECUTE format('create policy "workspace member all" on public.%I for all to authenticated using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id))', t);
  END LOOP;
END $$;

-- Production-scoped tables
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['productions'] LOOP
    EXECUTE format('drop policy if exists "production workspace member all" on public.%I', t);
    EXECUTE format('create policy "production workspace member all" on public.%I for all to authenticated using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id))', t);
  END LOOP;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['production_people','acts','production_locations','production_assets','prop_usages','presets','calls','production_images','preset_area_photos'] LOOP
    EXECUTE format('drop policy if exists "production member all" on public.%I', t);
    EXECUTE format('create policy "production member all" on public.%I for all to authenticated using (exists (select 1 from public.productions p where p.id = %I.production_id and public.is_workspace_member(p.workspace_id))) with check (exists (select 1 from public.productions p where p.id = %I.production_id and public.is_workspace_member(p.workspace_id)))', t, t, t);
  END LOOP;
END $$;

-- Attendance is scoped through its call -> production -> workspace.
drop policy if exists "attendance production member all" on public.attendance;
create policy "attendance production member all" on public.attendance for all to authenticated
using (exists (
  select 1 from public.calls c join public.productions p on p.id=c.production_id
  where c.id=attendance.call_id and public.is_workspace_member(p.workspace_id)
))
with check (exists (
  select 1 from public.calls c join public.productions p on p.id=c.production_id
  where c.id=attendance.call_id and public.is_workspace_member(p.workspace_id)
));

-- Helpful indexes for universal prop search / lookups.
create index if not exists idx_assets_workspace_name on public.assets(workspace_id, name);
create index if not exists idx_production_assets_prod_name on public.production_assets(production_id, display_name);
create index if not exists idx_prop_usages_prod_page on public.prop_usages(production_id, page);
create index if not exists idx_prop_usages_person on public.prop_usages(person_id);
create index if not exists idx_reservations_asset_dates on public.asset_reservations(asset_id, start_date, end_date);
