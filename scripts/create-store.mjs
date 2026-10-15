// Set up a store for Emode Mirror.
//
//   node scripts/create-store.mjs "Store name" [--feed URL] [--owner @emodehandle] [--logo https://…/logo.png]
//
// Prints the store's private dashboard link ONCE, plus the SQL to run in the
// Supabase SQL editor (project scvvbjheyfnxlsiiozta). Then register each of
// its screens with:
//
//   node scripts/register-device.mjs "Store name — Front window" "City, ST" --store <store id>
//
// The rack -- what shoppers can try on without a phone -- comes from either
// or both of:
//
//   --feed   the retailer's own catalog: its Google Shopping feed URL, or a
//            link to its Shopify store or one collection ("/collections/mirror"
//            to show only what's on this floor). The store can also set or
//            change this itself from its dashboard.
//   --owner  an Emode Business account, whose active listings join the rack.
//
// Leave both off and the mirror works without a rack (shoppers bring their own
// pieces). The rack fills the first time one of the store's mirrors switches
// on, or straight away from "Update now" on the dashboard.

import { createHash, randomBytes, randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const name = args[0];
const flag = (f) => {
    const i = args.indexOf(f);
    return i > -1 ? args[i + 1] : null;
};
if (!name || name.startsWith('--')) {
    console.error('Usage: node scripts/create-store.mjs "Store name" [--feed url] [--owner @handle] [--logo url]');
    process.exit(1);
}

const owner = flag('--owner');
const logo = flag('--logo');
const feed = flag('--feed');
if (feed && !/^https?:\/\//i.test(feed)) {
    console.error('--feed must be an http(s) link');
    process.exit(1);
}
const id = randomUUID();
const token = randomBytes(24).toString('base64url');
const hash = createHash('sha256').update(token).digest('hex');
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const handle = owner ? (owner.startsWith('@') ? owner : `@${owner}`) : null;

console.log(`\nDashboard link (shown once — this is what you send the store):\n\n  https://mirror.emode.style/store/${id}#${token}\n`);
console.log('SQL:\n');
console.log(`insert into public.mirror_stores (id, name, logo_url, owner_id, catalog_feed_url, dashboard_token_hash)
values (${q(id)}, ${q(name)}, ${logo ? q(logo) : 'null'}, ${handle ? `(select id from public.users where handle = ${q(handle)})` : 'null'}, ${feed ? q(feed) : 'null'}, '${hash}');\n`);
console.log(`Store id: ${id}\n`);
