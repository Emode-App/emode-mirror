-- Record why Live failed to start, so a failure on a mirror can be diagnosed
-- from here instead of guessed at. Applied 2026-10-21.
alter table public.mirror_events drop constraint if exists mirror_events_type_check;
alter table public.mirror_events
    add constraint mirror_events_type_check check (type in (
        'visit_started', 'phone_paired', 'garment_added', 'look_generated', 'look_failed',
        'visit_ended', 'product_link_opened', 'app_cta_tapped', 'account_linked',
        'wardrobe_sent', 'look_saved_to_account', 'live_started', 'live_ended', 'live_failed'
    ));
