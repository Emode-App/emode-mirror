// End-to-end check of the store side: branding, the rack, and the dashboard.
//
//   node scripts/smoke-store.mjs              # API checks, no AI call
//   node scripts/smoke-store.mjs --generate   # + one real look from a rack piece
//
// Uses DEV_DEVICE_KEY and TEST_STORE_DASHBOARD_URL from .devices.local. The Dev
// laptop mirror belongs to the test store, whose rack is a real Emode Business
// account's listings.

import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const FN = process.env.MIRROR_API_URL || 'https://scvvbjheyfnxlsiiozta.supabase.co/functions/v1/mirror';
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'sb_publishable_xBWtFjEoKrG4wCSzGVkigw_A-i0UfJi';

const local = (() => {
    try {
        return Object.fromEntries(readFileSync(new URL('../.devices.local', import.meta.url), 'utf8')
            .split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
    } catch {
        return {};
    }
})();
const key = process.env.DEV_DEVICE_KEY || local.DEV_DEVICE_KEY;
const dashUrl = process.env.TEST_STORE_DASHBOARD_URL || local.TEST_STORE_DASHBOARD_URL;
if (!key || !dashUrl) {
    console.error('Needs DEV_DEVICE_KEY and TEST_STORE_DASHBOARD_URL in .devices.local');
    process.exit(1);
}
const storeId = dashUrl.match(/\/store\/([0-9a-f-]{36})/)[1];
const dashToken = dashUrl.split('#')[1];

async function call(body, deviceKey) {
    const res = await fetch(FN, {
        method: 'POST',
        headers: {
            'content-type': 'application/json', apikey: ANON, authorization: `Bearer ${ANON}`,
            ...(deviceKey ? { 'x-mirror-device-key': deviceKey } : {}),
        },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

let failures = 0;
const check = (label, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined && detail !== '' ? `  — ${detail}` : ''}`);
    if (!ok) failures++;
};

/** A grey mannequin, drawn here, so no real person is involved. */
function mannequinPng(w = 540, h = 960) {
    const px = Buffer.alloc((w * 4 + 1) * h);
    const inE = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const body = inE(x, y, w / 2, h * 0.12, w * 0.08, h * 0.06)
                || inE(x, y, w / 2, h * 0.36, w * 0.17, h * 0.15)
                || (y > h * 0.25 && y < h * 0.55 && Math.abs(Math.abs(x - w / 2) - w * 0.21) < w * 0.035)
                || (y > h * 0.48 && y < h * 0.92 && Math.abs(Math.abs(x - w / 2) - w * 0.07) < w * 0.05);
            const v = body ? 120 : 236;
            const i = y * (w * 4 + 1) + 1 + x * 4;
            px[i] = v; px[i + 1] = v; px[i + 2] = v; px[i + 3] = 255;
        }
    }
    const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (b) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type), data]);
        const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
        return Buffer.concat([len, td, c]);
    };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    return 'data:image/png;base64,' + Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr), chunk('IDAT', deflateSync(px)), chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64');
}

const hello = await call({ action: 'device.hello' }, key);
check('the mirror knows its store', hello.body?.store?.name === 'Emode Test Store', hello.body?.store?.name);
check('the store has a rack', hello.body?.store?.hasRack === true);

const rack = await call({ action: 'catalog.list' }, key);
const items = rack.body?.items || [];
check('the rack lists the store’s live listings', rack.status === 200 && items.length > 0, `${items.length} piece(s)`);
check('rack pieces carry a photo', items.every((i) => i.imageUrl));

const start = await call({ action: 'session.start', consent: true, adult: true }, key);
const sessionId = start.body?.sessionId;

const add = await call({ action: 'garment.from_catalog', sessionId, productId: items[0]?.id }, key);
check('a rack piece goes on the mirror without a phone', add.status === 200 && !!add.body?.garmentId, add.body?.error);
const again = await call({ action: 'garment.from_catalog', sessionId, productId: items[0]?.id }, key);
check('picking it twice does not duplicate it', again.body?.garmentId === add.body?.garmentId);
const stranger = await call({ action: 'garment.from_catalog', sessionId, productId: '00000000-0000-4000-8000-000000000000' }, key);
check('a product that isn’t this store’s is refused', stranger.status === 404);

const state = await call({ action: 'session.state', sessionId }, key);
const g = state.body?.garments?.find((x) => x.id === add.body?.garmentId);
check('the piece is recorded against its listing', g?.source === 'catalog' && g?.productId === items[0]?.id, g?.title);

if (process.argv.includes('--generate')) {
    await call({ action: 'session.capture', sessionId, image: mannequinPng() }, key);
    const gen = await call({ action: 'look.generate', sessionId, garmentIds: [add.body.garmentId] }, key);
    const t0 = Date.now();
    let look;
    while (Date.now() - t0 < 180_000) {
        await new Promise((r) => setTimeout(r, 3000));
        const s = await call({ action: 'session.state', sessionId }, key);
        look = s.body?.looks?.find((l) => l.id === gen.body?.lookId);
        if (look && look.status !== 'pending') break;
    }
    check(`a look from a rack piece (${Math.round((Date.now() - t0) / 1000)}s)`, look?.status === 'succeeded', look?.error);
}

await call({ action: 'session.end', sessionId, reason: 'finish' }, key);
// Events are written without waiting; give the last ones a moment to land.
await new Promise((r) => setTimeout(r, 1500));

const bad = await call({ action: 'store.dashboard', storeId, token: 'x'.repeat(32) });
check('the dashboard refuses a wrong link', bad.status === 404, bad.body?.code);

const dash = await call({ action: 'store.dashboard', storeId, token: dashToken, days: 7 });
const d = dash.body;
check('the dashboard opens with its link', dash.status === 200, d?.store?.name);
check('it counts visits', d?.totals?.visits >= 1, `${d?.totals?.visits} visits, ${d?.totals?.looks} looks`);
check('it lists the store’s mirrors', d?.mirrors?.length >= 1, d?.mirrors?.map((m) => `${m.name} (${m.online ? 'online' : 'offline'})`).join(', '));
check('it has a day-by-day series', d?.daily?.length === 7);
if (process.argv.includes('--generate')) {
    check('the rack piece shows as tried', d?.topRack?.some((p) => p.id === items[0]?.id), d?.topRack?.[0] && `${d.topRack[0].name} × ${d.topRack[0].tries}`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
