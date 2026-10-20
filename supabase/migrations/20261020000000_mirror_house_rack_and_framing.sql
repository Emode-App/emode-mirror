-- Emode's own rack, and per-mirror framing. Applied 2026-10-20.
--
-- The house rack: quick picks (suits, tops, bottoms, shoes; men's and
-- women's) that any mirror without a store rack offers under its QR code, so
-- people can build a fit without their phone. It is an ordinary store row
-- flagged is_house, so it reuses the rack machinery; its pieces come from
-- scripts/house-rack.json via scripts/seed-house-rack.mjs.
alter table public.mirror_stores add column if not exists is_house boolean not null default false;
create unique index if not exists mirror_stores_one_house on public.mirror_stores (is_house) where is_house;

alter table public.mirror_store_products add column if not exists gender text check (gender in ('women', 'men'));
alter table public.mirror_store_products drop constraint if exists mirror_store_products_source_check;
alter table public.mirror_store_products
    add constraint mirror_store_products_source_check check (source in ('feed', 'emode', 'house'));

-- Suits are their own category: a full look in one piece.
alter table public.mirror_store_products drop constraint if exists mirror_store_products_category_check;
alter table public.mirror_store_products
    add constraint mirror_store_products_category_check
    check (category in ('suits', 'tops', 'outerwear', 'bottoms', 'dresses', 'shoes', 'accessories', 'other'));
alter table public.mirror_garments drop constraint if exists mirror_garments_category_check;
alter table public.mirror_garments
    add constraint mirror_garments_category_check
    check (category in ('suits', 'tops', 'outerwear', 'bottoms', 'dresses', 'shoes', 'accessories', 'other'));

-- How far the photo screen zooms in, and where, for this mirror's camera:
-- {"zoom": 1-4, "cx": 0-1, "cy": 0-1}, the centre of the zoomed view in the
-- (mirrored) preview. A wide camera mounted high on a tall screen sees a lot
-- of ceiling; this crops to where people stand. Set from /calibrate.
alter table public.mirror_devices add column if not exists framing jsonb;
