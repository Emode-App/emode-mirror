// Register a new mirror screen.
//
//   node scripts/register-device.mjs "Store name — Luma 1" "Atlanta, GA"
//
// Prints the device key ONCE, plus the SQL that registers its hash. Run the SQL
// in the Supabase SQL editor (project scvvbjheyfnxlsiiozta), then set the
// screen's launch URL to:
//
//   https://<mirror host>/?device=<KEY>
//
// The key is never stored anywhere but that launch URL. Lose it and register
// the screen again; revoke one with:
//   update public.mirror_devices set active = false where name = '...';

import { createHash, randomBytes } from 'node:crypto';

const [name, location = ''] = process.argv.slice(2);
if (!name) {
    console.error('Usage: node scripts/register-device.mjs "<name>" "[location]"');
    process.exit(1);
}

const key = randomBytes(24).toString('base64url');
const hash = createHash('sha256').update(key).digest('hex');
const q = (s) => `'${s.replace(/'/g, "''")}'`;

console.log(`\nDevice key (shown once — put it in the screen's launch URL):\n\n  ${key}\n`);
console.log('SQL to register it:\n');
console.log(`insert into public.mirror_devices (name, location, key_hash)
values (${q(name)}, ${location ? q(location) : 'null'}, '${hash}');\n`);
