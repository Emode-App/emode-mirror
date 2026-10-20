'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { formatPrice, mirrorCall, MirrorError, type Category, type RackStatus, type StoreDashboard } from '@/lib/api';
import { Wordmark } from '@/components/Wordmark';

/**
 * A store's view of its Emode Mirrors.
 *
 * Reached by a private link (scripts/create-store.mjs) rather than a login: a
 * store's marketing lead should not need an Emode account to see how their
 * mirrors are doing. The token rides in the URL fragment, so it never reaches
 * a server log or a Referer.
 *
 * Everything here is a count. The events behind it hold no photos and no
 * shoppers -- which pieces were tried, not by whom.
 */
const RANGES = [7, 30, 90] as const;

export default function StoreDashboardPage() {
    const { storeId } = useParams<{ storeId: string }>();
    const [token, setToken] = useState<string | null>(null);
    const [days, setDays] = useState<(typeof RANGES)[number]>(30);
    const [data, setData] = useState<StoreDashboard | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const t = window.location.hash.replace(/^#/, '');
        if (t.length < 20) {
            setError('This dashboard link is incomplete. Use the full link Emode sent you.');
            setLoading(false);
        } else {
            setToken(t);
        }
    }, []);

    const load = useCallback(async () => {
        if (!token) return;
        setLoading(true);
        try {
            setData(await mirrorCall<StoreDashboard>({ action: 'store.dashboard', storeId, token, days }));
            setError(null);
        } catch (e) {
            setError((e as MirrorError).message);
        } finally {
            setLoading(false);
        }
    }, [storeId, token, days]);

    useEffect(() => {
        load();
        const id = setInterval(load, 60_000);
        return () => clearInterval(id);
    }, [load]);

    const t = data?.totals;
    const maxDaily = Math.max(1, ...(data?.daily ?? []).map((d) => Math.max(d.visits, d.looks)));
    const pct = (n: number) => `${Math.round(n * 100)}%`;

    return (
        <main data-theme="phone" className="min-h-dvh bg-bg text-fg">
            <div className="mx-auto max-w-5xl px-5 pb-16 pt-8 md:px-8">
                <header className="flex flex-wrap items-end justify-between gap-6">
                    <div>
                        <Wordmark className="items-start text-[2rem]" />
                        <h1 className="mt-6 font-display text-3xl font-semibold tracking-tight md:text-4xl">
                            {data?.store.name ?? 'Store dashboard'}
                        </h1>
                        <p className="mt-1 text-sm text-muted">Your Emode Mirrors, last {days} days.</p>
                    </div>
                    <div className="flex items-center gap-4">
                        {data?.store.logoUrl && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={data.store.logoUrl} alt="" className="h-10 w-auto max-w-[140px] object-contain" />
                        )}
                        <div className="flex rounded-full border border-line bg-surface p-1">
                            {RANGES.map((r) => (
                                <button key={r} type="button" onClick={() => setDays(r)}
                                    className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${days === r ? 'bg-obsidian text-cream' : 'text-muted'}`}>
                                    {r}d
                                </button>
                            ))}
                        </div>
                    </div>
                </header>

                {error && <p className="mt-10 rounded-2xl bg-surface p-6 text-center">{error}</p>}
                {!data && !error && <p className="mt-10 text-center text-sm text-muted animate-soft-pulse">Loading…</p>}

                {data && t && (
                    <div className={`transition-opacity ${loading ? 'opacity-60' : ''}`}>
                        <section className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-4">
                            <Stat label="Visits" value={t.visits} hint="Shoppers who started the mirror" />
                            <Stat label="Looks made" value={t.looks} hint={`${t.looksPerVisit.toFixed(1)} per visit`} />
                            <Stat label="Used their phone" value={pct(t.pairedRate)} hint="Scanned the code to send clothes" />
                            <Stat label="Product links opened" value={t.linkOpens} hint="From looks saved on phones" />
                        </section>
                        <section className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
                            <Stat label="Avg. time per look" value={t.avgLookSeconds ? `${t.avgLookSeconds}s` : '—'} small />
                            <Stat label="Emode members" value={t.members} small hint="Brought their own wardrobe" />
                            <Stat label="App interest" value={t.appTaps} small hint="Tapped to get Emode" />
                            <Stat label="Mirrors online" value={`${data.mirrors.filter((m) => m.online).length} / ${data.mirrors.length}`} small />
                        </section>

                        <RackPanel
                            rack={data.rack}
                            storeId={storeId}
                            token={token!}
                            onChange={(rack) => setData((d) => (d ? { ...d, rack, store: { ...d.store, hasRack: rack.count > 0 } } : d))}
                        />

                        <section className="mt-8 rounded-3xl bg-surface p-6">
                            <div className="flex items-baseline justify-between">
                                <h2 className="font-display text-lg font-semibold">Day by day</h2>
                                <div className="flex gap-4 text-xs text-muted">
                                    <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-obsidian" />Visits</span>
                                    <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-gold" />Looks</span>
                                </div>
                            </div>
                            <div className="mt-6 flex h-40 items-end gap-[3px]">
                                {data.daily.map((d) => (
                                    <div key={d.date} className="group relative flex h-full flex-1 items-end gap-[1px]" title={`${d.date}: ${d.visits} visits, ${d.looks} looks`}>
                                        <div className="flex-1 rounded-t-sm bg-obsidian" style={{ height: `${(d.visits / maxDaily) * 100}%`, minHeight: d.visits ? 2 : 0 }} />
                                        <div className="flex-1 rounded-t-sm bg-gold" style={{ height: `${(d.looks / maxDaily) * 100}%`, minHeight: d.looks ? 2 : 0 }} />
                                    </div>
                                ))}
                            </div>
                            <div className="mt-2 flex justify-between text-[11px] text-faint">
                                <span>{data.daily[0]?.date}</span>
                                <span>{data.daily[data.daily.length - 1]?.date}</span>
                            </div>
                        </section>

                        <div className="mt-8 grid gap-8 md:grid-cols-2">
                            <section>
                                <h2 className="font-display text-lg font-semibold">Your mirrors</h2>
                                <ul className="mt-3 divide-y divide-line overflow-hidden rounded-3xl bg-surface">
                                    {data.mirrors.map((m) => (
                                        <li key={m.name} className="flex items-center justify-between gap-4 p-4">
                                            <div className="min-w-0">
                                                <p className="flex items-center gap-2 font-semibold">
                                                    <span className={`h-2 w-2 shrink-0 rounded-full ${m.online ? 'bg-emerald-500' : 'bg-neutral-300'}`} />
                                                    <span className="truncate">{m.name}</span>
                                                </p>
                                                <p className="mt-0.5 truncate text-xs text-muted">
                                                    {m.location || '—'} · {m.online ? 'Online' : m.lastSeenAt ? `Last seen ${new Date(m.lastSeenAt).toLocaleString()}` : 'Not set up yet'}
                                                </p>
                                            </div>
                                            <p className="shrink-0 text-right text-sm">
                                                <span className="font-semibold">{m.visits}</span> <span className="text-muted">{m.visits === 1 ? 'visit' : 'visits'}</span><br />
                                                <span className="font-semibold">{m.looks}</span> <span className="text-muted">{m.looks === 1 ? 'look' : 'looks'}</span>
                                            </p>
                                        </li>
                                    ))}
                                </ul>
                            </section>

                            <section>
                                <h2 className="font-display text-lg font-semibold">Most tried from your rack</h2>
                                {!data.store.hasRack ? (
                                    <p className="mt-3 rounded-3xl bg-surface p-5 text-sm text-muted">
                                        No rack yet. Add your product feed above and your pieces appear on your mirrors for shoppers to try on.
                                    </p>
                                ) : data.topRack.length === 0 ? (
                                    <p className="mt-3 rounded-3xl bg-surface p-5 text-sm text-muted">Nothing from your rack has been tried in this period.</p>
                                ) : (
                                    <ol className="mt-3 divide-y divide-line overflow-hidden rounded-3xl bg-surface">
                                        {data.topRack.map((p, i) => (
                                            <li key={p.id} className="flex items-center gap-4 p-3">
                                                <span className="w-5 text-center text-sm text-faint">{i + 1}</span>
                                                <div className="h-14 w-11 shrink-0 overflow-hidden rounded-lg bg-white">
                                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                                    {p.imageUrl && <img src={p.imageUrl} alt="" className="h-full w-full object-contain" />}
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                    <p className="truncate font-semibold">{p.name}</p>
                                                    {p.price != null && <p className="text-xs text-muted">{formatPrice(p.price, p.currency)}</p>}
                                                </div>
                                                <p className="text-sm"><span className="font-semibold">{p.tries}</span> <span className="text-muted">{p.tries === 1 ? 'try' : 'tries'}</span></p>
                                            </li>
                                        ))}
                                    </ol>
                                )}

                                {data.topLinks.length > 0 && (
                                    <>
                                        <h2 className="mt-8 font-display text-lg font-semibold">What shoppers brought with them</h2>
                                        <p className="mt-1 text-xs text-muted">Products from other stores tried on your mirrors, by link.</p>
                                        <ul className="mt-3 divide-y divide-line overflow-hidden rounded-3xl bg-surface">
                                            {data.topLinks.map((l) => (
                                                <li key={`${l.host}|${l.title}`} className="flex items-center justify-between gap-4 p-3 text-sm">
                                                    <span className="min-w-0 truncate"><span className="font-semibold">{l.host}</span>{l.title ? <span className="text-muted"> · {l.title}</span> : null}</span>
                                                    <span className="shrink-0 font-semibold">{l.count}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    </>
                                )}
                            </section>
                        </div>

                        <p className="mt-12 text-center text-xs text-faint">
                            Counts only. Emode Mirror keeps no photos of your shoppers — each photo is deleted when their visit ends.
                        </p>
                    </div>
                )}
            </div>
        </main>
    );
}

const CATEGORY_NAMES: Record<Category, string> = {
    suits: 'suits', tops: 'tops', outerwear: 'outerwear', bottoms: 'bottoms', dresses: 'dresses',
    shoes: 'shoes', accessories: 'accessories', other: 'other',
};

function ago(iso: string) {
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    return new Date(iso).toLocaleDateString();
}

function hostOf(url: string) {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return url;
    }
}

/**
 * Where the rack comes from, and what is on it.
 *
 * A retailer's products already live in its own platform, so the rack is a
 * copy of what it publishes: the Google Shopping feed it keeps for Google, or
 * its Shopify store. Pasting the link here is the whole integration; the
 * mirror re-reads it every couple of hours on its own.
 */
function RackPanel({ rack, storeId, token, onChange }: {
    rack: RackStatus;
    storeId: string;
    token: string;
    onChange: (rack: RackStatus) => void;
}) {
    const [editing, setEditing] = useState(!rack.feedUrl && !rack.emodeShop);
    const [url, setUrl] = useState(rack.feedUrl ?? '');
    const [working, setWorking] = useState<null | 'save' | 'sync'>(null);
    const [problem, setProblem] = useState<string | null>(null);

    const run = async (kind: 'save' | 'sync') => {
        setWorking(kind);
        setProblem(null);
        try {
            const r = await mirrorCall<{ rack: RackStatus }>(kind === 'save'
                ? { action: 'store.catalog.set', storeId, token, feedUrl: url }
                : { action: 'store.catalog.sync', storeId, token });
            onChange(r.rack);
            if (kind === 'save') setEditing(false);
        } catch (e) {
            setProblem((e as MirrorError).message);
        } finally {
            setWorking(null);
        }
    };

    const categories = (Object.entries(rack.byCategory) as [Category, number][])
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1]);
    const source = [rack.feedUrl ? hostOf(rack.feedUrl) : null, rack.emodeShop ? 'your Emode shop' : null].filter(Boolean).join(' and ');

    return (
        <section className="mt-8 rounded-3xl bg-surface p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                    <h2 className="font-display text-lg font-semibold">Your rack</h2>
                    <p className="mt-1 text-sm text-muted">
                        {rack.count > 0
                            ? <>{rack.count} {rack.count === 1 ? 'piece' : 'pieces'} shoppers can try on without a phone{source ? <>, from {source}</> : null}.</>
                            : 'The pieces shoppers can try on right at the mirror, straight from your catalog.'}
                        {rack.syncedAt && <> Updated {ago(rack.syncedAt)}.</>}
                    </p>
                    {categories.length > 0 && (
                        <p className="mt-1 text-xs text-faint">
                            {categories.map(([c, n]) => `${n} ${CATEGORY_NAMES[c]}`).join(' · ')}
                        </p>
                    )}
                </div>
                {(rack.feedUrl || rack.emodeShop) && !editing && (
                    <div className="flex shrink-0 gap-2">
                        <button type="button" onClick={() => run('sync')} disabled={!!working || rack.syncing}
                            className="rounded-full bg-obsidian px-4 py-2 text-sm font-semibold text-cream disabled:opacity-50">
                            {working === 'sync' || rack.syncing ? 'Updating…' : 'Update now'}
                        </button>
                        <button type="button" onClick={() => setEditing(true)}
                            className="rounded-full border border-line px-4 py-2 text-sm font-semibold">
                            {rack.feedUrl ? 'Change feed' : 'Add a feed'}
                        </button>
                    </div>
                )}
            </div>

            {rack.message && !problem && (
                <p className="mt-4 rounded-2xl bg-amber-100 px-4 py-3 text-sm text-amber-900">{rack.message}</p>
            )}
            {problem && <p className="mt-4 rounded-2xl bg-red-100 px-4 py-3 text-sm text-red-900">{problem}</p>}

            {editing && (
                <form className="mt-5" onSubmit={(e) => { e.preventDefault(); run('save'); }}>
                    <label htmlFor="feed" className="text-sm font-semibold">Your product feed or Shopify link</label>
                    <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                        <input id="feed" type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)}
                            placeholder="https://yourstore.com/collections/in-store"
                            className="min-w-0 flex-1 rounded-full border border-line bg-bg px-4 py-2.5 text-sm outline-none focus:border-fg" />
                        <div className="flex gap-2">
                            <button type="submit" disabled={!!working || (!url.trim() && !rack.feedUrl)}
                                className="rounded-full bg-obsidian px-5 py-2.5 text-sm font-semibold text-cream disabled:opacity-50">
                                {working === 'save' ? 'Reading your catalog…' : url.trim() ? 'Use this' : 'Remove feed'}
                            </button>
                            {(rack.feedUrl || rack.emodeShop) && (
                                <button type="button" onClick={() => { setEditing(false); setUrl(rack.feedUrl ?? ''); setProblem(null); }}
                                    className="rounded-full px-4 py-2.5 text-sm text-muted">Cancel</button>
                            )}
                        </div>
                    </div>
                    <p className="mt-3 text-xs leading-relaxed text-muted">
                        Paste the Google Shopping feed you already keep in Merchant Center (XML, TSV or CSV), or a link to your
                        Shopify store. A Shopify collection link shows just that collection, which is the easy way to put only
                        what&apos;s on this floor on the mirror. In-stock pieces with photos are used; the mirror re-reads it every
                        couple of hours.
                    </p>
                </form>
            )}

            {rack.preview.length > 0 && (
                <div className="mt-5 flex gap-3 overflow-x-auto pb-1">
                    {rack.preview.map((p) => (
                        <div key={p.id} className="w-24 shrink-0">
                            <div className="h-32 w-24 overflow-hidden rounded-xl bg-white">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={p.imageUrl} alt="" loading="lazy" className="h-full w-full object-contain" />
                            </div>
                            <p className="mt-1.5 truncate text-xs">{p.name}</p>
                            {p.price != null && <p className="text-[11px] text-muted">{formatPrice(p.price, p.currency)}</p>}
                        </div>
                    ))}
                </div>
            )}
        </section>
    );
}

function Stat({ label, value, hint, small = false }: { label: string; value: number | string; hint?: string; small?: boolean }) {
    return (
        <div className="rounded-3xl bg-surface p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.15em] text-muted">{label}</p>
            <p className={`mt-2 font-display font-semibold tracking-tight ${small ? 'text-2xl' : 'text-4xl'}`}>{value}</p>
            {hint && <p className="mt-1 text-xs text-faint">{hint}</p>}
        </div>
    );
}
