-- Live try-on (Decart Lucy VTON) and garment descriptions. Applied 2026-10-21.
--
-- Live mode dresses the shopper in the camera's live video. It is driven by
-- a text description of each piece as well as its photo, so pieces carry a
-- short description: from the catalog for rack pieces, from the classifier
-- for screenshots and links. Live time is counted for cost.
alter table public.mirror_store_products
    add column if not exists description text check (char_length(description) <= 600);
alter table public.mirror_garments
    add column if not exists description text check (char_length(description) <= 600);

alter table public.mirror_events drop constraint if exists mirror_events_type_check;
alter table public.mirror_events
    add constraint mirror_events_type_check check (type in (
        'visit_started', 'phone_paired', 'garment_added', 'look_generated', 'look_failed',
        'visit_ended', 'product_link_opened', 'app_cta_tapped', 'account_linked',
        'wardrobe_sent', 'look_saved_to_account', 'live_started', 'live_ended'
    ));
