// Load Emode's house rack (scripts/house-rack.json) into the database.
//
//   node scripts/seed-house-rack.mjs > house-rack.sql
//
// Prints SQL to run in the Supabase SQL editor (project scvvbjheyfnxlsiiozta).
// Creates the house store if there isn't one, upserts every piece, and
// switches off pieces no longer in the list. Run it after the photos in
// public/rack are deployed, so the mirror never shows a missing picture.
//
// Each photo URL carries a fingerprint of the file, so replacing a photo at
// the same path shows the new one instead of a cached copy.

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const ORIGIN = process.env.MIRROR_ORIGIN || 'https://mirror.emode.style';
const root = new URL('..', import.meta.url);
const { items } = JSON.parse(readFileSync(new URL('scripts/house-rack.json', root), 'utf8'));
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

const rows = items.map((item, position) => {
    const file = new URL(`public/rack/${item.gender}/${item.key}.jpg`, root);
    const version = createHash('sha1').update(readFileSync(file)).digest('hex').slice(0, 10);
    const url = `${ORIGIN}/rack/${item.gender}/${item.key}.jpg?v=${version}`;
    return `(${q(`${item.gender}/${item.key}`)}, ${q(item.name)}, ${q(item.gender)}, ${q(item.category)}, ${q(url)}, ${position})`;
});

console.log(`-- Emode house rack: ${items.length} pieces
insert into public.mirror_stores (name, is_house, dashboard_token_hash)
select 'Emode', true, '${createHash('sha256').update(randomBytes(32)).digest('hex')}'
where not exists (select 1 from public.mirror_stores where is_house);

insert into public.mirror_store_products
    (store_id, source, external_id, name, gender, category, image_url, position, is_active, synced_at)
select h.id, 'house', v.external_id, v.name, v.gender, v.category, v.image_url, v.position, true, now()
from (select id from public.mirror_stores where is_house) h,
(values
    ${rows.join(',\n    ')}
) as v(external_id, name, gender, category, image_url, position)
on conflict (store_id, external_id) do update
    set name = excluded.name, gender = excluded.gender, category = excluded.category,
        image_url = excluded.image_url, position = excluded.position, is_active = true, synced_at = excluded.synced_at;

update public.mirror_store_products
   set is_active = false
 where store_id = (select id from public.mirror_stores where is_house)
   and external_id not in (${items.map((i) => q(`${i.gender}/${i.key}`)).join(', ')});`);
