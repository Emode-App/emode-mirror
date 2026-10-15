'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { mirrorCall, MirrorError, type StoreDashboard } from '@/lib/api';
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
                                        No rack yet. List your pieces in your Emode Business shop and they appear on your mirrors for shoppers to try on.
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
                                                    {p.price != null && <p className="text-xs text-muted">${Number(p.price).toFixed(2)}</p>}
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

function Stat({ label, value, hint, small = false }: { label: string; value: number | string; hint?: string; small?: boolean }) {
    return (
        <div className="rounded-3xl bg-surface p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.15em] text-muted">{label}</p>
            <p className={`mt-2 font-display font-semibold tracking-tight ${small ? 'text-2xl' : 'text-4xl'}`}>{value}</p>
            {hint && <p className="mt-1 text-xs text-faint">{hint}</p>}
        </div>
    );
}
