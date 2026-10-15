-- The phone as a second camera button. Applied 2026-10-15.
--
-- The shopper can take their photo from the mirror's own button (with time to
-- step back) or, already standing back, from the phone that scanned the code.
-- The mirror says when its camera is waiting; the phone can only press the
-- button then; the mirror consumes each press once. The photo itself never
-- leaves the mirror until the shopper confirms it there.
alter table public.mirror_sessions
    add column if not exists camera_open_at timestamptz,
    add column if not exists shutter_at timestamptz;
