// A retailer's catalog, read from what it already publishes.
//
// Retailers don't re-enter their products for a new channel. Nearly all of
// them already publish one of these, so the mirror reads them as they are:
//
//   a Google Shopping (Merchant Center) feed -- RSS/Atom XML, or tab/comma
//                separated, the format every large retailer keeps for Google;
//   a Shopify store or collection -- its public products.json, so a store can
//                curate what the mirror shows with an ordinary collection.
//
// Pure functions only (no network, no Deno APIs) so the parsing can be tested
// on its own. Fetching lives in index.ts, behind the public-address check.

export const CATEGORIES = ['tops', 'outerwear', 'bottoms', 'dresses', 'shoes', 'accessories', 'other'] as const;
export type Category = typeof CATEGORIES[number];

export interface FeedItem {
    externalId: string;
    name: string;
    brand: string | null;
    price: number | null;
    currency: string | null;
    imageUrl: string;
    productUrl: string | null;
    category: Category;
}

/**
 * A category from a product's own words: its type, its Google category path,
 * its title. Checked most-specific first, so a "shirt dress" is a dress, a
 * "shirt jacket" is outerwear and "boot-cut jeans" are bottoms. Anything
 * unrecognised is "other" -- the tabs are a convenience, not a gate.
 */
export function categoryFromText(...texts: (string | null | undefined)[]): Category {
    for (const raw of texts) {
        const s = ` ${(raw || '').toLowerCase()} `;
        if (s.trim() === '') continue;
        if (/\b(dress(es)?|jumpsuits?|rompers?|playsuits?|gowns?|overalls?|dungarees)\b/.test(s)) return 'dresses';
        if (/\b(jackets?|shackets?|coats?|overcoats?|parkas?|blazers?|puffers?|anoraks?|windbreakers?|trench|bombers?|gilets?|outerwear)\b/.test(s)) return 'outerwear';
        if (/\b(pants?|trousers?|jeans?|denim shorts|shorts|skirts?|skorts?|leggings?|joggers?|chinos?|sweatpants?|culottes?|cargos?|bottoms)\b/.test(s)) return 'bottoms';
        if (/\b(t-?shirts?|shirts?|tees?|tops?|blouses?|sweaters?|knitwear|hoodies?|hoody|cardigans?|polos?|tanks?|camis?|camisoles?|pullovers?|sweatshirts?|crewnecks?|jerseys?|bodysuits?|henleys?|turtlenecks?|tunics?)\b/.test(s)) return 'tops';
        if (/\b(shoes?|sneakers?|trainers?|boots?|sandals?|loafers?|heels?|pumps|slides?|mules?|clogs?|footwear|flats|slippers?|espadrilles?)\b/.test(s)) return 'shoes';
        if (/\b(bags?|handbags?|totes?|backpacks?|hats?|caps?|beanies?|jewel(le)?ry|necklaces?|earrings?|rings?|bracelets?|belts?|scarf|scarves|sunglasses|glasses|socks?|wallets?|watch(es)?|gloves?|accessor(y|ies))\b/.test(s)) return 'accessories';
    }
    return 'other';
}

// ──────────────────────────────────────────────────────────────── helpers ────

function decodeEntities(s: string) {
    const named: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
    return s
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
        .replace(/&([a-z]+);/gi, (m, name) => named[name.toLowerCase()] ?? m);
}

function clean(s: string | null | undefined, max = 300): string | null {
    if (s == null) return null;
    const out = decodeEntities(String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'))
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return out ? out.slice(0, max) : null;
}

function httpUrl(s: string | null | undefined, base?: string): string | null {
    if (!s) return null;
    try {
        const u = new URL(s.trim(), base);
        return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString().slice(0, 2000) : null;
    } catch {
        return null;
    }
}

/** "29.99 USD", "USD 29.99", "29,99 EUR", "$29.99" → amount and currency. */
export function parsePrice(raw: string | null | undefined): { price: number | null; currency: string | null } {
    if (!raw) return { price: null, currency: null };
    const currency = raw.match(/\b([A-Z]{3})\b/)?.[1] ?? (raw.includes('$') ? 'USD' : raw.includes('€') ? 'EUR' : raw.includes('£') ? 'GBP' : null);
    let num = raw.replace(/[^\d.,]/g, '');
    // A comma followed by exactly two digits at the end is a decimal comma.
    if (/,\d{2}$/.test(num) && !/\.\d{2}$/.test(num)) num = num.replace(/\./g, '').replace(',', '.');
    else num = num.replace(/,/g, '');
    const price = Number.parseFloat(num);
    return { price: Number.isFinite(price) && price >= 0 && price < 10_000_000 ? Math.round(price * 100) / 100 : null, currency };
}

const OUT_OF_STOCK = /out[\s_-]?of[\s_-]?stock|discontinued|sold[\s_-]?out/i;
// Google product category roots that are never something to wear.
const NOT_CLOTHING = /^\s*(home|electronics|toys|food|health|hardware|furniture|office|software|media|vehicles|animals|arts|business|cameras|religious)\b/i;

/**
 * Keep one entry per thing a shopper would pick. A feed lists every size of a
 * shirt separately; the sizes share a group and a photo, and on a mirror they
 * are one piece. Different colours have different photos and stay separate.
 */
function dedupe(items: (FeedItem & { group?: string | null })[], limit: number): FeedItem[] {
    const seen = new Set<string>();
    const out: FeedItem[] = [];
    for (const item of items) {
        const key = `${item.group || item.externalId}|${item.imageUrl}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const { group: _group, ...rest } = item;
        out.push(rest);
        if (out.length >= limit) break;
    }
    return out;
}

// ─────────────────────────────────────────────────── Google Shopping XML ────

function tag(block: string, name: string): string | null {
    const re = new RegExp(`<(?:[a-z0-9]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[a-z0-9]+:)?${name}>`, 'i');
    return block.match(re)?.[1] ?? null;
}

/** A Google Merchant Center feed in RSS 2.0 (<item>) or Atom (<entry>). */
export function parseXmlFeed(xml: string, limit = 1500): FeedItem[] {
    const blocks = [...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]);
    const items: (FeedItem & { group?: string | null })[] = [];
    for (const b of blocks) {
        const id = clean(tag(b, 'id'), 200);
        const name = clean(tag(b, 'title'));
        const image = httpUrl(clean(tag(b, 'image_link'), 2000));
        if (!id || !name || !image) continue;
        if (OUT_OF_STOCK.test(clean(tag(b, 'availability')) || '')) continue;
        const googleCategory = clean(tag(b, 'google_product_category'));
        if (googleCategory && !/^\d+$/.test(googleCategory) && NOT_CLOTHING.test(googleCategory)) continue;

        // <g:link> in RSS; Atom uses <link href="..."/>.
        const link = httpUrl(clean(tag(b, 'link'), 2000))
            ?? httpUrl(b.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] ?? null);
        const sale = parsePrice(clean(tag(b, 'sale_price')));
        const regular = parsePrice(clean(tag(b, 'price')));
        const { price, currency } = sale.price != null ? sale : regular;
        const productType = clean(tag(b, 'product_type'));
        items.push({
            externalId: id,
            group: clean(tag(b, 'item_group_id'), 200),
            name,
            brand: clean(tag(b, 'brand'), 120),
            price,
            currency,
            imageUrl: image,
            productUrl: link,
            category: categoryFromText(productType, googleCategory, name),
        });
    }
    return dedupe(items, limit);
}

// ──────────────────────────────────────────── Google Shopping TSV / CSV ────

/** RFC 4180-ish: quoted fields, doubled quotes, delimiters and newlines inside quotes. */
export function parseDelimited(text: string, delimiter: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
            } else field += c;
        } else if (c === '"' && field === '') {
            quoted = true;
        } else if (c === delimiter) {
            row.push(field); field = '';
        } else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(field); field = '';
            if (row.some((f) => f !== '')) rows.push(row);
            row = [];
        } else field += c;
    }
    row.push(field);
    if (row.some((f) => f !== '')) rows.push(row);
    return rows;
}

const COLUMN: Record<string, string[]> = {
    id: ['id', 'sku', 'item id', 'product id', 'g:id'],
    title: ['title', 'name', 'product name', 'g:title'],
    image: ['image_link', 'image link', 'image', 'image url', 'image_url', 'g:image_link'],
    link: ['link', 'url', 'product url', 'product_url', 'product link', 'g:link'],
    price: ['price', 'g:price'],
    sale: ['sale_price', 'sale price', 'g:sale_price'],
    availability: ['availability', 'g:availability'],
    type: ['product_type', 'product type', 'category', 'g:product_type'],
    google: ['google_product_category', 'google product category', 'g:google_product_category'],
    group: ['item_group_id', 'item group id', 'g:item_group_id'],
    brand: ['brand', 'g:brand'],
};

/** A feed as a table, with Google's column names or the obvious ones. */
export function parseTableFeed(text: string, limit = 1500): FeedItem[] {
    const nl = text.search(/\r?\n/);
    const firstLine = nl < 0 ? text : text.slice(0, nl);
    const delimiter = firstLine.includes('\t') ? '\t' : firstLine.split(';').length > firstLine.split(',').length ? ';' : ',';
    const rows = parseDelimited(text.replace(/^﻿/, ''), delimiter);
    if (rows.length < 2) return [];
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const col = (key: string) => header.findIndex((h) => COLUMN[key].includes(h));
    const at = Object.fromEntries(Object.keys(COLUMN).map((k) => [k, col(k)]));
    if (at.id < 0 || at.title < 0 || at.image < 0) return [];
    const get = (r: string[], k: string) => (at[k] >= 0 ? r[at[k]] : null);

    const items: (FeedItem & { group?: string | null })[] = [];
    for (const r of rows.slice(1)) {
        const id = clean(get(r, 'id'), 200);
        const name = clean(get(r, 'title'));
        const image = httpUrl(get(r, 'image'));
        if (!id || !name || !image) continue;
        if (OUT_OF_STOCK.test(get(r, 'availability') || '')) continue;
        const googleCategory = clean(get(r, 'google'));
        if (googleCategory && !/^\d+$/.test(googleCategory) && NOT_CLOTHING.test(googleCategory)) continue;
        const sale = parsePrice(get(r, 'sale'));
        const regular = parsePrice(get(r, 'price'));
        const { price, currency } = sale.price != null ? sale : regular;
        items.push({
            externalId: id,
            group: clean(get(r, 'group'), 200),
            name,
            brand: clean(get(r, 'brand'), 120),
            price,
            currency,
            imageUrl: image,
            productUrl: httpUrl(get(r, 'link')),
            category: categoryFromText(clean(get(r, 'type')), googleCategory, name),
        });
    }
    return dedupe(items, limit);
}

// ──────────────────────────────────────────────────────────────── Shopify ────

/**
 * Where a Shopify link's products.json lives: the store's whole catalog, or
 * one collection's ("/collections/mirror") so a store can choose what shows.
 */
export function shopifyProductsBase(raw: string): string | null {
    try {
        const u = new URL(raw);
        let path = u.pathname.replace(/\/+$/, '');
        path = path.replace(/\/products\.json$/i, '');
        const collection = path.match(/^(?:\/[a-z]{2}(?:-[a-z]{2})?)?(\/collections\/[^/]+)/i)?.[1];
        return `${u.origin}${collection ?? ''}/products.json`;
    } catch {
        return null;
    }
}

/** Shopify's CDN resizes on request; a rack tile does not need a 4000px original. */
function shopifyImage(src: string): string {
    try {
        const u = new URL(src.startsWith('//') ? `https:${src}` : src);
        if (u.hostname === 'cdn.shopify.com' || u.pathname.startsWith('/cdn/shop/')) u.searchParams.set('width', '1200');
        return u.toString();
    } catch {
        return src;
    }
}

/** One page of a Shopify store's public products.json. */
export function parseShopifyProducts(json: any, origin: string): FeedItem[] {
    const out: FeedItem[] = [];
    for (const p of Array.isArray(json?.products) ? json.products : []) {
        const title = clean(p?.title);
        const src = p?.images?.[0]?.src;
        if (!p?.id || !title || typeof src !== 'string') continue;
        const productType = clean(p.product_type);
        if (/gift ?card/i.test(`${productType} ${title}`)) continue;
        const variants = Array.isArray(p.variants) ? p.variants : [];
        if (variants.length && !variants.some((v: any) => v?.available !== false)) continue;
        // The lowest price a shopper can actually buy it at today.
        const buyable = variants.filter((v: any) => v?.available !== false);
        const prices = buyable.map((v: any) => Number.parseFloat(v?.price)).filter((n: number) => Number.isFinite(n));
        const tags = Array.isArray(p.tags) ? p.tags.join(' ') : typeof p.tags === 'string' ? p.tags : '';
        out.push({
            externalId: `shopify:${p.id}`,
            name: title,
            brand: clean(p.vendor, 120),
            price: prices.length ? Math.min(...prices) : null,
            // products.json does not say; the store's currency is set on the store.
            currency: null,
            imageUrl: shopifyImage(src),
            productUrl: p.handle ? `${origin}/products/${encodeURIComponent(p.handle)}` : null,
            category: categoryFromText(productType, title, tags),
        });
    }
    return out;
}

/** What kind of document a feed URL returned. */
export function sniffFeed(text: string): 'json' | 'xml' | 'html' | 'table' | 'unknown' {
    const head = text.replace(/^﻿/, '').trimStart().slice(0, 2000).toLowerCase();
    if (head.startsWith('{') || head.startsWith('[')) return 'json';
    if (head.startsWith('<!doctype html') || head.startsWith('<html') || (head.includes('<head') && head.includes('<body'))) return 'html';
    if (head.startsWith('<')) return 'xml';
    const firstLine = head.split(/\r?\n/)[0];
    if (/\b(id|sku)\b/.test(firstLine) && /\b(title|name)\b/.test(firstLine)) return 'table';
    return 'unknown';
}
