-- Pictures snapped from Live. Applied 2026-10-21.
--
-- A snap is a frame of the live, dressed video, saved as a look of the visit
-- so it goes home on the phone like any other. Looks now say where they came
-- from; snaps cost no generation, so they don't count toward the mirror's
-- daily look limit.
alter table public.mirror_looks
    add column if not exists source text not null default 'photo' check (source in ('photo', 'live'));

alter table public.mirror_events drop constraint if exists mirror_events_type_check;
alter table public.mirror_events
    add constraint mirror_events_type_check check (type in (
        'visit_started', 'phone_paired', 'garment_added', 'look_generated', 'look_failed',
        'visit_ended', 'product_link_opened', 'app_cta_tapped', 'account_linked',
        'wardrobe_sent', 'look_saved_to_account', 'live_started', 'live_ended', 'live_failed',
        'live_snapshot'
    ));
