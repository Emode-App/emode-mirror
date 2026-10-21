'use client';

import { useEffect, useMemo, useState } from 'react';
import { formatPrice, type Category, type Garment, type Look, type MirrorCredit, type RackItem, type StoreInfo } from '@/lib/api';
import { Qr } from '@/components/Qr';
import { Wordmark } from '@/components/Wordmark';
import { Bloom, Eyebrow, KioskButton, Title } from './ui';

// The frame is 40rem wide and ~71rem tall. Decoration lives in the top third,
// out of reach on a life-size panel; everything a visitor touches sits in the
// band an adult can reach without stretching.

/**
 * mirror.emode.style opened without a device link -- almost always a person on
 * a phone who typed the address or found it shared, not a mirror. Give them
 * the real thing to go to, and leave staff a quiet pointer to setup.
 */
export function Visitor({ appUrl }: { appUrl: string }) {
    return (
        <div className="relative flex h-full flex-col items-center px-[3.4rem] pt-[9rem] text-center">
            <Bloom className="top-[40%]" />
            <Wordmark className="relative text-[3.4rem]" />
            <div className="relative mt-auto flex flex-col items-center gap-[1.2rem]">
                <Eyebrow>Life-size try-on</Eyebrow>
                <Title className="text-[3rem]">Emode Mirror lives in stores.</Title>
                <p className="max-w-[28rem] text-[1.05rem] leading-[1.45] text-muted">
                    Find a mirror and scan its code to try on anything, life-size. To try on from anywhere, get the Emode app.
                </p>
            </div>
            <div className="relative mb-[7rem] mt-[3.4rem] flex flex-col items-center gap-[0.9rem]">
                {/* On anything bigger than a phone -- a Luma, a laptop -- the app
                    belongs on the phone in your pocket, so it's a code to scan,
                    not a button that would open the App Store on the screen
                    itself. 500px, not a tablet breakpoint: a Luma's 4K panel
                    can report a narrow width under display scaling. */}
                <div className="hidden flex-col items-center gap-[0.9rem] min-[500px]:flex">
                    <Qr value={appUrl} className="w-[9rem] p-[0.5rem]" />
                    <span className="text-[0.7rem] font-semibold uppercase tracking-[0.25em] text-faint">Scan to get the Emode app</span>
                </div>
                <a href={appUrl}
                    className="inline-flex min-h-[2.7rem] min-w-[18rem] items-center justify-center rounded-full bg-fg px-[2.2rem] font-display text-[1.05rem] font-semibold text-bg min-[500px]:hidden">
                    Get the Emode app
                </a>
                <a href="https://www.emode.style/mirror" className="font-display text-[1rem] font-semibold text-muted underline underline-offset-[0.3rem] min-[500px]:hidden">
                    How Emode Mirror works
                </a>
            </div>
            <p className="absolute bottom-[2.4rem] text-[0.55rem] text-faint">Setting up a mirror? Open /calibrate</p>
        </div>
    );
}

export function Unregistered({ message }: { message: string }) {
    return (
        <div className="flex h-full flex-col items-center justify-center gap-[1.6rem] px-[4rem] text-center">
            <Wordmark className="text-[3rem]" />
            <p className="mt-[2rem] font-display text-[1.5rem] font-semibold">{message}</p>
            <p className="text-[0.85rem] text-muted">
                Launch this screen with its device link, or open <span className="font-mono">/calibrate</span> to check the hardware.
            </p>
        </div>
    );
}

/** What a mirror offers to scan besides the visit itself. */
export interface ShareInfo {
    appUrl: string;
    /** Only on Emode's own mirrors -- a store's shoppers aren't retailers. */
    retailersUrl: string | null;
    credit: MirrorCredit | null;
}

/**
 * Codes to scan from the mirror: the Emode app (the beta, for now), Emode for
 * retailers, and a credit line where a mirror has one. Large on the start
 * screen; a compact row on the result screen, where the look is the point.
 */
function ShareCodes({ appUrl, retailersUrl, credit, size, className = '' }: ShareInfo & { size: 'lg' | 'sm'; className?: string }) {
    const lg = size === 'lg';
    const beta = /testflight\.apple\.com/i.test(appUrl);
    const codes = [
        { url: appUrl, label: beta ? 'Join the beta' : 'Get the app', hint: 'Try on anything, anywhere' },
        ...(retailersUrl ? [{ url: retailersUrl, label: 'For retailers', hint: 'Emode for your store' }] : []),
    ];
    return (
        <div className={`flex items-center justify-center ${lg ? 'flex-col gap-[1.6rem]' : 'gap-[1.6rem]'} ${className}`}>
            <div className={`flex items-start justify-center ${lg ? 'gap-[2.6rem]' : 'gap-[1.2rem]'}`}>
                {codes.map((c) => (
                    <div key={c.label} className="flex flex-col items-center gap-[0.45rem]">
                        <Qr value={c.url} className={lg ? 'w-[5.6rem] p-[0.35rem]' : 'w-[3.6rem] p-[0.22rem]'} />
                        <span className={`font-display font-semibold uppercase tracking-[0.18em] ${lg ? 'text-[0.62rem]' : 'text-[0.48rem]'}`}>{c.label}</span>
                        {lg && <span className="text-[0.55rem] text-faint">{c.hint}</span>}
                    </div>
                ))}
            </div>
            {credit && (
                <div className="flex items-center gap-[0.7rem] text-left">
                    {credit.url && <Qr value={credit.url} className={lg ? 'w-[3.6rem] p-[0.22rem]' : 'w-[3rem] p-[0.18rem]'} />}
                    <div className={lg ? 'max-w-[20rem] text-[0.62rem] leading-[1.45]' : 'max-w-[12rem] text-[0.5rem] leading-[1.4]'}>
                        <p className="text-muted">Courtesy of <span className="font-semibold text-fg">{credit.name}</span></p>
                        {credit.title && <p className="text-faint">{credit.title}</p>}
                        {credit.url && /linkedin\./i.test(credit.url) && <p className="text-faint">Scan to connect on LinkedIn</p>}
                    </div>
                </div>
            )}
        </div>
    );
}

/** "at Store", under the Emode wordmark: Emode's mirror, in their store. */
function StoreLine({ store, className = '' }: { store: StoreInfo; className?: string }) {
    return (
        <div className={`flex items-center justify-center gap-[0.7rem] ${className}`}>
            <span className="font-display text-[0.85rem] uppercase tracking-[0.3em] text-faint">at</span>
            {store.logoUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={store.logoUrl} alt="" className="h-[1.8rem] w-auto max-w-[8rem] object-contain" />
            )}
            <span className="font-display text-[1.15rem] font-semibold tracking-[-0.01em]">{store.name}</span>
        </div>
    );
}

export function Attract({ location, store, rackAvailable, share, onStart }: { location: string | null; store: StoreInfo | null; rackAvailable: boolean; share: ShareInfo; onStart: () => void }) {
    return (
        <button type="button" onClick={onStart} className="relative flex h-full w-full flex-col items-center text-center">
            <Bloom className="top-[42%]" />
            <Wordmark className="relative mt-[6rem] text-[3.6rem]" />
            {store && <StoreLine store={store} className="relative mt-[1.6rem]" />}

            <div className="relative mt-auto flex flex-col items-center gap-[1.2rem] px-[3rem]">
                <Eyebrow>A mirror that dresses you</Eyebrow>
                <Title className="text-[3.6rem]">Try on<br />anything.</Title>
                <p className="max-w-[28rem] text-[1.05rem] leading-[1.45] text-muted">
                    {store?.hasRack
                        ? `Try on ${store.name}'s pieces — or send your own from your phone.`
                        : rackAvailable
                            ? 'Pick from the rack or send clothes from your phone. See them on you, right here.'
                            : 'Send clothes from your phone. See them on you, right here.'}
                </p>
            </div>

            <div className="relative mt-[3.6rem] flex flex-col items-center gap-[0.8rem]">
                <span className="grid h-[4.2rem] w-[4.2rem] place-items-center rounded-full border-[0.08rem] border-line animate-soft-pulse">
                    <span className="h-[1.1rem] w-[1.1rem] rounded-full bg-gold" />
                </span>
                <span className="font-display text-[1.05rem] font-medium tracking-[0.02em]">Touch to begin</span>
            </div>

            <ShareCodes {...share} size="lg" className="relative mb-[4.4rem] mt-[3.6rem]" />

            {location && <span className="absolute bottom-[1.6rem] text-[0.55rem] uppercase tracking-[0.3em] text-faint">{location}</span>}
        </button>
    );
}

export function Consent({ busy, onAccept, onDecline }: { busy: boolean; onAccept: () => void; onDecline: () => void }) {
    const points = [
        ['One photo', 'The mirror takes a single photo of you to dress you in the clothes you choose.'],
        ['Deleted when you finish', 'Your photo is erased the moment you tap Finish, or if you walk away.'],
        ['Yours for an hour', 'Your looks wait on your phone for an hour so you can save them, then they’re deleted too.'],
        ['Made with AI', 'Your photo and clothes are sent to AI services to create each look — and in Live, the camera’s video while Live is on.'],
    ];
    return (
        <div className="flex h-full flex-col px-[3.4rem] pt-[8rem]">
            <Eyebrow>Before we begin</Eyebrow>
            <Title className="mt-[0.8rem]">One photo.<br />Then it&apos;s gone.</Title>

            <ul className="mt-[3rem] flex flex-col gap-[1.6rem]">
                {points.map(([head, body], i) => (
                    <li key={head} className="flex gap-[1.1rem] animate-rise" style={{ animationDelay: `${120 * i}ms` }}>
                        <span className="mt-[0.15rem] grid h-[1.8rem] w-[1.8rem] shrink-0 place-items-center rounded-full border-[0.06rem] border-gold/60 font-display text-[0.75rem] text-gold">
                            {i + 1}
                        </span>
                        <div>
                            <p className="font-display text-[1.15rem] font-semibold">{head}</p>
                            <p className="mt-[0.2rem] text-[0.88rem] leading-[1.45] text-muted">{body}</p>
                        </div>
                    </li>
                ))}
            </ul>

            <div className="mt-auto mb-[9rem] flex flex-col items-center gap-[0.9rem]">
                <KioskButton disabled={busy} onClick={onAccept}>
                    {busy ? 'Starting…' : 'I’m 18 or over — let’s go'}
                </KioskButton>
                <KioskButton tone="ghost" onClick={onDecline}>Not now</KioskButton>
            </div>
        </div>
    );
}

export function GarmentTile({
    garment,
    selectedIndex,
    onToggle,
    size = 'md',
}: {
    garment: Garment;
    selectedIndex?: number;
    onToggle?: () => void;
    size?: 'sm' | 'md';
}) {
    const selected = selectedIndex !== undefined && selectedIndex >= 0;
    const Tag = onToggle ? 'button' : 'div';
    return (
        <Tag
            {...(onToggle ? { type: 'button', onClick: onToggle } : {})}
            className={`group relative flex flex-col overflow-hidden rounded-[0.8rem] bg-surface text-left transition
                ${selected ? 'ring-[0.14rem] ring-gold' : 'ring-[0.06rem] ring-line'} ${onToggle ? 'active:scale-[0.97]' : ''}`}
        >
            <div className={`relative w-full ${size === 'sm' ? 'aspect-square' : 'aspect-[3/4]'} bg-white`}>
                {garment.imageUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={garment.imageUrl} alt={garment.title || 'Clothing'} className="absolute inset-0 h-full w-full object-contain p-[0.4rem]" />
                )}
                {selected && (
                    <span className="absolute right-[0.4rem] top-[0.4rem] grid h-[1.5rem] w-[1.5rem] place-items-center rounded-full bg-gold font-display text-[0.75rem] font-bold text-obsidian">
                        {selectedIndex! + 1}
                    </span>
                )}
            </div>
            {size === 'md' && (
                <span className="truncate px-[0.6rem] py-[0.45rem] text-[0.62rem] text-muted">
                    {garment.title || (garment.source === 'link' ? 'From a link' : 'Screenshot')}
                </span>
            )}
        </Tag>
    );
}

/** Says a wardrobe is connected without saying whose -- this is a public screen. */
function LinkedNote() {
    return (
        <p className="inline-flex items-center gap-[0.5rem] rounded-full border-[0.06rem] border-gold/50 px-[0.9rem] py-[0.35rem] text-[0.7rem] text-gold">
            <span className="h-[0.45rem] w-[0.45rem] rounded-full bg-gold" />
            Emode wardrobe connected
        </p>
    );
}

/** The quick-pick rows under the QR code, in this order when the rack has them. */
const PICK_ROWS: Category[] = ['suits', 'tops', 'bottoms', 'shoes', 'dresses', 'outerwear', 'accessories'];

function QuickPick({ item, selectedIndex, pending, onToggle }: { item: RackItem; selectedIndex: number; pending: boolean; onToggle: () => void }) {
    const selected = selectedIndex >= 0;
    return (
        <button type="button" onClick={onToggle} disabled={pending} aria-label={item.name}
            className={`relative aspect-[3/4] overflow-hidden rounded-[0.6rem] bg-white transition active:scale-[0.96]
                ${selected ? 'ring-[0.16rem] ring-gold' : ''}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={item.imageUrl} alt="" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-contain p-[0.15rem]" />
            {selected && (
                <span className="absolute right-[0.25rem] top-[0.25rem] grid h-[1.25rem] w-[1.25rem] place-items-center rounded-full bg-gold font-display text-[0.62rem] font-bold text-obsidian">
                    {selectedIndex + 1}
                </span>
            )}
            {pending && <span className="absolute inset-0 grid place-items-center bg-white/60 text-[0.5rem] text-obsidian animate-soft-pulse">Adding…</span>}
        </button>
    );
}

export function Pair({
    phoneUrl,
    garments,
    linked,
    store,
    rack,
    rackPending,
    selected,
    maxPieces,
    error,
    onToggleRack,
    onTryOn,
    onLive,
    onContinue,
    onBrowseRack,
    onCancel,
}: {
    phoneUrl: string;
    garments: Garment[];
    linked: boolean;
    store: StoreInfo | null;
    rack: RackItem[];
    rackPending: string | null;
    selected: string[];
    maxPieces: number;
    error: string | null;
    onToggleRack: (productId: string) => void;
    onTryOn: () => void;
    /** Present when this mirror offers Live. */
    onLive?: () => void;
    onContinue: () => void;
    onBrowseRack: () => void;
    onCancel: () => void;
}) {
    const own = garments.filter((g) => g.source !== 'catalog');
    const garmentForProduct = useMemo(() => {
        const m = new Map<string, string>();
        for (const g of garments) if (g.productId) m.set(g.productId, g.id);
        return m;
    }, [garments]);

    // Quick picks: a few rows by category, men's on the left and women's on
    // the right when the rack says who a piece is for, six across otherwise.
    // Enough to build a fit without a phone; the whole rack is one tap away.
    const gendered = rack.some((i) => i.gender);
    const rows = PICK_ROWS.filter((c) => rack.some((i) => i.category === c)).slice(0, 4).map((category) => {
        const inRow = rack.filter((i) => i.category === category);
        return gendered
            ? { category, left: inRow.filter((i) => i.gender === 'men').slice(0, 3), right: inRow.filter((i) => i.gender === 'women').slice(0, 3) }
            : { category, left: inRow.slice(0, 6), right: [] as RackItem[] };
    });
    const shownCount = rows.reduce((n, r) => n + r.left.length + r.right.length, 0);
    const picked = selected.length;
    const tile = (item: RackItem) => {
        const gid = garmentForProduct.get(item.id);
        return (
            <QuickPick key={item.id} item={item} pending={rackPending === item.id}
                selectedIndex={gid ? selected.indexOf(gid) : -1} onToggle={() => onToggleRack(item.id)} />
        );
    };

    return (
        <div className="flex h-full flex-col px-[2.6rem] pt-[4.4rem]">
            <div className="flex items-start justify-between gap-[1.6rem]">
                <div className="min-w-0">
                    <Eyebrow>Step one</Eyebrow>
                    <Title className="mt-[0.7rem] text-[2.4rem]">Bring your clothes.</Title>
                    <p className="mt-[0.7rem] text-[0.92rem] leading-[1.45] text-muted">
                        Scan with your phone to send screenshots or product links — or pieces from your Emode wardrobe.
                    </p>
                    {linked && <div className="mt-[0.8rem]"><LinkedNote /></div>}
                    {own.length > 0 ? (
                        <div className="mt-[1rem] flex items-center gap-[0.5rem]">
                            {own.slice(-4).map((g) => (
                                <div key={g.id} className="w-[2.8rem] animate-rise"><GarmentTile garment={g} size="sm" /></div>
                            ))}
                            <span className="ml-[0.3rem] text-[0.78rem] text-muted">{own.length} from your phone</span>
                        </div>
                    ) : (
                        <p className="mt-[1rem] text-[0.8rem] text-faint animate-soft-pulse">Waiting for your phone…</p>
                    )}
                </div>
                <Qr value={phoneUrl} className="w-[10.5rem] shrink-0 p-[0.5rem]" />
            </div>

            {rows.length > 0 && (
                <div className="mt-[1.8rem] flex min-h-0 flex-1 flex-col">
                    <div className="flex items-baseline justify-between">
                        <p className="font-display text-[1.1rem] font-semibold">Or build a fit right here</p>
                        <span className="text-[0.7rem] text-faint">Tap up to {maxPieces}</span>
                    </div>
                    {gendered && (
                        <div className="mt-[0.8rem] grid grid-cols-2 gap-[1.2rem] text-center text-[0.62rem] font-semibold uppercase tracking-[0.3em] text-gold">
                            <span>Men</span>
                            <span>Women</span>
                        </div>
                    )}
                    <div className="mt-[0.4rem] flex min-h-0 flex-col gap-[0.75rem] overflow-y-auto pb-[0.4rem] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                        {rows.map((r) => (
                            <div key={r.category}>
                                <p className="mb-[0.3rem] text-[0.62rem] font-semibold uppercase tracking-[0.2em] text-muted">{CATEGORY_LABELS[r.category]}</p>
                                {gendered ? (
                                    <div className="grid grid-cols-2 gap-[1.2rem]">
                                        <div className="grid grid-cols-3 gap-[0.45rem]">{r.left.map(tile)}</div>
                                        <div className="grid grid-cols-3 gap-[0.45rem]">{r.right.map(tile)}</div>
                                    </div>
                                ) : (
                                    <div className="grid grid-cols-6 gap-[0.45rem]">{r.left.map(tile)}</div>
                                )}
                            </div>
                        ))}
                    </div>
                    {rack.length > shownCount && (
                        <button type="button" onClick={onBrowseRack}
                            className="mt-[0.5rem] self-center text-[0.78rem] font-semibold text-muted underline underline-offset-[0.25rem]">
                            See all {rack.length}{store?.hasRack ? ` from ${store.name}` : ''}
                        </button>
                    )}
                </div>
            )}

            {error && <p className="mt-[0.8rem] rounded-[0.6rem] bg-surface px-[1rem] py-[0.6rem] text-center text-[0.8rem]">{error}</p>}

            <div className={`mb-[4.5rem] flex flex-col items-center gap-[0.7rem] ${rows.length ? 'mt-[1.2rem]' : 'mt-auto'}`}>
                {picked > 0 ? (
                    <KioskButton onClick={onTryOn}>Try it on · {picked} {picked === 1 ? 'piece' : 'pieces'}</KioskButton>
                ) : (
                    <KioskButton disabled={own.length === 0} onClick={onContinue}>
                        {own.length > 0 ? 'Continue' : rows.length ? 'Tap a piece to start' : 'Continue'}
                    </KioskButton>
                )}
                <div className="flex gap-[0.6rem]">
                    {picked > 0 && onLive && (
                        <KioskButton tone="secondary" className="min-w-[11rem]" onClick={onLive}>See it live</KioskButton>
                    )}
                    {picked > 0 && own.length > 0 && (
                        <KioskButton tone="secondary" className="min-w-[11rem]" onClick={onContinue}>Add my phone pieces</KioskButton>
                    )}
                    <KioskButton tone="ghost" className="min-w-[8rem]" onClick={onCancel}>Cancel</KioskButton>
                </div>
            </div>
        </div>
    );
}

const CATEGORY_LABELS: Record<Category, string> = {
    suits: 'Suits',
    tops: 'Tops',
    outerwear: 'Outerwear',
    bottoms: 'Bottoms',
    dresses: 'Dresses',
    shoes: 'Shoes',
    accessories: 'Accessories',
    other: 'Other',
};
const CATEGORY_ORDER: Category[] = ['suits', 'tops', 'outerwear', 'bottoms', 'dresses', 'shoes', 'accessories', 'other'];
// A retailer's rack can run to hundreds of pieces; render it a screenful at a time.
const RACK_PAGE = 48;

function RackTile({ item, selectedIndex, pending, onToggle }: { item: RackItem; selectedIndex: number; pending: boolean; onToggle: () => void }) {
    const selected = selectedIndex >= 0;
    return (
        <button type="button" onClick={onToggle} disabled={pending}
            className={`relative flex flex-col overflow-hidden rounded-[0.8rem] bg-surface text-left transition active:scale-[0.97]
                ${selected ? 'ring-[0.14rem] ring-gold' : 'ring-[0.06rem] ring-line'}`}>
            <div className="relative aspect-[3/4] w-full bg-white">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={item.imageUrl} alt={item.name} loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-contain p-[0.4rem]" />
                {selected && (
                    <span className="absolute right-[0.4rem] top-[0.4rem] grid h-[1.5rem] w-[1.5rem] place-items-center rounded-full bg-gold font-display text-[0.75rem] font-bold text-obsidian">
                        {selectedIndex + 1}
                    </span>
                )}
                {pending && <span className="absolute inset-0 grid place-items-center bg-white/60 text-[0.6rem] text-obsidian animate-soft-pulse">Adding…</span>}
            </div>
            <span className="truncate px-[0.6rem] pt-[0.45rem] text-[0.62rem]">{item.name}</span>
            {item.price != null && <span className="px-[0.6rem] pb-[0.45rem] text-[0.6rem] text-muted">{formatPrice(item.price, item.currency)}</span>}
        </button>
    );
}

export function Wardrobe({
    garments,
    selected,
    maxPieces,
    hasPhoto,
    hasLooks,
    linked,
    phoneUrl,
    error,
    store,
    rack,
    rackPending,
    initialTab,
    onToggle,
    onToggleRack,
    onTryOn,
    onLive,
    onNewPhoto,
    onBackToLooks,
    onFinish,
}: {
    garments: Garment[];
    selected: string[];
    maxPieces: number;
    hasPhoto: boolean;
    hasLooks: boolean;
    linked: boolean;
    phoneUrl: string;
    error: string | null;
    store: StoreInfo | null;
    rack: RackItem[];
    rackPending: string | null;
    initialTab: 'rack' | 'all';
    onToggle: (id: string) => void;
    onToggleRack: (productId: string) => void;
    onTryOn: () => void;
    onLive?: () => void;
    onNewPhoto: () => void;
    onBackToLooks: () => void;
    onFinish: () => void;
}) {
    // The store's rack is its own tab; the shopper's own pieces are grouped the
    // way the app's wardrobe already is. Rack pieces become garments only once
    // tapped, so they appear under the rack tab and nowhere else. A piece not
    // yet classified counts as Other until it is.
    const own = useMemo(() => garments.filter((g) => g.source !== 'catalog'), [garments]);
    const hasRack = rack.length > 0;
    const [tab, setTab] = useState<Category | 'all' | 'rack'>(hasRack ? initialTab : 'all');
    const counts = useMemo(() => {
        const c = new Map<Category, number>();
        for (const g of own) c.set(g.category ?? 'other', (c.get(g.category ?? 'other') ?? 0) + 1);
        return c;
    }, [own]);
    const tabs = CATEGORY_ORDER.filter((c) => counts.get(c));
    const showTabs = hasRack || tabs.length > 1;
    const shown = tab === 'all' || tab === 'rack' || tabs.length < 2 ? own : own.filter((g) => (g.category ?? 'other') === tab);
    const garmentForProduct = useMemo(() => {
        const m = new Map<string, string>();
        for (const g of garments) if (g.productId) m.set(g.productId, g.id);
        return m;
    }, [garments]);
    useEffect(() => {
        if (tab !== 'all' && tab !== 'rack' && !counts.get(tab)) setTab('all');
    }, [tab, counts]);

    // Within the rack, the store's own categories.
    const [rackCategory, setRackCategory] = useState<Category | 'all'>('all');
    const [rackLimit, setRackLimit] = useState(RACK_PAGE);
    const rackCounts = useMemo(() => {
        const c = new Map<Category, number>();
        for (const item of rack) c.set(item.category, (c.get(item.category) ?? 0) + 1);
        return c;
    }, [rack]);
    const rackTabs = CATEGORY_ORDER.filter((c) => rackCounts.get(c));
    const rackShown = rackCategory === 'all' ? rack : rack.filter((item) => item.category === rackCategory);
    const pickRackCategory = (c: Category | 'all') => {
        setRackCategory(c);
        setRackLimit(RACK_PAGE);
    };

    return (
        <div className="flex h-full flex-col px-[2.6rem] pt-[5rem]">
            <div className="flex items-end justify-between gap-[1rem]">
                <div>
                    <Eyebrow>Step two</Eyebrow>
                    <Title className="mt-[0.7rem] text-[2.3rem]">Build your outfit.</Title>
                    <p className="mt-[0.6rem] text-[0.92rem] text-muted">
                        Tap what you want to wear — up to {maxPieces}{hasRack ? ', from the rack or your own' : ''}.
                    </p>
                </div>
                <div className="flex shrink-0 flex-col items-center gap-[0.4rem]">
                    <Qr value={phoneUrl} className="w-[5.6rem] p-[0.4rem]" />
                    <span className="text-[0.55rem] uppercase tracking-[0.2em] text-faint">Add more</span>
                </div>
            </div>

            {(linked || showTabs) && (
                <div className="mt-[1.4rem] flex flex-col gap-[0.9rem]">
                    {linked && <LinkedNote />}
                    {showTabs && (
                        <div className="flex gap-[0.5rem] overflow-x-auto pb-[0.2rem] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                            {([...(hasRack ? ['rack'] : []), 'all', ...(tabs.length > 1 ? tabs : [])] as ('rack' | 'all' | Category)[]).map((c) => (
                                <button key={c} type="button" onClick={() => setTab(c)}
                                    className={`shrink-0 rounded-full px-[1rem] py-[0.5rem] font-display text-[0.75rem] font-semibold transition
                                        ${tab === c ? 'bg-fg text-bg' : 'border-[0.06rem] border-line text-muted'}`}>
                                    {c === 'rack'
                                        ? `${store?.hasRack ? store.name : 'The rack'} ${rack.length}`
                                        : c === 'all'
                                            ? `${hasRack ? 'Yours' : 'All'} ${own.length}`
                                            : `${CATEGORY_LABELS[c]} ${counts.get(c)}`}
                                </button>
                            ))}
                        </div>
                    )}
                    {tab === 'rack' && rackTabs.length > 1 && (
                        <div className="flex gap-[0.4rem] overflow-x-auto pb-[0.2rem] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                            {(['all', ...rackTabs] as (Category | 'all')[]).map((c) => (
                                <button key={c} type="button" onClick={() => pickRackCategory(c)}
                                    className={`shrink-0 rounded-full px-[0.85rem] py-[0.4rem] text-[0.68rem] font-semibold transition
                                        ${rackCategory === c ? 'bg-gold text-obsidian' : 'text-muted'}`}>
                                    {c === 'all' ? `All ${rack.length}` : `${CATEGORY_LABELS[c]} ${rackCounts.get(c)}`}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            )}

            <div className="mt-[1.4rem] grid min-h-0 flex-1 auto-rows-min grid-cols-3 gap-[0.9rem] overflow-y-auto pb-[1rem]">
                {tab === 'rack'
                    ? rackShown.slice(0, rackLimit).map((item) => {
                        const gid = garmentForProduct.get(item.id);
                        return (
                            <RackTile key={item.id} item={item} pending={rackPending === item.id}
                                selectedIndex={gid ? selected.indexOf(gid) : -1}
                                onToggle={() => onToggleRack(item.id)} />
                        );
                    })
                    : shown.map((g) => (
                        <GarmentTile key={g.id} garment={g} selectedIndex={selected.indexOf(g.id)} onToggle={() => onToggle(g.id)} />
                    ))}
                {tab === 'rack' && rackShown.length > rackLimit && (
                    <button type="button" onClick={() => setRackLimit((n) => n + RACK_PAGE)}
                        className="col-span-3 rounded-[0.8rem] border-[0.06rem] border-line py-[1rem] font-display text-[0.8rem] font-semibold text-muted">
                        Show more · {rackShown.length - rackLimit} left
                    </button>
                )}
                {tab !== 'rack' && own.length === 0 && (
                    <p className="col-span-3 mt-[2rem] text-center text-[0.85rem] text-faint">
                        Scan the code to send your own pieces from your phone.
                    </p>
                )}
            </div>

            {error && <p className="mb-[0.8rem] rounded-[0.6rem] bg-surface px-[1rem] py-[0.7rem] text-center text-[0.85rem]">{error}</p>}

            <div className="mb-[5.5rem] mt-[1rem] flex flex-col items-center gap-[0.8rem]">
                <KioskButton disabled={selected.length === 0} onClick={onTryOn}>
                    {selected.length === 0 ? 'Choose a piece' : `Try it on${selected.length > 1 ? ` · ${selected.length} pieces` : ''}`}
                </KioskButton>
                <div className="flex gap-[0.6rem]">
                    {onLive && selected.length > 0 && <KioskButton tone="secondary" className="min-w-[9rem]" onClick={onLive}>See it live</KioskButton>}
                    {hasPhoto && <KioskButton tone="secondary" className="min-w-[11rem]" onClick={onNewPhoto}>New photo</KioskButton>}
                    {hasLooks && <KioskButton tone="secondary" className="min-w-[11rem]" onClick={onBackToLooks}>My looks</KioskButton>}
                    <KioskButton tone="ghost" className="min-w-[8rem]" onClick={onFinish}>Finish</KioskButton>
                </div>
            </div>
        </div>
    );
}

const STYLING_LINES = ['Reading the fabric…', 'Matching your fit…', 'Getting the drape right…', 'Lighting the look…', 'Almost there…'];

export function Generating({
    photo,
    pieces,
    failure,
    onRetry,
    onChangeOutfit,
}: {
    photo: string | null;
    pieces: Garment[];
    failure: string | null;
    onRetry: () => void;
    onChangeOutfit: () => void;
}) {
    const [line, setLine] = useState(0);
    useEffect(() => {
        if (failure) return;
        const t = setInterval(() => setLine((n) => Math.min(n + 1, STYLING_LINES.length - 1)), 5000);
        return () => clearInterval(t);
    }, [failure]);

    return (
        <div className="relative h-full overflow-hidden">
            {photo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photo} alt="" className="absolute inset-0 h-full w-full object-cover opacity-35 blur-[0.15rem]" />
            ) : (
                <Bloom />
            )}
            {!failure && (
                <div className="pointer-events-none absolute inset-x-0 top-0 h-[8rem] bg-gradient-to-b from-transparent via-[var(--glow)] to-transparent" style={{ animation: 'mirror-scan 3.2s linear infinite' }} />
            )}

            <div className="relative flex h-full flex-col items-center justify-center px-[3rem] text-center">
                {failure ? (
                    <>
                        <Title className="text-[2.2rem]">That one didn&apos;t work.</Title>
                        <p className="mt-[1rem] max-w-[28rem] text-[1rem] text-muted">{failure}</p>
                        <div className="mt-[3rem] flex flex-col items-center gap-[0.9rem]">
                            <KioskButton onClick={onRetry}>Try again</KioskButton>
                            <KioskButton tone="secondary" onClick={onChangeOutfit}>Change outfit</KioskButton>
                        </div>
                    </>
                ) : (
                    <>
                        <div className="flex gap-[0.7rem]">
                            {pieces.map((g, i) => (
                                <div key={g.id} className="w-[5rem] animate-rise" style={{ animationDelay: `${i * 150}ms` }}>
                                    <GarmentTile garment={g} size="sm" />
                                </div>
                            ))}
                        </div>
                        <Title className="mt-[3rem] text-[2.6rem]">Styling you.</Title>
                        <p key={line} className="mt-[1rem] text-[1.05rem] text-muted animate-rise">{STYLING_LINES[line]}</p>
                        <p className="mt-[4rem] text-[0.75rem] text-faint">Usually 20–40 seconds.</p>
                    </>
                )}
            </div>
        </div>
    );
}

export function Result({
    look,
    looks,
    pieces,
    onSelectLook,
    share,
    onChangeOutfit,
    onNewPhoto,
    onLive,
    onFinish,
}: {
    look: Look;
    looks: Look[];
    pieces: Garment[];
    share: ShareInfo;
    onSelectLook: (id: string) => void;
    onChangeOutfit: () => void;
    onNewPhoto: () => void;
    onLive?: () => void;
    onFinish: () => void;
}) {
    const done = looks.filter((l) => l.status === 'succeeded' && l.imageUrl);
    const number = done.findIndex((l) => l.id === look.id) + 1;

    return (
        <div className="relative flex h-full flex-col">
            <div className="relative flex-1">
                {/* A shadow on the floor under the figure: the cue that makes a
                    person on a Proto read as standing inside it. */}
                <div aria-hidden className="absolute bottom-[1.5rem] left-1/2 h-[2.4rem] w-[24rem] -translate-x-1/2 rounded-[50%] blur-[1.2rem]" style={{ background: 'radial-gradient(ellipse, var(--glow), transparent 70%)' }} />
                {look.imageUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={look.imageUrl} alt="Your look" className="absolute inset-0 h-full w-full object-contain animate-rise" />
                )}
                <div className="absolute left-[2.4rem] top-[3rem]">
                    <Eyebrow>Look {number || done.length}</Eyebrow>
                </div>
            </div>

            <div className="relative bg-gradient-to-t from-[var(--bg)] via-[var(--bg)] to-transparent px-[2.6rem] pb-[2.4rem] pt-[2rem]">
                {done.length > 1 && (
                    <div className="mb-[1.2rem] flex justify-center gap-[0.5rem]">
                        {done.map((l) => (
                            <button key={l.id} type="button" onClick={() => onSelectLook(l.id)}
                                className={`h-[4.6rem] w-[2.6rem] overflow-hidden rounded-[0.4rem] ${l.id === look.id ? 'ring-[0.12rem] ring-gold' : 'opacity-60 ring-[0.06rem] ring-line'}`}>
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={l.imageUrl!} alt="" className="h-full w-full object-cover" />
                            </button>
                        ))}
                    </div>
                )}

                <div className="mb-[1.4rem] flex justify-center gap-[0.5rem]">
                    {pieces.map((g) => (
                        <div key={g.id} className="w-[3.6rem]"><GarmentTile garment={g} size="sm" /></div>
                    ))}
                </div>

                <div className="flex flex-col items-center gap-[0.8rem]">
                    <div className="flex gap-[0.6rem]">
                        <KioskButton tone="secondary" className="min-w-[13rem]" onClick={onChangeOutfit}>Change outfit</KioskButton>
                        <KioskButton tone="secondary" className="min-w-[13rem]" onClick={onNewPhoto}>New photo</KioskButton>
                    </div>
                    <div className="flex gap-[0.6rem]">
                        {onLive && <KioskButton tone="secondary" className="min-w-[13rem]" onClick={onLive}>See it live</KioskButton>}
                        <KioskButton className={onLive ? 'min-w-[13rem]' : ''} onClick={onFinish}>Finish</KioskButton>
                    </div>
                    <p className="text-[0.7rem] text-faint">When you finish, scan the code to take your looks home.</p>
                </div>

                <ShareCodes {...share} size="sm" className="mt-[1.6rem]" />
            </div>
        </div>
    );
}

export function Ending({ phoneUrl, retainUntil, onDone }: { phoneUrl: string | null; retainUntil: string | null; onDone: () => void }) {
    const [left, setLeft] = useState(20);
    useEffect(() => {
        if (left <= 0) {
            onDone();
            return;
        }
        const t = setTimeout(() => setLeft((n) => n - 1), 1000);
        return () => clearTimeout(t);
    }, [left, onDone]);

    const until = retainUntil
        ? new Date(retainUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : null;

    return (
        <div className="relative flex h-full flex-col items-center px-[3rem] pt-[9rem] text-center">
            <Bloom className="top-[38%]" />
            <Wordmark className="relative text-[2.6rem]" />
            <Title className="relative mt-[4rem]">Thanks for<br />trying it on.</Title>
            <p className="relative mt-[1.4rem] max-w-[28rem] text-[1rem] leading-[1.5] text-muted">
                Your photo has been deleted. Your looks are on your phone{until ? ` until ${until}` : ' for the next hour'} — save the ones you love.
            </p>
            {phoneUrl && (
                <div className="relative mt-[2.6rem] flex flex-col items-center gap-[0.6rem]">
                    <Qr value={phoneUrl} className="w-[8rem] p-[0.5rem]" />
                    <span className="text-[0.6rem] uppercase tracking-[0.22em] text-faint">Scan to take your looks home</span>
                </div>
            )}
            <div className="relative mt-auto mb-[8rem] flex flex-col items-center gap-[0.6rem]">
                <KioskButton tone="secondary" onClick={onDone}>Done</KioskButton>
                <span className="text-[0.7rem] text-faint">Resetting in {left}s</span>
            </div>
        </div>
    );
}

export function StillThere({ secondsLeft, onStay }: { secondsLeft: number; onStay: () => void }) {
    return (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center px-[3rem] text-center backdrop-blur-[0.4rem]"
            style={{ background: 'color-mix(in srgb, var(--bg) 92%, transparent)' }}>
            <Title>Still there?</Title>
            <p className="mt-[1.2rem] max-w-[26rem] text-[1rem] text-muted">
                We&apos;ll end this visit and delete your photo in {secondsLeft} seconds.
            </p>
            <KioskButton className="mt-[3rem]" onClick={onStay}>I&apos;m still here</KioskButton>
        </div>
    );
}
