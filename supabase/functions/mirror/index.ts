// @ts-nocheck
// Emode Mirror API.
//
// Two kinds of caller, neither of them an Emode account:
//
//   the kiosk -- a web app on a Proto Luma, identified by a per-device key
//                that lives in the launch URL configured on the device;
//   the phone -- whoever scanned the QR code on that kiosk, identified by an
//                upload token that only ever travels in the QR code's URL
//                fragment.
//
// Visitors are anonymous by design. This function is the only thing holding
// the service role, so every table and the `mirror` bucket are closed to
// clients and every read leaves here as a short-lived signed URL.
//
// Privacy rule, in one place: the photograph of the person is deleted the
// moment the visit ends. Their generated looks stay downloadable on the phone
// that paired with the kiosk for RETAIN_AFTER_END_MINUTES, then everything for
// the visit is deleted. A visit nobody ends is swept after IDLE_MINUTES.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.86.2';
import { encodeBase64, decodeBase64 } from 'https://deno.land/std@0.224.0/encoding/base64.ts';

const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') || '';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const IMAGE_MODEL = Deno.env.get('MIRROR_IMAGE_MODEL')
    || Deno.env.get('GEMINI_IMAGE_MODEL')
    || 'gemini-3-pro-image-preview';

const BUCKET = 'mirror';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_BYTES = 20 * 1024 * 1024;
const MAX_GARMENTS_PER_SESSION = 12;
const MAX_GARMENTS_PER_LOOK = 6;
const MAX_LOOKS_PER_SESSION = 12;
const IDLE_MINUTES = 20;
const RETAIN_AFTER_END_MINUTES = 60;
const LOOK_TIMEOUT_MINUTES = 4;
const SIGNED_URL_SECONDS = 30 * 60;

const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
);

// The kiosk and the phone authenticate with secrets in headers and bodies, not
// cookies, so a permissive origin costs nothing here.
const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-mirror-device-key',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

class HttpError extends Error {
    constructor(public status: number, message: string, public code?: string) {
        super(message);
    }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' },
});

// ──────────────────────────────────────────────────────────────── helpers ────

async function sha256Hex(value: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken(bytes = 32): string {
    const raw = crypto.getRandomValues(new Uint8Array(bytes));
    return encodeBase64(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function requireUuid(value: unknown, name: string): string {
    if (typeof value !== 'string' || !UUID.test(value)) throw new HttpError(400, `Invalid ${name}`);
    return value;
}

/**
 * The type of an image, from its first bytes.
 *
 * Not from the data URL prefix or the filename, both of which the caller
 * chooses. Anything that is not a JPEG, PNG or WebP is refused before it is
 * stored or handed to the model.
 */
function sniffImage(bytes: Uint8Array): { mime: string; ext: string } | null {
    if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return { mime: 'image/jpeg', ext: 'jpg' };
    }
    if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
        return { mime: 'image/png', ext: 'png' };
    }
    if (bytes.length > 12
        && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
        && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') {
        return { mime: 'image/webp', ext: 'webp' };
    }
    return null;
}

function decodeImage(value: unknown): { bytes: Uint8Array; mime: string; ext: string } {
    if (typeof value !== 'string' || !value) throw new HttpError(400, 'Missing image');
    const b64 = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value;
    if (Math.ceil(b64.length * 0.75) > MAX_IMAGE_BYTES) {
        throw new HttpError(413, `Images must be under ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
    }
    let bytes: Uint8Array;
    try {
        bytes = decodeBase64(b64.replace(/[\r\n\s]/g, ''));
    } catch {
        throw new HttpError(400, 'That image could not be read');
    }
    const type = sniffImage(bytes);
    if (!type) throw new HttpError(415, 'Use a JPEG, PNG or WebP image');
    return { bytes, ...type };
}

async function signed(path: string | null | undefined): Promise<string | null> {
    if (!path) return null;
    const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS);
    if (error) {
        console.warn('signing failed', path, error.message);
        return null;
    }
    return data.signedUrl;
}

async function downloadBase64(path: string): Promise<{ data: string; mime: string }> {
    const { data, error } = await admin.storage.from(BUCKET).download(path);
    if (error || !data) throw new Error(`download failed for ${path}: ${error?.message}`);
    const bytes = new Uint8Array(await data.arrayBuffer());
    return { data: encodeBase64(bytes), mime: sniffImage(bytes)?.mime || 'image/jpeg' };
}

function touch(sessionId: string) {
    return admin.from('mirror_sessions')
        .update({ last_activity_at: new Date().toISOString() })
        .eq('id', sessionId);
}

// ───────────────────────────────────────────────────────────────── events ────

type EventType =
    | 'visit_started' | 'phone_paired' | 'garment_added' | 'look_generated' | 'look_failed'
    | 'visit_ended' | 'product_link_opened' | 'app_cta_tapped' | 'account_linked'
    | 'wardrobe_sent' | 'look_saved_to_account';

/**
 * Count something that happened at a mirror.
 *
 * Never blocks or fails the request it rides on: a lost analytics row is a
 * shrug, a try-on that errors because the counter hiccupped is not. Callers
 * pass only non-personal metadata -- store hostnames, counts, durations.
 */
function logEvent(deviceId: string, sessionId: string | null, type: EventType, meta: Record<string, unknown> = {}) {
    admin.from('mirror_events')
        .insert({ device_id: deviceId, session_id: sessionId, type, meta })
        .then(({ error }) => { if (error) console.warn('event not logged', type, error.message); });
}

function hostOf(url: string | null | undefined): string | null {
    if (!url) return null;
    try {
        return new URL(url).hostname.replace(/^www\d?\./, '');
    } catch {
        return null;
    }
}

// ────────────────────────────────────────────────────────── categories ────

const CATEGORIES = ['tops', 'outerwear', 'bottoms', 'shoes', 'accessories', 'other'] as const;
type Category = typeof CATEGORIES[number];

/** The app's wardrobe folders, in the mirror's vocabulary. */
function categoryFromFolder(slug: string | null | undefined, name: string | null | undefined): Category | null {
    const s = `${slug || ''} ${name || ''}`.toLowerCase();
    if (/shirt|top|tee|blouse|sweater|knit|hood/.test(s)) return 'tops';
    if (/jacket|coat|outer|blazer/.test(s)) return 'outerwear';
    if (/pant|jean|trouser|short|skirt|bottom/.test(s)) return 'bottoms';
    if (/shoe|sneaker|boot|footwear/.test(s)) return 'shoes';
    if (/access|bag|hat|cap|jewel|belt|scarf|glass/.test(s)) return 'accessories';
    return null;
}

const CLASSIFY_MODEL = Deno.env.get('MIRROR_CLASSIFY_MODEL') || 'gemini-2.5-flash';

/**
 * Sort an uploaded or linked piece into a category, after the fact.
 *
 * A cheap text answer from a small model, run in the background so the upload
 * itself never waits on it. If it fails the piece simply lands under "Other" --
 * the tabs are a convenience, not a gate.
 */
async function classifyGarment(garmentId: string, bytes: Uint8Array, mime: string) {
    if (!GEMINI_API_KEY) return;
    const res = await fetch(`${GEMINI_BASE}/${CLASSIFY_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            contents: [{
                parts: [
                    { inlineData: { mimeType: mime, data: encodeBase64(bytes) } },
                    { text: `This image shows a clothing item, possibly worn by a model. Which single category is the main product? Answer with exactly one word from: ${CATEGORIES.join(', ')}.` },
                ],
            }],
            generationConfig: { temperature: 0, maxOutputTokens: 5 },
        }),
    });
    if (!res.ok) {
        console.warn('classify failed', res.status, (await res.text().catch(() => '')).slice(0, 300));
        return;
    }
    const data = await res.json();
    const word = String(data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim().toLowerCase().replace(/[^a-z]/g, '');
    const category = (CATEGORIES as readonly string[]).includes(word) ? word : 'other';
    await admin.from('mirror_garments').update({ category }).eq('id', garmentId);
}

/** Store a piece's image and record it on the visit. Shared by every way a piece arrives. */
async function addGarment(session: any, image: { bytes: Uint8Array; mime: string; ext: string }, fields: {
    source: 'upload' | 'link' | 'wardrobe';
    title?: string | null;
    productUrl?: string | null;
    category?: Category | null;
}) {
    const id = crypto.randomUUID();
    const path = `sessions/${session.id}/garments/${id}.${image.ext}`;
    const { error: upError } = await admin.storage.from(BUCKET)
        .upload(path, image.bytes, { contentType: image.mime });
    if (upError) throw new Error(upError.message);
    const { error } = await admin.from('mirror_garments').insert({
        id,
        session_id: session.id,
        source: fields.source,
        image_path: path,
        title: fields.title ? String(fields.title).slice(0, 300) : null,
        product_url: fields.productUrl || null,
        category: fields.category || null,
    });
    if (error) throw new Error(error.message);
    if (!fields.category) background(classifyGarment(id, image.bytes, image.mime));
    logEvent(session.device_id, session.id, 'garment_added', {
        source: fields.source,
        host: hostOf(fields.productUrl),
        category: fields.category || null,
    });
    return id;
}

async function garmentCount(sessionId: string) {
    const { count } = await admin.from('mirror_garments')
        .select('id', { count: 'exact', head: true }).eq('session_id', sessionId);
    return count || 0;
}

// ──────────────────────────────────────────────────────────────── members ────

/**
 * The Emode account making this request, if it is a signed-in app.
 *
 * The app's Supabase client sends the user's access token as the bearer; the
 * phone web page and the kiosk send the public anon key, which resolves to no
 * user. So this answers "who" only when there is a real account behind it.
 */
async function optionalUser(req: Request): Promise<{ id: string } | null> {
    const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (bearer.split('.').length !== 3) return null;
    const { data, error } = await admin.auth.getUser(bearer);
    if (error || !data?.user) return null;
    return { id: data.user.id };
}

async function requireUser(req: Request) {
    const user = await optionalUser(req);
    if (!user) throw new HttpError(401, 'Sign in to Emode to use your wardrobe', 'sign_in');
    return user;
}

/** The visit, provided this phone scanned it AND this account has claimed it. */
async function requireMemberSession(req: Request, body: any, opts = { active: true }) {
    const user = await requireUser(req);
    const session = await requirePhoneSession(body, opts);
    if (session.user_id !== user.id) {
        throw new HttpError(403, 'Connect this visit to your account first', 'not_linked');
    }
    return { user, session };
}

// ─────────────────────────────────────────────────────────────────── auth ────

async function requireDevice(req: Request, body: any) {
    const key = req.headers.get('x-mirror-device-key') || '';
    if (key.length < 20) throw new HttpError(401, 'This screen is not registered as an Emode Mirror', 'no_device');

    const { data: device } = await admin.from('mirror_devices')
        .select('id, name, location, proto_serial, theme, daily_look_limit, active')
        .eq('key_hash', await sha256Hex(key))
        .maybeSingle();
    if (!device || !device.active) {
        throw new HttpError(401, 'This screen is not registered as an Emode Mirror', 'no_device');
    }

    // Proto can append the hardware serial to the launch URL. It is recorded
    // the first time it is seen -- an identifier for support, never a
    // credential, since anyone can type a query parameter.
    const serial = typeof body?.protoSerial === 'string' ? body.protoSerial.slice(0, 120) : null;
    const patch: Record<string, unknown> = { last_seen_at: new Date().toISOString() };
    if (serial && !device.proto_serial) patch.proto_serial = serial;
    admin.from('mirror_devices').update(patch).eq('id', device.id).then(() => {});

    return device;
}

async function requireKioskSession(device: any, sessionId: unknown, { active = true } = {}) {
    const id = requireUuid(sessionId, 'session');
    const { data: session } = await admin.from('mirror_sessions')
        .select('*')
        .eq('id', id)
        .eq('device_id', device.id)
        .maybeSingle();
    if (!session) throw new HttpError(404, 'That visit has ended', 'session_gone');
    if (active && session.status !== 'active') throw new HttpError(409, 'That visit has ended', 'session_ended');
    return session;
}

async function requirePhoneSession(body: any, { active = true } = {}) {
    const id = requireUuid(body?.sessionId, 'session');
    const token = typeof body?.token === 'string' ? body.token : '';
    if (token.length < 20) throw new HttpError(401, 'This link is incomplete — scan the code on the mirror again', 'bad_token');

    const { data: session } = await admin.from('mirror_sessions')
        .select('*, mirror_devices(name, location)')
        .eq('id', id)
        .eq('upload_token_hash', await sha256Hex(token))
        .maybeSingle();
    if (!session) throw new HttpError(404, 'This mirror visit has ended', 'session_gone');
    if (active && session.status !== 'active') {
        throw new HttpError(409, 'This mirror visit has ended — you can still save your looks below', 'session_ended');
    }
    // Any phone call on a live visit means a phone has paired with it. Counted
    // once, set-if-null, so racing polls cannot double it.
    if (!session.phone_seen_at && session.status === 'active') {
        const { data: first } = await admin.from('mirror_sessions')
            .update({ phone_seen_at: new Date().toISOString() })
            .eq('id', session.id).is('phone_seen_at', null)
            .select('id');
        if (first?.length) {
            session.phone_seen_at = new Date().toISOString();
            logEvent(session.device_id, session.id, 'phone_paired');
        }
    }
    return session;
}

// ─────────────────────────────────────────────────────────── serialising ────

async function describeSession(session: any) {
    const [{ data: garments }, { data: looks }] = await Promise.all([
        admin.from('mirror_garments').select('*').eq('session_id', session.id).order('created_at'),
        admin.from('mirror_looks').select('*').eq('session_id', session.id).order('created_at'),
    ]);

    const now = Date.now();
    return {
        id: session.id,
        status: session.status,
        hasPhoto: !!session.person_path,
        // Whether an Emode account has claimed the visit. A yes/no only: the
        // kiosk is a public screen and never learns whose account it is.
        linked: !!session.user_id,
        endedAt: session.ended_at,
        retainUntil: session.ended_at
            ? new Date(new Date(session.ended_at).getTime() + RETAIN_AFTER_END_MINUTES * 60_000).toISOString()
            : null,
        garments: await Promise.all((garments || []).map(async (g: any) => ({
            id: g.id,
            source: g.source,
            category: g.category,
            title: g.title,
            productUrl: g.product_url,
            imageUrl: await signed(g.image_path),
        }))),
        looks: await Promise.all((looks || []).map(async (l: any) => {
            // A generation whose worker died never writes its own failure, so
            // anything pending well past any real generation time is reported
            // as failed rather than spinning on the kiosk forever.
            const stale = l.status === 'pending'
                && now - new Date(l.created_at).getTime() > LOOK_TIMEOUT_MINUTES * 60_000;
            return {
                id: l.id,
                status: stale ? 'failed' : l.status,
                error: stale ? 'That took too long. Try again.' : l.error,
                garmentIds: l.garment_ids,
                imageUrl: l.status === 'succeeded' ? await signed(l.image_path) : null,
                createdAt: l.created_at,
            };
        })),
    };
}

// ────────────────────────────────────────────────────────────── retention ────

/** Delete one visit: its files first, then its rows (garments and looks cascade). */
async function purgeSession(sessionId: string) {
    const [{ data: session }, { data: garments }, { data: looks }] = await Promise.all([
        admin.from('mirror_sessions').select('person_path').eq('id', sessionId).maybeSingle(),
        admin.from('mirror_garments').select('image_path').eq('session_id', sessionId),
        admin.from('mirror_looks').select('image_path').eq('session_id', sessionId),
    ]);
    const paths = [
        session?.person_path,
        ...(garments || []).map((g: any) => g.image_path),
        ...(looks || []).map((l: any) => l.image_path),
    ].filter(Boolean);
    if (paths.length) {
        const { error } = await admin.storage.from(BUCKET).remove(paths);
        // Keep the row if its files could not be removed, so the next sweep
        // tries again instead of orphaning someone's photograph in the bucket.
        if (error) {
            console.error('purge: storage remove failed', sessionId, error.message);
            return;
        }
    }
    await admin.from('mirror_sessions').delete().eq('id', sessionId);
}

async function sweep() {
    const idleBefore = new Date(Date.now() - IDLE_MINUTES * 60_000).toISOString();
    const endedBefore = new Date(Date.now() - RETAIN_AFTER_END_MINUTES * 60_000).toISOString();
    const { data } = await admin.from('mirror_sessions')
        .select('id')
        .or(`and(status.eq.active,last_activity_at.lt.${idleBefore}),and(status.eq.ended,ended_at.lt.${endedBefore})`)
        .limit(25);
    for (const row of data || []) await purgeSession(row.id);
}

function background(promise: Promise<unknown>) {
    const guarded = promise.catch((e) => console.error('background task failed', e));
    // @ts-ignore EdgeRuntime is provided by the Supabase runtime
    if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(guarded);
}

// ─────────────────────────────────────────────────────────── generation ────

function buildPrompt(theme: string) {
    // The backdrop follows the screen's theme. On a holographic display the
    // "empty" colour is what makes a figure read as standing in the space
    // rather than printed on a panel, so the person is cut out onto exactly
    // that colour. Which colour that is on a Luma gets confirmed at /calibrate.
    const backdrop = theme === 'light'
        ? 'Replace the background with a seamless, evenly lit, pure white (#FFFFFF) studio backdrop.'
        : 'Replace the background with a seamless pure black (#000000) studio backdrop, with soft studio light on the person so they stand out cleanly against it.';

    return [
        'You are editing a photograph of a real adult standing in front of a fitting mirror.',
        'The FIRST image is that person. Every later image is a garment reference.',
        // Store photos are usually the garment on a model. Without this the
        // model happily returns the store's model -- tested: a link to a
        // Uniqlo tee came back as the Uniqlo model, not the visitor.
        'Garment references often show the garment worn by a model, or on a mannequin or hanger. Take ONLY the garment from them. Never use the face, head, hair, skin, body, pose or identity of anyone in a garment reference. The person in your result must be the person from the first image and nobody else.',
        'Dress the person from the first image in those garments. Replace what they are currently wearing wherever a reference garment would be worn; keep any of their own clothing that no reference replaces.',
        'Keep the person exactly as they are: the same face, hair, skin tone, body shape and proportions, height, pose, expression and hands. Do not slim, reshape, beautify or age them.',
        'Make each garment fit their body naturally, with realistic drape, folds and lighting.',
        'Reproduce every garment faithfully: its colour, fabric, pattern, logos, printed text and details. Text on clothing must read correctly.',
        backdrop,
        'Show the whole person from the top of the head to the soles of the feet, standing, centred, with a little space above the head and below the feet. Never crop the head, hands or feet.',
        'Return one photorealistic image. Keep it tasteful and non-sexual. Do not add text, watermarks, borders or any other people.',
    ].join('\n');
}

async function runLook(look: any, session: any, device: any, garments: any[]) {
    const started = Date.now();
    const fail = (message: string) => {
        logEvent(device.id, session.id, 'look_failed', { pieces: garments.length, reason: message.slice(0, 80) });
        return admin.from('mirror_looks')
            .update({ status: 'failed', error: message.slice(0, 500), completed_at: new Date().toISOString() })
            .eq('id', look.id);
    };

    try {
        if (!GEMINI_API_KEY) return await fail('Try-on is not configured.');

        const person = await downloadBase64(session.person_path);
        const references = await Promise.all(garments.map((g) => downloadBase64(g.image_path)));

        const parts: any[] = [
            { text: 'Photograph of the person:' },
            { inlineData: { mimeType: person.mime, data: person.data } },
        ];
        references.forEach((ref, i) => {
            const label = garments[i].title ? ` (${String(garments[i].title).slice(0, 120)})` : '';
            parts.push({ text: `Garment reference ${i + 1}${label}:` });
            parts.push({ inlineData: { mimeType: ref.mime, data: ref.data } });
        });
        parts.push({ text: buildPrompt(device.theme) });

        const response = await fetch(`${GEMINI_BASE}/${IMAGE_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts }],
                // Portrait, matching the Luma's panel, so a look fills the
                // mirror instead of floating in a letterbox.
                generationConfig: { responseModalities: ['IMAGE', 'TEXT'], imageConfig: { aspectRatio: '9:16' } },
                safetySettings: [
                    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
                    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
                    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
                    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
                ],
            }),
        });

        if (!response.ok) {
            // The body says whether this is quota (429, wait or pay) or the key
            // being refused the model (403, billing will not fix it). It never
            // contains the key, which travels in the query string.
            const detail = await response.text().catch(() => '<unreadable>');
            console.error('Gemini request failed', response.status, 'model=' + IMAGE_MODEL, detail.slice(0, 700));
            return await fail(response.status === 429
                ? 'The mirror is busy right now. Try again in a minute.'
                : 'The try-on service could not generate this look.');
        }

        const data = await response.json();
        const out = (data?.candidates?.[0]?.content?.parts || []).find((p: any) => p.inlineData?.data)?.inlineData;
        if (!out) {
            const blocked = !!data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason === 'SAFETY';
            return await fail(blocked
                ? 'This look could not be generated under the safety rules. Try different pieces.'
                : 'No image came back. Try again.');
        }

        const bytes = decodeBase64(out.data);
        const type = sniffImage(bytes) || { mime: 'image/png', ext: 'png' };
        const path = `sessions/${session.id}/looks/${look.id}.${type.ext}`;
        const { error: upError } = await admin.storage.from(BUCKET)
            .upload(path, bytes, { contentType: type.mime, upsert: true });
        if (upError) return await fail('The look was generated but could not be saved.');

        await admin.from('mirror_looks')
            .update({ status: 'succeeded', image_path: path, completed_at: new Date().toISOString() })
            .eq('id', look.id);
        logEvent(device.id, session.id, 'look_generated', {
            pieces: garments.length,
            seconds: Math.round((Date.now() - started) / 1000),
        });
    } catch (e) {
        console.error('runLook crashed', look.id, e);
        await fail('Something went wrong generating this look.');
    }
}

// ───────────────────────────────────────────────────────── product links ────

function isPrivateAddress(ip: string): boolean {
    if (ip.includes(':')) {
        const v6 = ip.toLowerCase();
        return v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80') || v6 === '::';
    }
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
        || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/**
 * Only fetch public web pages.
 *
 * This function holds the service role and runs inside Supabase's network, so
 * a product link is an invitation to make it fetch something on the caller's
 * behalf. Anything that is not plain http(s) to a public address is refused,
 * including hostnames that resolve to a private one.
 */
async function assertPublicUrl(raw: string): Promise<URL> {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new HttpError(400, 'That does not look like a link');
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw new HttpError(400, 'Use an http or https link');
    if (url.port && !['80', '443'].includes(url.port)) throw new HttpError(400, 'That link is not supported');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
        throw new HttpError(400, 'That link is not supported');
    }
    if (/^[\d.]+$/.test(host) || host.includes(':')) {
        if (isPrivateAddress(host)) throw new HttpError(400, 'That link is not supported');
        return url;
    }
    try {
        const addresses = [
            ...(await Deno.resolveDns(host, 'A').catch(() => [])),
            ...(await Deno.resolveDns(host, 'AAAA').catch(() => [])),
        ];
        if (!addresses.length) throw new HttpError(400, 'We could not find that website');
        if (addresses.some(isPrivateAddress)) throw new HttpError(400, 'That link is not supported');
    } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(400, 'We could not find that website');
    }
    return url;
}

async function fetchCapped(url: URL, maxBytes: number, accept: string): Promise<{ bytes: Uint8Array; type: string; finalUrl: string; truncated: boolean }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
        // Redirects are followed by hand so each hop gets the same public-address check.
        let current = url;
        for (let hop = 0; hop < 4; hop++) {
            const res = await fetch(current, {
                redirect: 'manual',
                signal: controller.signal,
                headers: {
                    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 EmodeMirror/1.0',
                    accept,
                    'accept-language': 'en-US,en;q=0.9',
                },
            });
            if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
                current = await assertPublicUrl(new URL(res.headers.get('location')!, current).toString());
                continue;
            }
            if (!res.ok) throw new HttpError(422, 'That store would not let us read the page. Take a screenshot instead.', 'link_blocked');
            // Read up to the cap and say whether we stopped early. A page cut
            // short still has its <head>, which is all the extraction needs; an
            // image cut short is corrupt, and the caller refuses it.
            const reader = res.body!.getReader();
            const chunks: Uint8Array[] = [];
            let kept = 0;
            let truncated = false;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (kept + value.length > maxBytes) {
                    chunks.push(value.slice(0, maxBytes - kept));
                    kept = maxBytes;
                    truncated = true;
                    await reader.cancel().catch(() => {});
                    break;
                }
                chunks.push(value);
                kept += value.length;
            }
            const bytes = new Uint8Array(kept);
            let offset = 0;
            for (const c of chunks) {
                bytes.set(c, offset);
                offset += c.length;
            }
            return { bytes, type: res.headers.get('content-type') || '', finalUrl: current.toString(), truncated };
        }
        throw new HttpError(422, 'That link redirected too many times.');
    } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(422, 'That store took too long to answer. Take a screenshot instead.', 'link_timeout');
    } finally {
        clearTimeout(timer);
    }
}

function decodeEntities(s: string) {
    const named: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
    return s
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
        .replace(/&([a-z]+);/gi, (m, name) => named[name.toLowerCase()] ?? m);
}

/**
 * The product's main image and name from a store page.
 *
 * Structured data first -- a schema.org Product names its own images -- then
 * the Open Graph tags every store sets for link previews. Stores that block
 * automated requests outright are common and are reported as such; the
 * screenshot path always works, and the phone says so.
 */
function extractProduct(html: string, base: string): { image: string | null; title: string | null } {
    let image: string | null = null;
    let title: string | null = null;

    for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
        try {
            const parsed = JSON.parse(m[1].trim());
            const nodes = (Array.isArray(parsed) ? parsed : [parsed])
                .flatMap((n: any) => (n && n['@graph']) ? n['@graph'] : [n]);
            const product = nodes.find((n: any) => {
                const t = n?.['@type'];
                return t === 'Product' || (Array.isArray(t) && t.includes('Product'));
            });
            if (product) {
                const img = Array.isArray(product.image) ? product.image[0] : product.image;
                image = image || (typeof img === 'string' ? img : img?.url || null);
                title = title || (typeof product.name === 'string' ? product.name : null);
            }
        } catch { /* malformed JSON-LD is common; keep looking */ }
    }

    const meta = (prop: string) => {
        const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i');
        const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`, 'i');
        return (html.match(re) || html.match(re2))?.[1] || null;
    };
    image = image || meta('og:image:secure_url') || meta('og:image') || meta('twitter:image');
    title = title || meta('og:title') || (html.match(/<title[^>]*>([^<]{1,300})<\/title>/i)?.[1] ?? null);

    return {
        image: image ? new URL(decodeEntities(image.trim()), base).toString() : null,
        title: title ? decodeEntities(title.trim()).slice(0, 300) : null,
    };
}

// ──────────────────────────────────────────────────────────────── actions ────

async function handle(req: Request, body: any): Promise<Response> {
    const action = body?.action;

    // ── Kiosk ─────────────────────────────────────────────────────────────
    if (action === 'device.hello') {
        const device = await requireDevice(req, body);
        background(sweep());
        return json({
            device: { name: device.name, location: device.location, theme: device.theme },
            limits: { garmentsPerLook: MAX_GARMENTS_PER_LOOK, idleMinutes: IDLE_MINUTES, retainMinutes: RETAIN_AFTER_END_MINUTES },
        });
    }

    if (action === 'session.start') {
        const device = await requireDevice(req, body);
        if (body?.consent !== true || body?.adult !== true) {
            throw new HttpError(400, 'Consent is required before the mirror can take a photo', 'consent_required');
        }
        const token = randomToken();
        const { data: session, error } = await admin.from('mirror_sessions')
            .insert({ device_id: device.id, upload_token_hash: await sha256Hex(token), consent_at: new Date().toISOString() })
            .select('id')
            .single();
        if (error) throw new Error(error.message);
        background(sweep());
        logEvent(device.id, session.id, 'visit_started');
        // The kiosk builds the phone URL from its own origin, so the same code
        // pairs correctly from a laptop in development and a Luma in production.
        return json({ sessionId: session.id, token });
    }

    if (action === 'session.state') {
        const device = await requireDevice(req, body);
        const session = await requireKioskSession(device, body?.sessionId, { active: false });
        return json(await describeSession(session));
    }

    if (action === 'session.capture') {
        const device = await requireDevice(req, body);
        const session = await requireKioskSession(device, body?.sessionId);
        const image = decodeImage(body?.image);
        const path = `sessions/${session.id}/person.${image.ext}`;
        // Replacing the photo replaces the file in place, so a retake never
        // leaves the previous photograph of someone behind.
        if (session.person_path && session.person_path !== path) {
            await admin.storage.from(BUCKET).remove([session.person_path]);
        }
        const { error } = await admin.storage.from(BUCKET)
            .upload(path, image.bytes, { contentType: image.mime, upsert: true });
        if (error) throw new Error(error.message);
        await admin.from('mirror_sessions')
            .update({ person_path: path, last_activity_at: new Date().toISOString() })
            .eq('id', session.id);
        return json({ ok: true });
    }

    if (action === 'look.generate') {
        const device = await requireDevice(req, body);
        const session = await requireKioskSession(device, body?.sessionId);
        if (!session.person_path) throw new HttpError(409, 'Take a photo first', 'no_photo');

        const ids = Array.isArray(body?.garmentIds) ? [...new Set(body.garmentIds)] : [];
        if (ids.length < 1 || ids.length > MAX_GARMENTS_PER_LOOK) {
            throw new HttpError(400, `Choose between 1 and ${MAX_GARMENTS_PER_LOOK} pieces`);
        }
        ids.forEach((id) => requireUuid(id, 'garment'));

        const { data: garments } = await admin.from('mirror_garments')
            .select('id, image_path, title').eq('session_id', session.id).in('id', ids);
        if (!garments || garments.length !== ids.length) throw new HttpError(400, 'Some of those pieces are no longer here');
        // Keep the order the visitor picked them in.
        garments.sort((a: any, b: any) => ids.indexOf(a.id) - ids.indexOf(b.id));

        const { data: existing } = await admin.from('mirror_looks')
            .select('id, status, created_at').eq('session_id', session.id);
        if ((existing || []).length >= MAX_LOOKS_PER_SESSION) {
            throw new HttpError(429, 'That is the limit for one visit. Finish and start again to keep going.', 'session_limit');
        }
        const inFlight = (existing || []).find((l: any) => l.status === 'pending'
            && Date.now() - new Date(l.created_at).getTime() < LOOK_TIMEOUT_MINUTES * 60_000);
        if (inFlight) return json({ lookId: inFlight.id, alreadyRunning: true });

        const dayStart = new Date();
        dayStart.setUTCHours(0, 0, 0, 0);
        const { count } = await admin.from('mirror_looks')
            .select('id', { count: 'exact', head: true })
            .eq('device_id', device.id)
            .gte('created_at', dayStart.toISOString());
        if ((count || 0) >= device.daily_look_limit) {
            throw new HttpError(429, 'This mirror has reached its limit for today.', 'device_limit');
        }

        const { data: look, error } = await admin.from('mirror_looks')
            .insert({ session_id: session.id, device_id: device.id, garment_ids: ids })
            .select('*')
            .single();
        if (error) throw new Error(error.message);
        await touch(session.id);

        // Answered immediately; the kiosk polls session.state for the result.
        // A request held open for half a minute on venue Wi-Fi is a request
        // that gets cut, and this way a dropped connection loses nothing.
        background(runLook(look, session, device, garments));
        return json({ lookId: look.id });
    }

    if (action === 'session.end') {
        const device = await requireDevice(req, body);
        const session = await requireKioskSession(device, body?.sessionId, { active: false });
        if (session.status === 'active') {
            // The photograph goes now. Looks stay for the phone to save until
            // the retention window closes, then the sweep removes the rest.
            if (session.person_path) await admin.storage.from(BUCKET).remove([session.person_path]);
            await admin.from('mirror_sessions')
                .update({ status: 'ended', ended_at: new Date().toISOString(), person_path: null })
                .eq('id', session.id);
            const reason = ['finish', 'idle', 'cancel'].includes(body?.reason) ? body.reason : 'finish';
            logEvent(device.id, session.id, 'visit_ended', {
                reason,
                minutes: Math.round((Date.now() - new Date(session.created_at).getTime()) / 60_000),
                paired: !!session.phone_seen_at,
                member: !!session.user_id,
            });
        }
        return json({ ok: true, retainMinutes: RETAIN_AFTER_END_MINUTES });
    }

    // ── Phone ─────────────────────────────────────────────────────────────
    if (action === 'phone.state') {
        const session = await requirePhoneSession(body, { active: false });
        const described = await describeSession(session);
        return json({
            ...described,
            device: { name: session.mirror_devices?.name, location: session.mirror_devices?.location },
            limits: { garmentsPerSession: MAX_GARMENTS_PER_SESSION },
        });
    }

    if (action === 'garment.upload') {
        const session = await requirePhoneSession(body);
        if (await garmentCount(session.id) >= MAX_GARMENTS_PER_SESSION) {
            throw new HttpError(429, `That's ${MAX_GARMENTS_PER_SESSION} pieces — remove one to add another`, 'garment_limit');
        }
        const image = decodeImage(body?.image);
        const id = await addGarment(session, image, {
            source: 'upload',
            title: typeof body?.title === 'string' ? body.title : null,
        });
        await touch(session.id);
        return json({ ok: true, garmentId: id });
    }

    if (action === 'garment.link') {
        const session = await requirePhoneSession(body);
        if (await garmentCount(session.id) >= MAX_GARMENTS_PER_SESSION) {
            throw new HttpError(429, `That's ${MAX_GARMENTS_PER_SESSION} pieces — remove one to add another`, 'garment_limit');
        }

        const raw = typeof body?.url === 'string' ? body.url.trim().slice(0, 2000) : '';
        const pageUrl = await assertPublicUrl(raw);
        const page = await fetchCapped(pageUrl, 3 * 1024 * 1024, 'text/html,application/xhtml+xml');
        const { image: imageUrl, title } = extractProduct(new TextDecoder().decode(page.bytes), page.finalUrl);
        if (!imageUrl) {
            throw new HttpError(422, "We couldn't find the product photo on that page. Take a screenshot instead.", 'no_image');
        }

        const img = await fetchCapped(await assertPublicUrl(imageUrl), MAX_IMAGE_BYTES, 'image/webp,image/png,image/jpeg,*/*');
        if (img.truncated) {
            throw new HttpError(422, "That store's product photo is too large. Take a screenshot instead.", 'image_too_large');
        }
        const type = sniffImage(img.bytes);
        if (!type) {
            throw new HttpError(422, "That store's product photo is in a format we can't use yet. Take a screenshot instead.", 'bad_image');
        }

        const id = await addGarment(session, { bytes: img.bytes, ...type }, {
            source: 'link',
            title,
            productUrl: page.finalUrl,
        });
        await touch(session.id);
        return json({ ok: true, garmentId: id, title });
    }

    if (action === 'garment.remove') {
        const session = await requirePhoneSession(body);
        const garmentId = requireUuid(body?.garmentId, 'garment');
        const { data: g } = await admin.from('mirror_garments')
            .select('image_path').eq('id', garmentId).eq('session_id', session.id).maybeSingle();
        if (!g) return json({ ok: true });
        // Looks already generated from it keep their image; only the piece goes.
        await admin.storage.from(BUCKET).remove([g.image_path]);
        await admin.from('mirror_garments').delete().eq('id', garmentId);
        await touch(session.id);
        return json({ ok: true });
    }

    // Taps that only the phone sees. Two kinds only, so this cannot become a
    // general write path into the events table.
    if (action === 'event.track') {
        const session = await requirePhoneSession(body, { active: false });
        if (body?.type === 'product_link_opened') {
            logEvent(session.device_id, session.id, 'product_link_opened', { host: hostOf(body?.url) });
        } else if (body?.type === 'app_cta_tapped') {
            const where = ['phone_look', 'phone_footer', 'phone_ended'].includes(body?.where) ? body.where : 'other';
            logEvent(session.device_id, session.id, 'app_cta_tapped', { where });
        } else {
            throw new HttpError(400, 'Unknown event');
        }
        return json({ ok: true });
    }

    // ── Emode members (the app) ───────────────────────────────────────────
    //
    // Claiming a visit takes two proofs at once: the visit's QR token (this
    // phone is standing at that mirror) and a signed-in Emode session (this is
    // whose wardrobe it may read). Neither alone is enough.
    if (action === 'phone.link') {
        const user = await requireUser(req);
        const session = await requirePhoneSession(body);
        if (session.user_id !== user.id) {
            await admin.from('mirror_sessions')
                .update({ user_id: user.id, linked_at: new Date().toISOString() })
                .eq('id', session.id);
            logEvent(session.device_id, session.id, 'account_linked');
        }
        await touch(session.id);
        return json({ ok: true });
    }

    if (action === 'garment.from_wardrobe') {
        const { user, session } = await requireMemberSession(req, body);
        const room = MAX_GARMENTS_PER_SESSION - await garmentCount(session.id);
        if (room <= 0) {
            throw new HttpError(429, `The mirror holds ${MAX_GARMENTS_PER_SESSION} pieces — remove one to add another`, 'garment_limit');
        }
        const urls = (Array.isArray(body?.urls) ? body.urls : [])
            .filter((u: unknown) => typeof u === 'string' && u.length < 2000)
            .slice(0, room);
        if (!urls.length) throw new HttpError(400, 'Choose something from your wardrobe');

        // Matched by URL, scoped to this account. The app's local ids are not
        // database ids until a sync, but each folder holds a URL once.
        const { data: assets } = await admin.from('wardrobe_assets')
            .select('url, name, brand, item_name, purchase_link, wardrobe_folders!inner(user_id, slug, name)')
            .in('url', urls)
            .eq('wardrobe_folders.user_id', user.id)
            .is('removed_at', null);

        const ownStorage = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/`;
        let added = 0;
        const skipped: string[] = [];
        const seen = new Set<string>();
        for (const asset of assets || []) {
            if (seen.has(asset.url)) continue;
            seen.add(asset.url);
            const label = asset.item_name || asset.name || asset.brand || 'Wardrobe piece';
            try {
                let bytes: Uint8Array | null = null;
                if (asset.url.startsWith(ownStorage)) {
                    // Emode's own storage: read it directly rather than over HTTP.
                    const rest = decodeURIComponent(asset.url.slice(ownStorage.length).split('?')[0]);
                    const bucket = rest.slice(0, rest.indexOf('/'));
                    const { data } = await admin.storage.from(bucket).download(rest.slice(bucket.length + 1));
                    if (data) bytes = new Uint8Array(await data.arrayBuffer());
                } else if (/^https?:\/\//i.test(asset.url)) {
                    const fetched = await fetchCapped(await assertPublicUrl(asset.url), MAX_IMAGE_BYTES, 'image/webp,image/png,image/jpeg,*/*');
                    if (!fetched.truncated) bytes = fetched.bytes;
                }
                // file:// and anything else only ever existed on one phone.
                const type = bytes ? sniffImage(bytes) : null;
                if (!bytes || !type) {
                    skipped.push(label);
                    continue;
                }
                await addGarment(session, { bytes, ...type }, {
                    source: 'wardrobe',
                    title: label,
                    productUrl: asset.purchase_link,
                    category: categoryFromFolder(asset.wardrobe_folders?.slug, asset.wardrobe_folders?.name),
                });
                added++;
            } catch (e) {
                console.warn('wardrobe piece skipped', label, e);
                skipped.push(label);
            }
        }
        // Asked for but not found in this account's wardrobe at all.
        for (const u of urls) if (!seen.has(u)) skipped.push('A piece that is no longer in your wardrobe');

        if (added) logEvent(session.device_id, session.id, 'wardrobe_sent', { count: added });
        await touch(session.id);
        return json({ ok: true, added, skipped });
    }

    // Keep a look in the app's own try-on history. The visitor's photo never
    // moves; only the finished look does, into their own private storage.
    if (action === 'look.save') {
        const { user, session } = await requireMemberSession(req, body, { active: false });
        const lookId = requireUuid(body?.lookId, 'look');
        const { data: look } = await admin.from('mirror_looks')
            .select('*').eq('id', lookId).eq('session_id', session.id).maybeSingle();
        if (!look || look.status !== 'succeeded' || !look.image_path) {
            throw new HttpError(404, 'That look isn’t ready to save');
        }

        const cacheKey = `mirror:${look.id}`;
        const { data: existing } = await admin.from('dressing_room_outfits')
            .select('id').eq('user_id', user.id).eq('cache_key', cacheKey).maybeSingle();
        if (existing) return json({ ok: true, alreadySaved: true });

        const { data: file } = await admin.storage.from(BUCKET).download(look.image_path);
        if (!file) throw new Error('look image missing');
        const bytes = new Uint8Array(await file.arrayBuffer());
        const type = sniffImage(bytes) || { mime: 'image/png', ext: 'png' };
        const dest = `generated/${user.id}/mirror_${look.id}.${type.ext}`;
        const { error: upError } = await admin.storage.from('private-media')
            .upload(dest, bytes, { contentType: type.mime, upsert: true });
        if (upError) throw new Error(upError.message);

        const { data: pieces } = await admin.from('mirror_garments')
            .select('id, title, product_url').in('id', look.garment_ids);
        const ordered = look.garment_ids
            .map((id: string) => (pieces || []).find((p: any) => p.id === id))
            .filter(Boolean)
            .map((p: any) => ({ title: p.title, productUrl: p.product_url }));

        const { error } = await admin.from('dressing_room_outfits').insert({
            user_id: user.id,
            product_ids: [],
            cache_key: cacheKey,
            generated_image_url: dest,
            source: 'mirror',
            mirror_pieces: ordered,
        });
        if (error) throw new Error(error.message);
        logEvent(session.device_id, session.id, 'look_saved_to_account');
        return json({ ok: true });
    }

    throw new HttpError(400, 'Unknown action');
}

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    if (Number(req.headers.get('content-length') || 0) > MAX_REQUEST_BYTES) {
        return json({ error: 'That upload is too large' }, 413);
    }

    let body: any;
    try {
        body = await req.json();
    } catch {
        return json({ error: 'Invalid request' }, 400);
    }

    try {
        return await handle(req, body);
    } catch (e) {
        if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
        console.error('mirror: unhandled', body?.action, e);
        return json({ error: 'Something went wrong. Try again.' }, 500);
    }
});
