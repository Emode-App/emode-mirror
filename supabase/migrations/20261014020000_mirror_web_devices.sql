-- The mirror, from emode.style, on anyone's own laptop or phone. Applied 2026-10-14.
--
-- A kiosk's key is a secret in a launch URL on one screen. A web mirror's key
-- ships to every browser that opens the page, so it proves nothing about who
-- is calling. Web devices are therefore limited per visitor, by a salted hash
-- of their network address, on top of the device's own daily cap.
alter table public.mirror_devices
    add column if not exists kind text not null default 'kiosk' check (kind in ('kiosk', 'web'));

-- Only ever set for web visits, and deleted with the visit like everything else.
alter table public.mirror_sessions
    add column if not exists client_hash text;
create index if not exists mirror_sessions_client_idx
    on public.mirror_sessions (client_hash, created_at desc) where client_hash is not null;
