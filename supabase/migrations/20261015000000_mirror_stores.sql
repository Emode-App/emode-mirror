-- Emode Mirror for stores. Applied 2026-10-15.
--
-- A store owns its mirrors (one per location or per screen), its branding on
-- them, and a private dashboard link. Its rack -- the pieces a shopper can
-- try on without a phone -- is the active listings of the Emode Business
-- account behind it. owner_id is optional: a store without one has no rack.
create table if not exists public.mirror_stores (
    id uuid primary key default gen_random_uuid(),
    name text not null check (char_length(name) between 1 and 120),
    logo_url text check (char_length(logo_url) <= 2000),
    owner_id uuid references public.users(id) on delete set null,
    -- Reached by a private link, like a device's launch URL; only the hash is kept.
    dashboard_token_hash text not null unique,
    created_at timestamptz not null default now()
);
alter table public.mirror_stores enable row level security;
revoke all on public.mirror_stores from anon, authenticated;

alter table public.mirror_devices
    add column if not exists store_id uuid references public.mirror_stores(id) on delete set null;
create index if not exists mirror_devices_store_idx on public.mirror_devices (store_id);

-- Rack pieces are recorded against the listing they came from, which is what
-- lets a store see which of its own pieces get tried on.
alter table public.mirror_garments drop constraint if exists mirror_garments_source_check;
alter table public.mirror_garments
    add constraint mirror_garments_source_check check (source in ('upload', 'link', 'wardrobe', 'catalog'));
alter table public.mirror_garments
    add column if not exists product_id uuid references public.products(id) on delete set null;
