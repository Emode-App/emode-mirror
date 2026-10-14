// End-to-end check of the mirror API, without a kiosk or a phone.
//
//   node scripts/smoke.mjs                       # uses DEV_DEVICE_KEY from .devices.local
//   node scripts/smoke.mjs --link <url>          # also tries importing a product link
//   node scripts/smoke.mjs --link <url> --generate
//                                                # also runs one real generation (costs one image call)
//
// It starts a visit, adds a garment the way a phone would, reads the visit
// back the way the kiosk would, and ends it. --generate exercises the model
// path with a drawn grey mannequin rather than anyone's photograph: it proves
// the plumbing, not the quality. Quality gets judged on the mirror, by a
// person who has agreed to be the test.

import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

/** A PNG of a flat grey mannequin silhouette, drawn here so no real person is involved. */
function mannequinPng(w = 540, h = 960) {
    const px = Buffer.alloc((w * 4 + 1) * h);
    const inEllipse = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
    for (let y = 0; y < h; y++) {
        px[y * (w * 4 + 1)] = 0;
        for (let x = 0; x < w; x++) {
            const body = inEllipse(x, y, w / 2, h * 0.12, w * 0.08, h * 0.06)          // head
                || (y > h * 0.18 && y < h * 0.22 && Math.abs(x - w / 2) < w * 0.03)    // neck
                || inEllipse(x, y, w / 2, h * 0.36, w * 0.17, h * 0.15)               // torso
                || (y > h * 0.25 && y < h * 0.55 && Math.abs(Math.abs(x - w / 2) - w * 0.21) < w * 0.035) // arms
                || (y > h * 0.48 && y < h * 0.92 && Math.abs(Math.abs(x - w / 2) - w * 0.07) < w * 0.05); // legs
            const v = body ? 120 : 236;
            const i = y * (w * 4 + 1) + 1 + x * 4;
            px[i] = v; px[i + 1] = v; px[i + 2] = v; px[i + 3] = 255;
        }
    }
    const crcTable = Array.from({ length: 256 }, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    const crc = (buf) => {
        let c = 0xffffffff;
        for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type), data]);
        const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
        return Buffer.concat([len, td, c]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr), chunk('IDAT', deflateSync(px)), chunk('IEND', Buffer.alloc(0)),
    ]);
    return 'data:image/png;base64,' + png.toString('base64');
}

const FN = process.env.MIRROR_API_URL
    || 'https://scvvbjheyfnxlsiiozta.supabase.co/functions/v1/mirror';
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'sb_publishable_xBWtFjEoKrG4wCSzGVkigw_A-i0UfJi';

function deviceKey() {
    if (process.env.DEV_DEVICE_KEY) return process.env.DEV_DEVICE_KEY;
    try {
        const line = readFileSync(new URL('../.devices.local', import.meta.url), 'utf8')
            .split('\n').find((l) => l.startsWith('DEV_DEVICE_KEY='));
        return line?.split('=')[1]?.trim();
    } catch {
        return undefined;
    }
}

async function call(body, key) {
    const res = await fetch(FN, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            apikey: ANON,
            authorization: `Bearer ${ANON}`,
            ...(key ? { 'x-mirror-device-key': key } : {}),
        },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

let failures = 0;
function check(label, ok, detail) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    if (!ok) failures++;
}

const key = deviceKey();
if (!key) {
    console.error('No device key. Put DEV_DEVICE_KEY in .devices.local or the environment.');
    process.exit(1);
}
// --link may be given more than once.
const productLinks = process.argv.flatMap((a, i) => (a === '--link' && process.argv[i + 1] ? [process.argv[i + 1]] : []));

// A 1x1 PNG: the smallest real image, so the upload path is exercised without
// sending anyone's actual photo anywhere.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const hello = await call({ action: 'device.hello' }, key);
check('device.hello with a real key', hello.status === 200, hello.body?.device?.name);

const stranger = await call({ action: 'device.hello' }, 'not-a-real-device-key-at-all-000');
check('device.hello with a wrong key is refused', stranger.status === 401);

const noConsent = await call({ action: 'session.start' }, key);
check('session.start without consent is refused', noConsent.status === 400, noConsent.body?.code);

const start = await call({ action: 'session.start', consent: true, adult: true }, key);
check('session.start with consent', start.status === 200 && !!start.body?.token);
const { sessionId, token } = start.body || {};

const wrongToken = await call({ action: 'phone.state', sessionId, token: 'x'.repeat(43) });
check('phone with the wrong token is refused', wrongToken.status === 404);

const upload = await call({ action: 'garment.upload', sessionId, token, image: PNG, title: 'Smoke test square' });
check('phone uploads a garment', upload.status === 200, upload.body?.error);

const notImage = await call({ action: 'garment.upload', sessionId, token, image: 'data:image/png;base64,' + Buffer.from('<?php evil ?>').toString('base64') });
check('a non-image disguised as a PNG is refused', notImage.status === 415);

const ssrf = await call({ action: 'garment.link', sessionId, token, url: 'http://169.254.169.254/latest/meta-data/' });
check('a link to a private address is refused', ssrf.status === 400, ssrf.body?.error);

for (const productLink of productLinks) {
    const link = await call({ action: 'garment.link', sessionId, token, url: productLink });
    check(`product link imports (${new URL(productLink).hostname})`, link.status === 200, link.body?.title || link.body?.error);
}

const state = await call({ action: 'session.state', sessionId }, key);
const garments = state.body?.garments || [];
check('kiosk sees the garments', state.status === 200 && garments.length >= 1, `${garments.length} garment(s)`);
check('garment images are signed URLs', garments.every((g) => g.imageUrl?.includes('/object/sign/')));

const noPhoto = await call({ action: 'look.generate', sessionId, garmentIds: [garments[0]?.id] }, key);
check('generating before a photo is refused', noPhoto.status === 409, noPhoto.body?.code);

if (process.argv.includes('--generate')) {
    const linked = garments.filter((g) => g.source === 'link');
    if (!linked.length) {
        check('--generate needs a real garment: pass --link <product url>', false);
    } else {
        const cap = await call({ action: 'session.capture', sessionId, image: mannequinPng() }, key);
        check('kiosk uploads a capture', cap.status === 200, cap.body?.error);

        const gen = await call({ action: 'look.generate', sessionId, garmentIds: linked.map((g) => g.id) }, key);
        check('a look starts generating', gen.status === 200 && !!gen.body?.lookId, gen.body?.error);

        const started = Date.now();
        let look;
        while (Date.now() - started < 180_000) {
            await new Promise((r) => setTimeout(r, 3000));
            const s = await call({ action: 'session.state', sessionId }, key);
            look = s.body?.looks?.find((l) => l.id === gen.body?.lookId);
            if (look && look.status !== 'pending') break;
        }
        const secs = Math.round((Date.now() - started) / 1000);
        check(`the look finishes (${secs}s)`, look?.status === 'succeeded', look?.error);
        if (look?.imageUrl) {
            const img = Buffer.from(await (await fetch(look.imageUrl)).arrayBuffer());
            writeFileSync(new URL('../.smoke-look.png', import.meta.url), img);
            check('the result downloads through its signed URL', img.length > 10_000, `${Math.round(img.length / 1024)} KB → .smoke-look.png`);
        }
    }
}

const end = await call({ action: 'session.end', sessionId }, key);
check('session.end', end.status === 200);

const afterEnd = await call({ action: 'garment.upload', sessionId, token, image: PNG });
check('uploads after the visit ends are refused', afterEnd.status === 409);

const phoneAfter = await call({ action: 'phone.state', sessionId, token });
check('the phone can still read an ended visit', phoneAfter.status === 200 && phoneAfter.body?.status === 'ended');

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
