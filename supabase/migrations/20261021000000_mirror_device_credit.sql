-- A credit line for one mirror. Applied 2026-10-21.
--
-- Shown on that mirror's start and result screens with a QR code to the
-- person's profile: {"name": "...", "title": "...", "url": "https://..." or
-- null}. Used for the workplace demo; null everywhere else.
alter table public.mirror_devices add column if not exists credit jsonb;
