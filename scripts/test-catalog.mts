// Checks the catalog parsers on the feed shapes retailers actually publish.
//
//   node scripts/test-catalog.mts
//
// Runs the parsing module directly (Node strips the types); no network.

import {
    categoryFromText, parsePrice, parseXmlFeed, parseTableFeed, parseShopifyProducts,
    shopifyProductsBase, sniffFeed,
} from '../supabase/functions/mirror/catalog.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
    if (!ok) failed++;
}

// ── Google Merchant Center, RSS 2.0 ─────────────────────────────────────────
const rss = `<?xml version="1.0"?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0"><channel>
<title>Store feed</title><link>https://shop.example.com</link>
<item>
  <g:id>TEE-BLK-S</g:id><g:title><![CDATA[Heavyweight Tee — Black & Grey]]></g:title>
  <g:link>https://shop.example.com/p/tee?color=black</g:link>
  <g:image_link>https://cdn.example.com/tee-black.jpg</g:image_link>
  <g:price>40.00 USD</g:price><g:sale_price>29.50 USD</g:sale_price>
  <g:availability>in stock</g:availability><g:item_group_id>TEE</g:item_group_id>
  <g:google_product_category>Apparel &amp; Accessories &gt; Clothing &gt; Shirts &amp; Tops</g:google_product_category>
  <g:brand>Example</g:brand>
</item>
<item>
  <g:id>TEE-BLK-M</g:id><g:title>Heavyweight Tee — Black</g:title>
  <g:link>https://shop.example.com/p/tee?color=black</g:link>
  <g:image_link>https://cdn.example.com/tee-black.jpg</g:image_link>
  <g:price>40.00 USD</g:price><g:availability>in stock</g:availability><g:item_group_id>TEE</g:item_group_id>
</item>
<item>
  <g:id>TEE-WHT-M</g:id><g:title>Heavyweight Tee — White</g:title>
  <g:link>https://shop.example.com/p/tee?color=white</g:link>
  <g:image_link>https://cdn.example.com/tee-white.jpg</g:image_link>
  <g:price>40.00 USD</g:price><g:availability>in stock</g:availability><g:item_group_id>TEE</g:item_group_id>
</item>
<item>
  <g:id>COAT-1</g:id><g:title>Wool Overcoat</g:title><g:link>https://shop.example.com/p/coat</g:link>
  <g:image_link>https://cdn.example.com/coat.jpg</g:image_link><g:price>1.299,00 EUR</g:price>
  <g:availability>out_of_stock</g:availability>
</item>
<item>
  <g:id>CANDLE</g:id><g:title>Fig Candle</g:title><g:link>https://shop.example.com/p/candle</g:link>
  <g:image_link>https://cdn.example.com/candle.jpg</g:image_link><g:price>30 USD</g:price>
  <g:google_product_category>Home &amp; Garden &gt; Decor &gt; Candles</g:google_product_category>
</item>
<item>
  <g:id>DRESS-1</g:id><g:title>Linen Shirt Dress</g:title><g:link>https://shop.example.com/p/dress</g:link>
  <g:image_link>https://cdn.example.com/dress.jpg</g:image_link><g:price>89.00 USD</g:price>
  <g:product_type>Women &gt; Dresses</g:product_type>
</item>
<item><g:id>NOIMG</g:id><g:title>No photo</g:title></item>
</channel></rss>`;

check('RSS feed is recognised as XML', sniffFeed(rss) === 'xml');
const fromRss = parseXmlFeed(rss);
check('sizes of one colour become one piece; colours stay separate', fromRss.filter((i) => i.name.startsWith('Heavyweight')).length === 2,
    fromRss.map((i) => i.externalId).join(', '));
check('out-of-stock, non-clothing and photo-less items are skipped',
    !fromRss.some((i) => ['COAT-1', 'CANDLE', 'NOIMG'].includes(i.externalId)));
const tee = fromRss.find((i) => i.externalId === 'TEE-BLK-S');
check('CDATA and entities are decoded', tee?.name === 'Heavyweight Tee — Black & Grey', tee?.name);
check('sale price wins over list price', tee?.price === 29.5 && tee?.currency === 'USD', `${tee?.price} ${tee?.currency}`);
check('Google category maps to tops', tee?.category === 'tops');
check('product link and brand are kept', tee?.productUrl === 'https://shop.example.com/p/tee?color=black' && tee?.brand === 'Example');
check('a shirt dress is a dress', fromRss.find((i) => i.externalId === 'DRESS-1')?.category === 'dresses');

// ── Atom ────────────────────────────────────────────────────────────────────
const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:g="http://base.google.com/ns/1.0">
<entry><g:id>J1</g:id><title>Denim Trucker Jacket</title><link href="https://shop.example.com/j1"/>
<g:image_link>https://cdn.example.com/j1.jpg</g:image_link><g:price>98 USD</g:price></entry></feed>`;
const fromAtom = parseXmlFeed(atom);
check('Atom entries with <link href> are read', fromAtom[0]?.productUrl === 'https://shop.example.com/j1' && fromAtom[0]?.category === 'outerwear');

// ── Tab-separated, the other Merchant Center format ─────────────────────────
const tsv = 'id\ttitle\tlink\timage_link\tprice\tavailability\tproduct_type\n'
    + 'P1\tBoot-Cut Jeans\thttps://shop.example.com/p1\thttps://cdn.example.com/p1.jpg\t79.00 USD\tin stock\tMen > Jeans\n'
    + 'P2\tChelsea Boot\thttps://shop.example.com/p2\thttps://cdn.example.com/p2.jpg\t150.00 USD\tin stock\tShoes\n'
    + 'P3\tGone\thttps://shop.example.com/p3\thttps://cdn.example.com/p3.jpg\t1 USD\tout of stock\t\n';
check('TSV feed is recognised as a table', sniffFeed(tsv) === 'table');
const fromTsv = parseTableFeed(tsv);
check('TSV rows are read and out of stock dropped', fromTsv.length === 2, fromTsv.map((i) => i.name).join(', '));
check('boot-cut jeans are bottoms, a Chelsea boot is shoes',
    fromTsv[0]?.category === 'bottoms' && fromTsv[1]?.category === 'shoes', fromTsv.map((i) => i.category).join(', '));

// ── CSV with quotes and the obvious column names ────────────────────────────
const csv = 'sku,name,image,url,price\n"A-1","Cable Knit Sweater, Cream","https://cdn.example.com/a1.jpg","https://shop.example.com/a1","$120"\n';
const fromCsv = parseTableFeed(csv);
check('CSV with quoted commas', fromCsv[0]?.name === 'Cable Knit Sweater, Cream' && fromCsv[0]?.price === 120 && fromCsv[0]?.category === 'tops',
    JSON.stringify(fromCsv[0]));

// ── Shopify ─────────────────────────────────────────────────────────────────
check('a store link reads the whole catalog', shopifyProductsBase('https://shop.example.com/') === 'https://shop.example.com/products.json');
check('a collection link reads just that collection',
    shopifyProductsBase('https://shop.example.com/collections/mirror?sort=new') === 'https://shop.example.com/collections/mirror/products.json');
check('a localised collection link too',
    shopifyProductsBase('https://shop.example.com/en-ca/collections/mens/products.json') === 'https://shop.example.com/collections/mens/products.json');
const shopify = {
    products: [
        { id: 1, title: 'Pleated Trouser', handle: 'pleated-trouser', vendor: 'Example', product_type: 'Pants', tags: ['new'],
          variants: [{ price: '120.00', available: true }, { price: '110.00', available: false }],
          images: [{ src: 'https://cdn.shopify.com/s/files/1/0/files/trouser.jpg?v=1' }] },
        { id: 2, title: 'Gift Card', handle: 'gift-card', product_type: 'Gift Card', variants: [{ price: '25', available: true }],
          images: [{ src: 'https://cdn.shopify.com/s/files/gc.jpg' }] },
        { id: 3, title: 'Sold Out Hoodie', handle: 'hoodie', product_type: 'Hoodies', variants: [{ price: '80', available: false }],
          images: [{ src: 'https://cdn.shopify.com/s/files/h.jpg' }] },
        { id: 4, title: 'No Photo Tee', handle: 'tee', variants: [{ price: '20', available: true }], images: [] },
    ],
};
const fromShopify = parseShopifyProducts(shopify, 'https://shop.example.com');
check('Shopify: gift cards, sold-out and photo-less products skipped', fromShopify.length === 1, fromShopify.map((i) => i.name).join(', '));
check('Shopify: lowest in-stock price, product page, resized image',
    fromShopify[0]?.price === 120 && fromShopify[0]?.productUrl === 'https://shop.example.com/products/pleated-trouser'
    && fromShopify[0]?.imageUrl.includes('width=1200') && fromShopify[0]?.category === 'bottoms', JSON.stringify(fromShopify[0]));

// ── Odds and ends ───────────────────────────────────────────────────────────
check('decimal-comma prices', parsePrice('1.299,00 EUR').price === 1299 && parsePrice('1.299,00 EUR').currency === 'EUR');
check('"short sleeve shirt" is a top, not shorts', categoryFromText('Short Sleeve Oxford Shirt') === 'tops');
check('"laptop sleeve" is not a top', categoryFromText('Laptop Sleeve') === 'other');
check('an HTML page is not a feed', sniffFeed('<!DOCTYPE html><html><head></head><body></body></html>') === 'html');

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
