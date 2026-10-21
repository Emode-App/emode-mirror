// @ts-nocheck
// Emode Mirror API.
//
// Two kinds of caller, neither of them an Emode account:
//
//   the kiosk -- a web app on an in-store screen (a Proto Luma, or any
//                portrait touchscreen with a camera), identified by a
//                per-device key in the launch URL configured on the screen;
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
import {
    CATEGORIES, type Category, type FeedItem, categoryFromText, parseShopifyProducts, parseTableFeed,
    parseXmlFeed, shopifyProductsBase, sniffFeed,
} from './catalog.ts';

const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') || '';
// Live try-on (Decart Lucy VTON). Without a key the mirror simply has no Live
// button. The key stays here; the kiosk gets a one-minute token per connect.
const DECART_API_KEY = Deno.env.get('DECART_API_KEY') || '';
const DECART_LIVE_MODELS = ['lucy-vton-latest', 'lucy-vton-3.6'];
const MAX_LIVE_CONNECTS_PER_VISIT = 12;
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
// How long the mirror's camera counts as waiting for a photo after it last
// said so. Longer than anyone stands at the photo screen.
const CAMERA_OPEN_MINUTES = 5;
// Web mirrors (emode.style) run on visitors' own devices with a key every
// browser can read, so each visitor gets their own allowance as well.
const WEB_VISITS_PER_HOUR = 6;
const WEB_LOOKS_PER_HOUR = 8;

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
    | 'wardrobe_sent' | 'look_saved_to_account' | 'live_started' | 'live_ended';

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

/**
 * A stable, unreadable stand-in for the caller's network address.
 *
 * Only used to ration web mirrors per visitor. Salted with a server secret so
 * the stored value cannot be reversed into an address or matched across
 * systems, and kept only on the visit row, which is deleted with the visit.
 */
async function clientHash(req: Request): Promise<string | null> {
    const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim()
        || req.headers.get('cf-connecting-ip')
        || req.headers.get('x-real-ip')
        || '';
    if (!ip) return null;
    const salt = Deno.env.get('MIRROR_IP_SALT') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    return (await sha256Hex(`${salt}:${ip}`)).slice(0, 32);
}

// ────────────────────────────────────────────────────────── categories ────

/** The app's wardrobe folders, in the mirror's vocabulary. */
function categoryFromFolder(slug: string | null | undefined, name: string | null | undefined): Category | null {
    const s = `${slug || ''} ${name || ''}`.toLowerCase();
    if (/\bsuit|tuxedo/.test(s)) return 'suits';
    if (/dress|jumpsuit|romper/.test(s)) return 'dresses';
    if (/shirt|top|tee|blouse|sweater|knit|hood/.test(s)) return 'tops';
    if (/jacket|coat|outer|blazer/.test(s)) return 'outerwear';
    if (/pant|jean|trouser|short|skirt|bottom/.test(s)) return 'bottoms';
    if (/shoe|sneaker|boot|footwear/.test(s)) return 'shoes';
    if (/access|bag|hat|cap|jewel|belt|scarf|glass/.test(s)) return 'accessories';
    return null;
}

const CLASSIFY_MODEL = Deno.env.get('MIRROR_CLASSIFY_MODEL') || 'gemini-2.5-flash';

/**
 * Sort an uploaded or linked piece into a category and describe it, after the
 * fact.
 *
 * A cheap answer from a small model, run in the background so the upload
 * itself never waits on it. The category drives the tabs; the description
 * drives Live mode, which dresses the shopper from words as well as the
 * photo. Only fields still empty are filled. If it fails the piece lands
 * under "Other" with no description -- a convenience, not a gate.
 */
async function classifyGarment(garmentId: string, bytes: Uint8Array, mime: string) {
    if (!GEMINI_API_KEY) return;
    const { data: row } = await admin.from('mirror_garments')
        .select('category, description').eq('id', garmentId).maybeSingle();
    if (!row || (row.category && row.description)) return;
    const res = await fetch(`${GEMINI_BASE}/${CLASSIFY_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            contents: [{
                parts: [
                    { inlineData: { mimeType: mime, data: encodeBase64(bytes) } },
                    { text: [
                        'This image shows a clothing item, possibly worn by a model. Look only at the main product.',
                        `Return JSON: {"category": one of ${CATEGORIES.join(', ')}, "description": one sentence of 15 to 30 words}.`,
                        'The description starts with "a" or "an" and gives colour, material, pattern, cut and fit, and whether it is open or closed, buttoned or zipped.',
                        'Describe only what is visible. No brand names, no logos or text, nothing about the model or background.',
                    ].join(' ') },
                ],
            }],
            generationConfig: { temperature: 0, maxOutputTokens: 200, responseMimeType: 'application/json' },
        }),
    });
    if (!res.ok) {
        console.warn('classify failed', res.status, (await res.text().catch(() => '')).slice(0, 300));
        return;
    }
    const data = await res.json();
    let parsed: any = {};
    try {
        parsed = JSON.parse(String(data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}'));
    } catch { /* falls through to "other" */ }
    const word = String(parsed?.category || '').trim().toLowerCase().replace(/[^a-z]/g, '');
    const description = typeof parsed?.description === 'string' ? parsed.description.trim().slice(0, 600) : '';
    const patch: Record<string, unknown> = {};
    if (!row.category) patch.category = (CATEGORIES as readonly string[]).includes(word) ? word : 'other';
    if (!row.description && description) patch.description = description;
    if (Object.keys(patch).length) await admin.from('mirror_garments').update(patch).eq('id', garmentId);
}

/** Store a piece's image and record it on the visit. Shared by every way a piece arrives. */
async function addGarment(session: any, image: { bytes: Uint8Array; mime: string; ext: string }, fields: {
    source: 'upload' | 'link' | 'wardrobe' | 'catalog';
    title?: string | null;
    productUrl?: string | null;
    category?: Category | null;
    /** For a piece from a store's rack: its row in mirror_store_products. */
    storeProductId?: string | null;
    description?: string | null;
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
        store_product_id: fields.storeProductId || null,
        description: fields.description ? String(fields.description).slice(0, 600) : null,
    });
    if (error) throw new Error(error.message);
    if (!fields.category || !fields.description) background(classifyGarment(id, image.bytes, image.mime));
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

// ───────────────────────────────────────────────────────────────── stores ────

const STORE_FIELDS = 'id, name, logo_url, owner_id, catalog_feed_url, catalog_synced_at, catalog_sync_started_at, catalog_sync_message';
const MAX_RACK_ITEMS = 1500;
const MAX_FEED_BYTES = 25 * 1024 * 1024;
const CATALOG_REFRESH_HOURS = 2;
// A refresh that started this recently is still running (or died); either way
// nobody starts another until it has had time to finish.
const CATALOG_SYNC_LOCK_MS = 2 * 60_000;

async function storeOf(device: any) {
    if (!device?.store_id) return null;
    const { data } = await admin.from('mirror_stores')
        .select(STORE_FIELDS).eq('id', device.store_id).maybeSingle();
    return data;
}

// Emode's own rack, for mirrors without a store rack of their own.
let houseId: string | null = null;
async function houseStoreId(): Promise<string | null> {
    if (houseId) return houseId;
    const { data } = await admin.from('mirror_stores').select('id').eq('is_house', true).maybeSingle();
    houseId = data?.id ?? null;
    return houseId;
}

/**
 * Where a mirror's rack comes from: its store's own catalog when it has one,
 * otherwise Emode's house rack -- so every mirror, in a store or in an
 * office, has something to try on without a phone.
 */
async function rackStoreId(store: any): Promise<string | null> {
    if (store && await rackCount(store.id) > 0) return store.id;
    return await houseStoreId();
}

async function rackCount(storeId: string) {
    const { count } = await admin.from('mirror_store_products')
        .select('id', { count: 'exact', head: true })
        .eq('store_id', storeId).eq('is_active', true);
    return count || 0;
}

/** Products from a Shopify store or collection, a page of 250 at a time. */
async function readShopify(productsJson: string): Promise<FeedItem[]> {
    const base = new URL(productsJson);
    const items: FeedItem[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= Math.ceil(MAX_RACK_ITEMS / 250); page++) {
        const pageUrl = new URL(base);
        pageUrl.searchParams.set('limit', '250');
        pageUrl.searchParams.set('page', String(page));
        const res = await fetchCapped(await assertPublicUrl(pageUrl.toString()), 15 * 1024 * 1024, 'application/json', 30_000);
        let json: any;
        try {
            json = JSON.parse(new TextDecoder().decode(res.bytes));
        } catch {
            if (page === 1) throw new HttpError(422, 'That Shopify store didn’t return its products.', 'not_a_feed');
            break;
        }
        for (const item of parseShopifyProducts(json, base.origin)) {
            if (seen.has(item.externalId)) continue;
            seen.add(item.externalId);
            items.push(item);
        }
        if ((json?.products?.length || 0) < 250 || items.length >= MAX_RACK_ITEMS) break;
    }
    // products.json has prices but not their currency; the shop's meta.json does.
    let currency: string | null = null;
    try {
        const meta = await fetchCapped(await assertPublicUrl(`${base.origin}/meta.json`), 256 * 1024, 'application/json');
        const c = JSON.parse(new TextDecoder().decode(meta.bytes))?.currency;
        if (typeof c === 'string' && /^[A-Z]{3}$/.test(c)) currency = c;
    } catch { /* prices show without a currency */ }
    return items.slice(0, MAX_RACK_ITEMS).map((i) => ({ ...i, currency: i.currency ?? currency }));
}

/**
 * Read whatever catalog a store pointed us at: a Google Shopping feed (XML,
 * TSV or CSV), or a Shopify store or collection link. Failures come back as
 * messages the store's own team can act on.
 */
async function readFeed(raw: string): Promise<{ items: FeedItem[]; note: string | null }> {
    const url = await assertPublicUrl(raw);
    if (/\/products\.json$/i.test(url.pathname)) return { items: await readShopify(shopifyProductsBase(url.toString())!), note: null };

    const res = await fetchCapped(url, MAX_FEED_BYTES,
        'application/xml,text/xml,application/rss+xml,application/atom+xml,text/tab-separated-values,text/csv,application/json;q=0.9,text/html;q=0.5,*/*;q=0.1',
        45_000);
    const text = new TextDecoder().decode(res.bytes);
    const note = res.truncated
        ? `Your feed is larger than ${MAX_FEED_BYTES / 1024 / 1024} MB, so the mirror read the first part of it. A smaller feed, or one collection, keeps it complete.`
        : null;
    const kind = sniffFeed(text);
    if (kind === 'xml') return { items: parseXmlFeed(text, MAX_RACK_ITEMS), note };
    if (kind === 'table') {
        // A table cut short mid-row would end on half a product.
        const whole = res.truncated ? text.slice(0, text.lastIndexOf('\n')) : text;
        return { items: parseTableFeed(whole, MAX_RACK_ITEMS), note };
    }
    const shopify = shopifyProductsBase(res.finalUrl);
    if (kind === 'json' && shopify) {
        try {
            if (Array.isArray(JSON.parse(text)?.products)) return { items: await readShopify(shopify), note: null };
        } catch { /* not JSON after all */ }
    }
    // A Shopify storefront page: its catalog is one path away.
    if (kind === 'html' && shopify && /cdn\.shopify\.com|\/cdn\/shop\/|Shopify\.theme|shopify-section/i.test(text)) {
        return { items: await readShopify(shopify), note: null };
    }
    throw new HttpError(422, 'That link isn’t a product feed. Use your Google Shopping feed URL, or a link to your Shopify store or one of its collections.', 'not_a_feed');
}

function feedProblem(e: unknown): string {
    if (e instanceof HttpError) {
        if (e.code === 'link_blocked') return 'Your site refused our request for the feed. If it blocks automated requests, allow EmodeMirror or send us the feed another way.';
        if (e.code === 'link_timeout') return 'Your feed took too long to load. Try again, or use a smaller feed or a single collection.';
        return e.message;
    }
    console.error('feed read failed', e);
    return 'We couldn’t read your feed just now. Try again in a few minutes.';
}

/** The live listings of the Emode Business account behind a store. */
async function readEmodeShop(ownerId: string): Promise<FeedItem[]> {
    const { data } = await admin.from('products')
        .select('id, name, price, category, image_urls, external_links')
        .eq('seller_id', ownerId).eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(MAX_RACK_ITEMS);
    return (data || [])
        .filter((p: any) => Array.isArray(p.image_urls) && typeof p.image_urls[0] === 'string')
        .map((p: any) => ({
            externalId: `emode:${p.id}`,
            name: String(p.name || 'Piece').slice(0, 300),
            brand: null,
            price: p.price != null ? Number(p.price) : null,
            currency: 'USD',
            imageUrl: p.image_urls[0],
            productUrl: typeof p.external_links?.website === 'string' ? p.external_links.website : null,
            category: categoryFromText(p.category, p.name),
        }));
}

/** Claim the right to refresh a store's catalog. False if a refresh is under way. */
async function claimCatalogSync(storeId: string): Promise<boolean> {
    const cutoff = new Date(Date.now() - CATALOG_SYNC_LOCK_MS).toISOString();
    const { data } = await admin.from('mirror_stores')
        .update({ catalog_sync_started_at: new Date().toISOString() })
        .eq('id', storeId)
        .or(`catalog_sync_started_at.is.null,catalog_sync_started_at.lt.${cutoff}`)
        .select('id');
    return !!data?.length;
}

/**
 * Copy a store's catalog into its rack. Pieces that have left the catalog are
 * switched off, not deleted. If the feed itself can't be read this time, its
 * pieces stay as they were: a store's site being down for a minute should not
 * empty the mirror.
 */
async function syncCatalog(store: any, preread?: { items: FeedItem[]; note: string | null }) {
    const started = new Date().toISOString();
    let message: string | null = null;
    let feedFailed = false;
    const rows: (FeedItem & { source: 'feed' | 'emode' })[] = [];

    if (store.catalog_feed_url) {
        try {
            const { items, note } = preread ?? await readFeed(store.catalog_feed_url);
            message = items.length ? note : 'We read your feed, but found no in-stock clothing with photos in it.';
            for (const i of items) rows.push({ ...i, source: 'feed' });
        } catch (e) {
            feedFailed = true;
            message = feedProblem(e);
        }
    }
    if (store.owner_id) {
        for (const i of await readEmodeShop(store.owner_id)) rows.push({ ...i, source: 'emode' });
    }

    const seen = new Set<string>();
    const records = rows
        .filter((r) => !seen.has(r.externalId) && seen.add(r.externalId))
        .slice(0, MAX_RACK_ITEMS)
        .map((r, position) => ({
            store_id: store.id,
            source: r.source,
            external_id: r.externalId,
            name: r.name.slice(0, 300),
            brand: r.brand,
            price: r.price,
            currency: r.currency && /^[A-Z]{3}$/.test(r.currency) ? r.currency : null,
            image_url: r.imageUrl,
            product_url: r.productUrl,
            category: r.category,
            is_active: true,
            position,
            synced_at: started,
        }));
    for (let i = 0; i < records.length; i += 500) {
        const { error } = await admin.from('mirror_store_products')
            .upsert(records.slice(i, i + 500), { onConflict: 'store_id,external_id' });
        if (error) throw new Error(`catalog upsert failed: ${error.message}`);
    }

    let gone = admin.from('mirror_store_products')
        .update({ is_active: false })
        .eq('store_id', store.id).eq('is_active', true).lt('synced_at', started);
    if (feedFailed) gone = gone.neq('source', 'feed');
    await gone;

    await admin.from('mirror_stores')
        .update({ catalog_synced_at: new Date().toISOString(), catalog_sync_message: message })
        .eq('id', store.id);
    return { count: await rackCount(store.id), message };
}

/** Keep a store's rack fresh while its mirrors are on: at most every couple of hours. */
function maybeRefreshCatalog(store: any) {
    if (!store || (!store.catalog_feed_url && !store.owner_id)) return;
    const last = store.catalog_synced_at ? Date.parse(store.catalog_synced_at) : 0;
    if (Date.now() - last < CATALOG_REFRESH_HOURS * 3_600_000) return;
    background((async () => {
        if (await claimCatalogSync(store.id)) await syncCatalog(store);
    })());
}

/** The store behind a dashboard link, or a refusal. */
async function requireStoreLink(body: any) {
    const storeId = requireUuid(body?.storeId, 'store');
    const token = typeof body?.token === 'string' ? body.token : '';
    const { data: store } = await admin.from('mirror_stores')
        .select(STORE_FIELDS)
        .eq('id', storeId)
        .eq('dashboard_token_hash', await sha256Hex(token))
        .maybeSingle();
    if (!store || token.length < 20) {
        throw new HttpError(404, 'That dashboard link isn’t valid. Ask Emode for a new one.', 'bad_link');
    }
    return store;
}

/** What the dashboard says about a store's rack. */
async function rackStatus(store: any) {
    const [{ data: preview }, { data: cats }] = await Promise.all([
        admin.from('mirror_store_products')
            .select('id, name, price, currency, image_url')
            .eq('store_id', store.id).eq('is_active', true)
            .order('position').limit(12),
        admin.from('mirror_store_products')
            .select('category')
            .eq('store_id', store.id).eq('is_active', true)
            .limit(MAX_RACK_ITEMS),
    ]);
    const byCategory: Record<string, number> = {};
    for (const c of cats || []) byCategory[c.category] = (byCategory[c.category] || 0) + 1;
    const started = store.catalog_sync_started_at ? Date.parse(store.catalog_sync_started_at) : 0;
    const finished = store.catalog_synced_at ? Date.parse(store.catalog_synced_at) : 0;
    return {
        feedUrl: store.catalog_feed_url,
        emodeShop: !!store.owner_id,
        count: (cats || []).length,
        byCategory,
        syncedAt: store.catalog_synced_at,
        syncing: started > finished && Date.now() - started < CATALOG_SYNC_LOCK_MS,
        message: store.catalog_sync_message,
        preview: (preview || []).map((p: any) => ({
            id: p.id,
            name: p.name,
            price: p.price != null ? Number(p.price) : null,
            currency: p.currency,
            imageUrl: p.image_url,
        })),
    };
}

/**
 * The bytes of an image that lives in Emode's own storage or on the open web.
 * Own storage is read directly; anything else goes through the same
 * public-address-only fetch as product links. Anything else (file://) is null.
 */
async function fetchImage(url: string): Promise<Uint8Array | null> {
    const own = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/`;
    if (url.startsWith(own)) {
        const rest = decodeURIComponent(url.slice(own.length).split('?')[0]);
        const bucket = rest.slice(0, rest.indexOf('/'));
        const { data } = await admin.storage.from(bucket).download(rest.slice(bucket.length + 1));
        return data ? new Uint8Array(await data.arrayBuffer()) : null;
    }
    if (/^https?:\/\//i.test(url)) {
        const fetched = await fetchCapped(await assertPublicUrl(url), MAX_IMAGE_BYTES, 'image/webp,image/png,image/jpeg,*/*');
        return fetched.truncated ? null : fetched.bytes;
    }
    return null;
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
        .select('id, name, location, proto_serial, theme, daily_look_limit, active, kind, store_id, framing, credit')
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
        // A phone has scanned the code, so it can work as the camera button.
        phonePaired: !!session.phone_seen_at,
        // The mirror's camera is on and waiting for the photo.
        cameraOpen: session.status === 'active' && !!session.camera_open_at
            && now - new Date(session.camera_open_at).getTime() < CAMERA_OPEN_MINUTES * 60_000,
        endedAt: session.ended_at,
        retainUntil: session.ended_at
            ? new Date(new Date(session.ended_at).getTime() + RETAIN_AFTER_END_MINUTES * 60_000).toISOString()
            : null,
        garments: await Promise.all((garments || []).map(async (g: any) => ({
            id: g.id,
            source: g.source,
            category: g.category,
            description: g.description,
            productId: g.store_product_id,
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
            // What was tried, for the store's dashboard. Public products only:
            // a store's own listing, or a product page's store and name. A
            // shopper's screenshots and the names of their wardrobe pieces are
            // theirs, and are recorded as nothing but their kind.
            items: garments.map((g: any) => ({
                source: g.source,
                productId: g.source === 'catalog' ? g.store_product_id : null,
                host: g.source === 'link' ? hostOf(g.product_url) : null,
                title: g.source === 'link' || g.source === 'catalog' ? (g.title || '').slice(0, 80) : null,
            })),
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

async function fetchCapped(url: URL, maxBytes: number, accept: string, timeoutMs = 10_000): Promise<{ bytes: Uint8Array; type: string; finalUrl: string; truncated: boolean }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
        const store = await storeOf(device);
        maybeRefreshCatalog(store);
        const rackId = await rackStoreId(store);
        const rackSize = rackId ? await rackCount(rackId) : 0;
        const ownRack = !!store && rackId === store.id;
        return json({
            device: { name: device.name, location: device.location, theme: device.theme, kind: device.kind },
            store: store ? { name: store.name, logoUrl: store.logo_url, hasRack: ownRack && rackSize > 0 } : null,
            // What can be tried on without a phone: the store's rack, or Emode's.
            rack: { available: rackSize > 0, house: rackSize > 0 && !ownRack },
            framing: device.framing ?? null,
            // A credit line for this mirror (the workplace demo), shown with a
            // QR code to the person's profile. Null on every other mirror.
            credit: device.credit ?? null,
            // Whether this mirror offers Live (the realtime try-on).
            live: !!DECART_API_KEY,
            limits: { garmentsPerLook: MAX_GARMENTS_PER_LOOK, idleMinutes: IDLE_MINUTES, retainMinutes: RETAIN_AFTER_END_MINUTES },
        });
    }

    // How far the photo screen zooms in for this mirror's camera, set from
    // /calibrate on the screen itself. Null goes back to the full frame.
    if (action === 'device.framing') {
        const device = await requireDevice(req, body);
        const f = body?.framing;
        let framing = null;
        if (f) {
            const zoom = Number(f.zoom);
            const cx = Number(f.cx);
            const cy = Number(f.cy);
            if (![zoom, cx, cy].every(Number.isFinite) || zoom < 1 || zoom > 4 || cx < 0 || cx > 1 || cy < 0 || cy > 1) {
                throw new HttpError(400, 'Invalid framing');
            }
            const r = (n: number) => Math.round(n * 1000) / 1000;
            framing = { zoom: r(zoom), cx: r(cx), cy: r(cy) };
        }
        await admin.from('mirror_devices').update({ framing }).eq('id', device.id);
        return json({ ok: true, framing });
    }

    if (action === 'session.start') {
        const device = await requireDevice(req, body);
        if (body?.consent !== true || body?.adult !== true) {
            throw new HttpError(400, 'Consent is required before the mirror can take a photo', 'consent_required');
        }
        let client: string | null = null;
        if (device.kind === 'web') {
            client = await clientHash(req);
            if (client) {
                const { count } = await admin.from('mirror_sessions')
                    .select('id', { count: 'exact', head: true })
                    .eq('client_hash', client)
                    .gte('created_at', new Date(Date.now() - 3_600_000).toISOString());
                if ((count || 0) >= WEB_VISITS_PER_HOUR) {
                    throw new HttpError(429, 'You’ve started a few visits in a row — give it a little while and try again.', 'visitor_limit');
                }
            }
        }
        const token = randomToken();
        const { data: session, error } = await admin.from('mirror_sessions')
            .insert({
                device_id: device.id,
                upload_token_hash: await sha256Hex(token),
                consent_at: new Date().toISOString(),
                client_hash: client,
            })
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
            .update({ person_path: path, last_activity_at: new Date().toISOString(), camera_open_at: null, shutter_at: null })
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
            .select('id, image_path, title, source, product_url, store_product_id').eq('session_id', session.id).in('id', ids);
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

        if (device.kind === 'web' && session.client_hash) {
            const { count: recent } = await admin.from('mirror_looks')
                .select('id, mirror_sessions!inner(client_hash)', { count: 'exact', head: true })
                .eq('mirror_sessions.client_hash', session.client_hash)
                .gte('created_at', new Date(Date.now() - 3_600_000).toISOString());
            if ((recent || 0) >= WEB_LOOKS_PER_HOUR) {
                throw new HttpError(429, 'That’s a lot of looks for one hour — take a breather and come back soon.', 'visitor_limit');
            }
        }

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

    // The photo screen tells the phone when it is waiting, so the phone can
    // offer its own "Take my photo" button, and asks whether it was pressed.
    if (action === 'session.camera') {
        const device = await requireDevice(req, body);
        const session = await requireKioskSession(device, body?.sessionId);
        await admin.from('mirror_sessions')
            .update({ camera_open_at: body?.open === true ? new Date().toISOString() : null, shutter_at: null })
            .eq('id', session.id);
        return json({ ok: true });
    }

    if (action === 'session.shutter') {
        const device = await requireDevice(req, body);
        const id = requireUuid(body?.sessionId, 'session');
        // Consumed as it is read, so one press on the phone is one photo.
        const { data } = await admin.from('mirror_sessions')
            .update({ shutter_at: null })
            .eq('id', id).eq('device_id', device.id).eq('status', 'active')
            .not('shutter_at', 'is', null)
            .select('id');
        return json({ pressed: !!data?.length });
    }

    // ── Live try-on ───────────────────────────────────────────────────────
    //
    // The kiosk streams the camera to Decart directly over WebRTC; this only
    // hands it a one-minute token for each connect, so the real key never
    // reaches a screen. Tokens are limited to the try-on model, and to a
    // dozen connects per visit.
    if (action === 'live.token') {
        const device = await requireDevice(req, body);
        const session = await requireKioskSession(device, body?.sessionId);
        if (!DECART_API_KEY) throw new HttpError(503, 'Live isn’t set up on this mirror.', 'live_off');
        const { count } = await admin.from('mirror_events')
            .select('id', { count: 'exact', head: true })
            .eq('session_id', session.id).eq('type', 'live_started');
        if ((count || 0) >= MAX_LIVE_CONNECTS_PER_VISIT) {
            throw new HttpError(429, 'That’s plenty of live for one visit — take a photo of your favourite.', 'live_limit');
        }
        const res = await fetch('https://api.decart.ai/v1/client/tokens', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': DECART_API_KEY },
            body: JSON.stringify({
                expiresIn: 60,
                allowedModels: DECART_LIVE_MODELS,
                metadata: { device: device.id, session: session.id },
            }),
        });
        if (!res.ok) {
            console.error('decart token failed', res.status, (await res.text().catch(() => '')).slice(0, 300));
            throw new HttpError(502, 'Live isn’t available right now.', 'live_unavailable');
        }
        const token = await res.json();
        await touch(session.id);
        return json({ apiKey: token.apiKey, expiresAt: token.expiresAt });
    }

    // Live time, for cost: logged when a live stretch starts and ends.
    if (action === 'live.log') {
        const device = await requireDevice(req, body);
        const session = await requireKioskSession(device, body?.sessionId, { active: false });
        const phase = body?.phase === 'ended' ? 'ended' : 'started';
        const seconds = Math.min(3600, Math.max(0, Math.round(Number(body?.seconds) || 0)));
        logEvent(device.id, session.id, phase === 'ended' ? 'live_ended' : 'live_started', phase === 'ended' ? { seconds } : {});
        await touch(session.id);
        return json({ ok: true });
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

    // ── A store's rack, tried on without a phone ──────────────────────────
    if (action === 'catalog.list') {
        const device = await requireDevice(req, body);
        const rackId = await rackStoreId(await storeOf(device));
        if (!rackId) return json({ items: [] });
        const { data } = await admin.from('mirror_store_products')
            .select('id, name, brand, price, currency, image_url, category, gender, description')
            .eq('store_id', rackId).eq('is_active', true)
            .order('position')
            .limit(MAX_RACK_ITEMS);
        return json({
            items: (data || []).map((p: any) => ({
                id: p.id,
                name: p.name,
                brand: p.brand,
                price: p.price != null ? Number(p.price) : null,
                currency: p.currency,
                imageUrl: p.image_url,
                category: p.category,
                gender: p.gender,
                description: p.description,
            })),
        });
    }

    if (action === 'garment.from_catalog') {
        const device = await requireDevice(req, body);
        const session = await requireKioskSession(device, body?.sessionId);
        const productId = requireUuid(body?.productId, 'product');
        const rackId = await rackStoreId(await storeOf(device));
        if (!rackId) throw new HttpError(404, 'This mirror has no rack');

        // Picking the same piece twice should not fill the mirror with copies.
        const { data: existing } = await admin.from('mirror_garments')
            .select('id').eq('session_id', session.id).eq('store_product_id', productId).maybeSingle();
        if (existing) return json({ ok: true, garmentId: existing.id });

        if (await garmentCount(session.id) >= MAX_GARMENTS_PER_SESSION) {
            throw new HttpError(429, `That's ${MAX_GARMENTS_PER_SESSION} pieces — take one off to add another`, 'garment_limit');
        }
        // Only this store's own rack, whatever id the screen sends.
        const { data: product } = await admin.from('mirror_store_products')
            .select('id, name, brand, image_url, product_url, category, is_active, description')
            .eq('id', productId).eq('store_id', rackId).maybeSingle();
        if (!product || !product.is_active) throw new HttpError(404, 'That piece is no longer on the rack');

        let bytes: Uint8Array | null = null;
        try {
            bytes = await fetchImage(product.image_url);
        } catch (e) {
            console.warn('rack photo failed', product.id, e instanceof Error ? e.message : e);
        }
        const type = bytes ? sniffImage(bytes) : null;
        if (!bytes || !type) throw new HttpError(422, 'That piece’s photo couldn’t be loaded — try another.', 'bad_image');

        const id = await addGarment(session, { bytes, ...type }, {
            source: 'catalog',
            // The name alone: a catalog's "brand" is often an internal label
            // (Shopify vendors like "SS25 Other"), not something to show.
            title: product.name,
            productUrl: product.product_url,
            // The catalog's own category, unless it had none to give.
            category: product.category !== 'other' ? product.category : null,
            storeProductId: product.id,
            description: product.description,
        });
        await touch(session.id);
        return json({ ok: true, garmentId: id });
    }

    // ── The store's dashboard, by private link ───────────────────────────
    if (action === 'store.dashboard') {
        const store = await requireStoreLink(body);

        const days = Math.min(90, Math.max(1, Number(body?.days) || 30));
        const since = new Date(Date.now() - (days - 1) * 86_400_000);
        since.setUTCHours(0, 0, 0, 0);

        const { data: devices } = await admin.from('mirror_devices')
            .select('id, name, location, last_seen_at, active')
            .eq('store_id', store.id)
            .order('created_at');
        const deviceIds = (devices || []).map((d: any) => d.id);
        const { data: events } = deviceIds.length
            ? await admin.from('mirror_events')
                .select('device_id, type, meta, created_at')
                .in('device_id', deviceIds)
                .gte('created_at', since.toISOString())
                .order('created_at')
                .limit(20000)
            : { data: [] as any[] };

        const totals = { visits: 0, paired: 0, looks: 0, lookSeconds: 0, appTaps: 0, linkOpens: 0, members: 0 };
        const perDevice: Record<string, { visits: number; looks: number }> = {};
        const daily: Record<string, { visits: number; looks: number }> = {};
        const rackCounts: Record<string, number> = {};
        const linkCounts: Record<string, { host: string; title: string; count: number }> = {};
        for (let d = new Date(since); d.getTime() <= Date.now(); d = new Date(d.getTime() + 86_400_000)) {
            daily[d.toISOString().slice(0, 10)] = { visits: 0, looks: 0 };
        }

        for (const e of events || []) {
            const day = String(e.created_at).slice(0, 10);
            const dev = (perDevice[e.device_id] ??= { visits: 0, looks: 0 });
            if (e.type === 'visit_started') {
                totals.visits++;
                dev.visits++;
                if (daily[day]) daily[day].visits++;
            } else if (e.type === 'phone_paired') {
                totals.paired++;
            } else if (e.type === 'look_generated') {
                totals.looks++;
                totals.lookSeconds += Number(e.meta?.seconds) || 0;
                dev.looks++;
                if (daily[day]) daily[day].looks++;
                for (const item of e.meta?.items || []) {
                    if (item.productId) rackCounts[item.productId] = (rackCounts[item.productId] || 0) + 1;
                    if (item.host) {
                        const key = `${item.host}|${item.title || ''}`;
                        (linkCounts[key] ??= { host: item.host, title: item.title || '', count: 0 }).count++;
                    }
                }
            } else if (e.type === 'app_cta_tapped') {
                totals.appTaps++;
            } else if (e.type === 'product_link_opened') {
                totals.linkOpens++;
            } else if (e.type === 'account_linked') {
                totals.members++;
            }
        }

        const topIds = Object.entries(rackCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id]) => id);
        const { data: products } = topIds.length
            ? await admin.from('mirror_store_products')
                .select('id, name, price, currency, image_url').in('id', topIds)
            : { data: [] as any[] };
        const rack = await rackStatus(store);

        return json({
            store: { name: store.name, logoUrl: store.logo_url, hasRack: rack.count > 0 },
            rack,
            days,
            totals: {
                visits: totals.visits,
                pairedRate: totals.visits ? totals.paired / totals.visits : 0,
                looks: totals.looks,
                looksPerVisit: totals.visits ? totals.looks / totals.visits : 0,
                avgLookSeconds: totals.looks ? Math.round(totals.lookSeconds / totals.looks) : 0,
                appTaps: totals.appTaps,
                linkOpens: totals.linkOpens,
                members: totals.members,
            },
            mirrors: (devices || []).map((d: any) => ({
                name: d.name,
                location: d.location,
                active: d.active,
                // The kiosk checks in every few minutes while it is on, so a
                // quiet quarter of an hour means it is off or offline.
                online: !!d.last_seen_at && Date.now() - new Date(d.last_seen_at).getTime() < 15 * 60_000,
                lastSeenAt: d.last_seen_at,
                visits: perDevice[d.id]?.visits || 0,
                looks: perDevice[d.id]?.looks || 0,
            })),
            daily: Object.entries(daily).map(([date, v]) => ({ date, ...v })),
            topRack: topIds.map((id) => {
                const p = (products || []).find((x: any) => x.id === id);
                return {
                    id,
                    name: p?.name || 'A piece no longer listed',
                    price: p?.price != null ? Number(p.price) : null,
                    currency: p?.currency ?? null,
                    imageUrl: p?.image_url || null,
                    tries: rackCounts[id],
                };
            }),
            topLinks: Object.values(linkCounts).sort((a, b) => b.count - a.count).slice(0, 10),
        });
    }

    // Point the rack at a feed (or stop using one). The feed is read before it
    // is saved, so a wrong link is refused on the spot instead of quietly
    // leaving the mirror empty.
    if (action === 'store.catalog.set') {
        const store = await requireStoreLink(body);
        const raw = typeof body?.feedUrl === 'string' ? body.feedUrl.trim().slice(0, 2000) : '';
        if (!raw) {
            await admin.from('mirror_stores').update({ catalog_feed_url: null }).eq('id', store.id);
            const fresh = { ...store, catalog_feed_url: null };
            if (await claimCatalogSync(store.id)) await syncCatalog(fresh);
            return json({ rack: await rackStatus(await requireStoreLink(body)) });
        }
        if (!(await claimCatalogSync(store.id))) {
            throw new HttpError(409, 'Your rack is already updating. Give it a minute.', 'syncing');
        }
        let preread;
        try {
            preread = await readFeed(raw);
        } catch (e) {
            await admin.from('mirror_stores').update({ catalog_sync_started_at: null }).eq('id', store.id);
            throw new HttpError(422, feedProblem(e), 'bad_feed');
        }
        if (!preread.items.length) {
            await admin.from('mirror_stores').update({ catalog_sync_started_at: null }).eq('id', store.id);
            throw new HttpError(422, 'We read that link, but found no in-stock clothing with photos in it.', 'empty_feed');
        }
        await admin.from('mirror_stores').update({ catalog_feed_url: raw }).eq('id', store.id);
        await syncCatalog({ ...store, catalog_feed_url: raw }, preread);
        return json({ rack: await rackStatus(await requireStoreLink(body)) });
    }

    if (action === 'store.catalog.sync') {
        const store = await requireStoreLink(body);
        if (!store.catalog_feed_url && !store.owner_id) {
            throw new HttpError(400, 'Add your product feed first.', 'no_source');
        }
        if (await claimCatalogSync(store.id)) await syncCatalog(store);
        return json({ rack: await rackStatus(await requireStoreLink(body)) });
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

    // The phone as the camera button, for a shopper already standing back.
    // Only while the mirror's camera is waiting; the mirror still shows the
    // photo for the shopper to use or retake before anything is kept.
    if (action === 'phone.shutter') {
        const session = await requirePhoneSession(body);
        const open = !!session.camera_open_at
            && Date.now() - new Date(session.camera_open_at).getTime() < CAMERA_OPEN_MINUTES * 60_000;
        if (!open) throw new HttpError(409, 'The mirror isn’t ready for a photo right now.', 'camera_closed');
        await admin.from('mirror_sessions').update({ shutter_at: new Date().toISOString() }).eq('id', session.id);
        await touch(session.id);
        return json({ ok: true });
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
