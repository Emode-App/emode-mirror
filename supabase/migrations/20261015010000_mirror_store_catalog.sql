-- A store's rack, from the catalog it already publishes. Applied 2026-10-15.
--
-- A retailer's products live in its own e-commerce platform, not in Emode, so
-- the rack is a copy of what the store publishes: a Google Shopping feed or a
-- Shopify store/collection (catalog_feed_url), and/or the listings of an
-- Emode Business account (owner_id). The mirror function refreshes the copy
-- every couple of hours while the store's mirrors are on, and on request from
-- the store's dashboard. Pieces that leave the catalog are switched off, not
-- deleted, so the dashboard can still name what was tried last month.
create table if not exists public.mirror_store_products (
    id uuid primary key default gen_random_uuid(),
    store_id uuid not null references public.mirror_stores(id) on delete cascade,
    source text not null check (source in ('feed', 'emode')),
    -- The retailer's own id for it (Shopify ids are prefixed "shopify:").
    external_id text not null check (char_length(external_id) between 1 and 200),
    name text not null check (char_length(name) between 1 and 300),
    brand text check (char_length(brand) <= 120),
    price numeric(12, 2),
    currency text check (char_length(currency) = 3),
    image_url text not null check (char_length(image_url) <= 2000),
    product_url text check (char_length(product_url) <= 2000),
    category text not null default 'other'
        check (category in ('tops', 'outerwear', 'bottoms', 'dresses', 'shoes', 'accessories', 'other')),
    is_active boolean not null default true,
    -- The order the catalog lists them in, which is the order the rack shows.
    position integer not null default 0,
    synced_at timestamptz not null default now(),
    unique (store_id, external_id)
);
create index if not exists mirror_store_products_rack_idx
    on public.mirror_store_products (store_id, is_active, position);
alter table public.mirror_store_products enable row level security;
revoke all on public.mirror_store_products from anon, authenticated;

alter table public.mirror_stores
    add column if not exists catalog_feed_url text check (char_length(catalog_feed_url) <= 2000),
    add column if not exists catalog_synced_at timestamptz,
    add column if not exists catalog_sync_started_at timestamptz,
    -- What the last refresh has to say: an error, or a note such as a feed
    -- too large to read whole. Null when there is nothing to say.
    add column if not exists catalog_sync_message text check (char_length(catalog_sync_message) <= 500);

-- Rack pieces now point at the store's copy of its catalog rather than at an
-- Emode listing directly; an Emode listing is one source of that copy.
alter table public.mirror_garments drop column if exists product_id;
alter table public.mirror_garments
    add column if not exists store_product_id uuid references public.mirror_store_products(id) on delete set null;

-- Dresses and jumpsuits are their own category; a retailer's rack is full of them.
alter table public.mirror_garments drop constraint if exists mirror_garments_category_check;
alter table public.mirror_garments
    add constraint mirror_garments_category_check
    check (category in ('tops', 'outerwear', 'bottoms', 'dresses', 'shoes', 'accessories', 'other'));
