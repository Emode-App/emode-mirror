// Check the phone as the camera button, against the live API. No photo is
// taken and no AI is called: it checks the signalling between mirror and phone.
//
//   node scripts/smoke-shutter.mjs
//
// Uses DEV_DEVICE_KEY from .devices.local.

import { readFileSync } from 'node:fs';

const FN = process.env.MIRROR_API_URL || 'https://scvvbjheyfnxlsiiozta.supabase.co/functions/v1/mirror';
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'sb_publishable_xBWtFjEoKrG4wCSzGVkigw_A-i0UfJi';
const local = Object.fromEntries(readFileSync(new URL('../.devices.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const key = process.env.DEV_DEVICE_KEY || local.DEV_DEVICE_KEY;

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

const start = await call({ action: 'session.start', consent: true, adult: true }, key);
const { sessionId, token } = start.body;
const phone = (body) => call({ ...body, sessionId, token });

const before = await phone({ action: 'phone.state' });
check('the phone pairs', before.status === 200);
check('the phone sees no camera before the photo screen', before.body?.cameraOpen === false);
const early = await phone({ action: 'phone.shutter' });
check('the phone can’t take a photo before the mirror is ready', early.status === 409, early.body?.error);

const kioskState = await call({ action: 'session.state', sessionId }, key);
check('the mirror knows a phone is paired', kioskState.body?.phonePaired === true);

await call({ action: 'session.camera', sessionId, open: true }, key);
const ready = await phone({ action: 'phone.state' });
check('the phone sees the camera waiting', ready.body?.cameraOpen === true);

const idle = await call({ action: 'session.shutter', sessionId }, key);
check('nothing pressed yet', idle.body?.pressed === false);

const press = await phone({ action: 'phone.shutter' });
check('the phone presses the button', press.status === 200, press.body?.error);
const seen = await call({ action: 'session.shutter', sessionId }, key);
check('the mirror sees the press', seen.body?.pressed === true);
const again = await call({ action: 'session.shutter', sessionId }, key);
check('one press is one photo', again.body?.pressed === false);

const otherKey = await call({ action: 'session.shutter', sessionId }, 'x'.repeat(32));
check('another screen can’t read the press', otherKey.status === 401);

await call({ action: 'session.camera', sessionId, open: false }, key);
const closed = await phone({ action: 'phone.state' });
check('the phone’s button goes away when the camera closes', closed.body?.cameraOpen === false);

await call({ action: 'session.end', sessionId, reason: 'cancel' }, key);
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
