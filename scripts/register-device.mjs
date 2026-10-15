// Register a new mirror screen.
//
//   node scripts/register-device.mjs "Store name — Front window" "Atlanta, GA" [--store <store id>]
//
// Prints the device key ONCE, plus the SQL that registers its hash. Run the SQL
// in the Supabase SQL editor (project scvvbjheyfnxlsiiozta), then open the
// screen's launch URL on it:
//
//   https://mirror.emode.style/?device=<KEY>
//
// On a Proto Luma that is the app's launch URL in the Proto App Launcher. On
// any other screen it is the page a kiosk browser opens at start-up (see
// "Other screens" in the README).
//
// --store attaches the screen to a store (scripts/create-store.mjs): it then
// shows that store's name and rack, and counts on that store's dashboard.
//
// The key is never stored anywhere but that launch URL. Lose it and register
// the screen again; revoke one with:
//   update public.mirror_devices set active = false where name = '...';

import { createHash, randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const storeAt = args.indexOf('--store');
const store = storeAt > -1 ? args[storeAt + 1] : null;
const [name, location = ''] = args.filter((_, i) => storeAt === -1 || (i !== storeAt && i !== storeAt + 1));
if (!name) {
    console.error('Usage: node scripts/register-device.mjs "<name>" "[location]" [--store <store id>]');
    process.exit(1);
}
if (store && !/^[0-9a-f-]{36}$/i.test(store)) {
    console.error('--store must be a store id (printed by create-store.mjs)');
    process.exit(1);
}

const key = randomBytes(24).toString('base64url');
const hash = createHash('sha256').update(key).digest('hex');
const q = (s) => `'${s.replace(/'/g, "''")}'`;

console.log(`\nDevice key (shown once — put it in the screen's launch URL):\n\n  ${key}\n`);
console.log(`Launch URL:\n\n  https://mirror.emode.style/?device=${key}\n`);
console.log('SQL to register it:\n');
console.log(`insert into public.mirror_devices (name, location, key_hash, store_id)
values (${q(name)}, ${location ? q(location) : 'null'}, '${hash}', ${store ? q(store) : 'null'});\n`);
