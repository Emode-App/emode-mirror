-- Emode Mirror: a try-on kiosk running as a web app on Proto Luma devices,
-- paired with the visitor's phone by QR code.
--
-- Applied to the live Emode project (scvvbjheyfnxlsiiozta) on 2026-10-14.
-- Lives in this repo so the schema travels with the code that depends on it.
--
-- Nothing here is reachable from a client directly. Kiosks authenticate with a
-- per-device key and phones with a per-session upload token, both checked by
-- the `mirror` edge function, which is the only thing holding the service
-- role. Visitors are anonymous by design -- a walk-up kiosk should not mint an
-- auth.users row for everyone who tries on a jacket.

create extension if not exists pgcrypto;

-- One row per physical screen. The key is shown once at registration; only its
-- hash is kept, so a leaked database does not leak the ability to drive a kiosk.
create table if not exists public.mirror_devices (
    id uuid primary key default gen_random_uuid(),
    name text not null check (char_length(name) between 1 and 120),
    location text check (char_length(location) <= 200),
    proto_serial text unique check (char_length(proto_serial) <= 120),
    key_hash text not null unique,
    theme text not null default 'dark' check (theme in ('dark', 'light')),
    daily_look_limit integer not null default 200 check (daily_look_limit between 0 and 10000),
    active boolean not null default true,
    last_seen_at timestamptz,
    created_at timestamptz not null default now()
);

-- One visit. Short-lived on purpose: it holds a photograph of a member of the
-- public, and the default answer to "how long do we keep that" is "not long".
create table if not exists public.mirror_sessions (
    id uuid primary key default gen_random_uuid(),
    device_id uuid not null references public.mirror_devices(id) on delete cascade,
    upload_token_hash text not null,
    status text not null default 'active' check (status in ('active', 'ended')),
    person_path text,
    consent_at timestamptz not null,
    created_at timestamptz not null default now(),
    last_activity_at timestamptz not null default now(),
    ended_at timestamptz
);
create index if not exists mirror_sessions_device_idx on public.mirror_sessions (device_id, created_at desc);
create index if not exists mirror_sessions_sweep_idx on public.mirror_sessions (status, last_activity_at);

create table if not exists public.mirror_garments (
    id uuid primary key default gen_random_uuid(),
    session_id uuid not null references public.mirror_sessions(id) on delete cascade,
    source text not null check (source in ('upload', 'link')),
    image_path text not null,
    product_url text check (char_length(product_url) <= 2000),
    title text check (char_length(title) <= 300),
    created_at timestamptz not null default now()
);
create index if not exists mirror_garments_session_idx on public.mirror_garments (session_id, created_at);

create table if not exists public.mirror_looks (
    id uuid primary key default gen_random_uuid(),
    session_id uuid not null references public.mirror_sessions(id) on delete cascade,
    device_id uuid not null references public.mirror_devices(id) on delete cascade,
    garment_ids uuid[] not null,
    status text not null default 'pending' check (status in ('pending', 'succeeded', 'failed')),
    image_path text,
    error text check (char_length(error) <= 500),
    created_at timestamptz not null default now(),
    completed_at timestamptz
);
create index if not exists mirror_looks_session_idx on public.mirror_looks (session_id, created_at);
create index if not exists mirror_looks_device_day_idx on public.mirror_looks (device_id, created_at);

alter table public.mirror_devices enable row level security;
alter table public.mirror_sessions enable row level security;
alter table public.mirror_garments enable row level security;
alter table public.mirror_looks enable row level security;

-- RLS with no policies already denies, but this schema grants every new public
-- table to anon and authenticated, so take the grants away too rather than
-- leaving one forgotten policy between a visitor's photo and the internet.
revoke all on public.mirror_devices, public.mirror_sessions, public.mirror_garments, public.mirror_looks
    from anon, authenticated;

-- Retailer interest from emode.style/mirror/business. Write-only from the
-- website: anyone may submit, nobody but the service role may read it back.
create table if not exists public.mirror_inquiries (
    id uuid primary key default gen_random_uuid(),
    business_name text not null check (char_length(business_name) between 1 and 200),
    contact_name text not null check (char_length(contact_name) between 1 and 200),
    email text not null check (char_length(email) between 3 and 320 and email like '%@%'),
    phone text check (char_length(phone) <= 40),
    industry text check (char_length(industry) <= 100),
    device_count integer check (device_count between 0 and 100000),
    proto_model text check (char_length(proto_model) <= 100),
    use_case text check (char_length(use_case) <= 4000),
    wants_demo boolean not null default false,
    source text check (char_length(source) <= 100),
    created_at timestamptz not null default now()
);
alter table public.mirror_inquiries enable row level security;
revoke all on public.mirror_inquiries from anon, authenticated;
grant insert on public.mirror_inquiries to anon, authenticated;
drop policy if exists "Anyone can submit an inquiry" on public.mirror_inquiries;
create policy "Anyone can submit an inquiry"
    on public.mirror_inquiries for insert to anon, authenticated
    with check (true);

-- Private bucket for session media. Every read goes through a signed URL the
-- edge function mints for the kiosk or the paired phone.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('mirror', 'mirror', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
