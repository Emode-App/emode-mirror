-- Emode Mirror, part two: members bring their wardrobe, and the mirror counts
-- what happens in front of it. Applied to the live project 2026-10-14.

-- A visit may be claimed by an Emode account, from the app, by someone holding
-- both that visit's QR token and a signed-in session. Optional: a guest visit
-- never has one. Deleting the account unlinks rather than deleting the visit.
alter table public.mirror_sessions
    add column if not exists user_id uuid references auth.users(id) on delete set null,
    add column if not exists linked_at timestamptz,
    -- When a phone first touched this visit. Set once, so pairing is counted once.
    add column if not exists phone_seen_at timestamptz;

-- Pieces can now come from an Emode wardrobe, and carry a category so the
-- mirror can group them the way the app's wardrobe already does.
alter table public.mirror_garments drop constraint if exists mirror_garments_source_check;
alter table public.mirror_garments
    add constraint mirror_garments_source_check check (source in ('upload', 'link', 'wardrobe'));
alter table public.mirror_garments
    add column if not exists category text
        check (category in ('tops', 'outerwear', 'bottoms', 'shoes', 'accessories', 'other'));

-- What happened at each mirror, for the funnel and for retailers.
--
-- Deliberately free of people: no photos, no account ids, no tokens. A visit's
-- rows outlive the visit with their session_id cleared, so a store can still
-- see how many looks it served last month after every photo is long gone.
create table if not exists public.mirror_events (
    id bigint generated always as identity primary key,
    device_id uuid not null references public.mirror_devices(id) on delete cascade,
    session_id uuid references public.mirror_sessions(id) on delete set null,
    type text not null check (type in (
        'visit_started', 'phone_paired', 'garment_added', 'look_generated', 'look_failed',
        'visit_ended', 'product_link_opened', 'app_cta_tapped', 'account_linked',
        'wardrobe_sent', 'look_saved_to_account'
    )),
    meta jsonb not null default '{}'::jsonb check (pg_column_size(meta) < 2048),
    created_at timestamptz not null default now()
);
create index if not exists mirror_events_device_time_idx on public.mirror_events (device_id, created_at desc);
create index if not exists mirror_events_type_time_idx on public.mirror_events (type, created_at desc);
alter table public.mirror_events enable row level security;
revoke all on public.mirror_events from anon, authenticated;

-- A look saved from the mirror lands in the app's own try-on history. It has no
-- marketplace products behind it, so the pieces travel with it: name and shop
-- link only, never the visitor's photo.
alter table public.dressing_room_outfits
    add column if not exists source text not null default 'dressing_room'
        check (source in ('dressing_room', 'mirror')),
    add column if not exists mirror_pieces jsonb
        check (mirror_pieces is null or jsonb_typeof(mirror_pieces) = 'array');
