'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { mirrorCall, MirrorError, type Garment, type Look, type PhoneState } from '@/lib/api';
import { prepareUpload } from '@/lib/image';
import { EMODE_APP_URL, openInAppUrl } from '@/lib/links';
import { Wordmark } from '@/components/Wordmark';

/**
 * The phone half of a visit, opened from the QR code on the mirror.
 *
 * The token that proves this phone scanned that mirror rides in the URL
 * fragment, which browsers never send to a server or put in a Referer -- so it
 * stays between the QR code and this page.
 */
export default function PhoneCompanion() {
    const { sessionId } = useParams<{ sessionId: string }>();
    const [token, setToken] = useState<string | null>(null);
    const [state, setState] = useState<PhoneState | null>(null);
    const [fatal, setFatal] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [progress, setProgress] = useState<string | null>(null);
    const [link, setLink] = useState('');
    const [linkBusy, setLinkBusy] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const t = window.location.hash.replace(/^#/, '');
        if (t.length < 20) setFatal('This link is incomplete. Scan the code on the mirror again.');
        else setToken(t);
    }, []);

    const call = useCallback(<T,>(body: Record<string, unknown>) =>
        mirrorCall<T>({ ...body, sessionId, token }), [sessionId, token]);

    // Counted for the funnel. Fire-and-forget: a lost count never blocks a tap.
    const track = useCallback((type: 'app_cta_tapped' | 'product_link_opened', extra: Record<string, unknown>) => {
        if (token) call({ action: 'event.track', type, ...extra }).catch(() => {});
    }, [call, token]);

    const refresh = useCallback(async () => {
        if (!token) return;
        try {
            setState(await call<PhoneState>({ action: 'phone.state' }));
        } catch (e) {
            const err = e as MirrorError;
            if (err.code === 'session_gone' || err.code === 'bad_token') setFatal(err.message);
        }
    }, [call, token]);

    useEffect(() => {
        if (!token) return;
        refresh();
        const id = setInterval(() => {
            if (document.visibilityState === 'visible') refresh();
        }, 2500);
        return () => clearInterval(id);
    }, [token, refresh]);

    useEffect(() => {
        if (!error) return;
        const t = setTimeout(() => setError(null), 6000);
        return () => clearTimeout(t);
    }, [error]);

    const active = state?.status === 'active';
    const limit = state?.limits.garmentsPerSession ?? 12;
    const garments = state?.garments ?? [];
    const looks = (state?.looks ?? []).filter((l) => l.status === 'succeeded' && l.imageUrl).reverse();
    const styling = (state?.looks ?? []).some((l) => l.status === 'pending');

    const onFiles = async (files: FileList | null) => {
        if (!files?.length) return;
        const list = Array.from(files).slice(0, Math.max(0, limit - garments.length));
        if (!list.length) {
            setError(`That's ${limit} pieces — remove one to add another.`);
            return;
        }
        for (let i = 0; i < list.length; i++) {
            setProgress(list.length > 1 ? `Adding ${i + 1} of ${list.length}…` : 'Adding…');
            try {
                const image = await prepareUpload(list[i]);
                await call({ action: 'garment.upload', image });
            } catch (e) {
                setError((e as Error).message);
            }
        }
        setProgress(null);
        if (fileRef.current) fileRef.current.value = '';
        refresh();
    };

    const addLink = async () => {
        const url = link.trim();
        if (!url) return;
        setLinkBusy(true);
        setError(null);
        try {
            await call({ action: 'garment.link', url: /^https?:\/\//i.test(url) ? url : `https://${url}` });
            setLink('');
            refresh();
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setLinkBusy(false);
        }
    };

    const remove = async (id: string) => {
        setState((s) => (s ? { ...s, garments: s.garments.filter((g) => g.id !== id) } : s));
        try {
            await call({ action: 'garment.remove', garmentId: id });
        } catch (e) {
            setError((e as Error).message);
        }
        refresh();
    };

    if (fatal) {
        return (
            <Shell>
                <div className="mt-16 text-center">
                    <p className="font-display text-2xl font-semibold">{fatal}</p>
                    <p className="mt-3 text-sm text-muted">Everything from a visit is deleted once it ends.</p>
                </div>
            </Shell>
        );
    }

    if (!state) {
        return (
            <Shell>
                <p className="mt-16 text-center text-sm text-muted animate-soft-pulse">Connecting to the mirror…</p>
            </Shell>
        );
    }

    return (
        <Shell>
            <div className="mt-6 text-center">
                {active ? (
                    <>
                        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-gold">Connected</p>
                        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight">Send clothes to the mirror.</h1>
                        <p className="mt-2 text-sm text-muted">
                            Screenshots work from any store. They show up on {state.device.name ? `the ${state.device.name.split('—')[0].trim()}` : 'the mirror'} right away.
                        </p>
                    </>
                ) : (
                    <>
                        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-gold">Visit ended</p>
                        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight">Save your looks.</h1>
                        <p className="mt-2 text-sm text-muted">
                            Your photo has been deleted.{state.retainUntil && ` These looks are deleted at ${new Date(state.retainUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`}
                        </p>
                    </>
                )}
            </div>

            {error && <p className="mt-5 rounded-xl bg-obsidian px-4 py-3 text-center text-sm text-cream">{error}</p>}

            {active && (
                <section className="mt-6 flex flex-col gap-3">
                    <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => onFiles(e.target.files)} />
                    <button type="button" disabled={!!progress || garments.length >= limit} onClick={() => fileRef.current?.click()}
                        className="h-14 rounded-full bg-obsidian font-display text-base font-semibold text-cream transition active:scale-[0.98] disabled:opacity-50">
                        {progress || 'Add screenshots'}
                    </button>
                    <div className="flex gap-2">
                        <input value={link} onChange={(e) => setLink(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addLink()}
                            inputMode="url" autoCapitalize="none" autoCorrect="off" placeholder="…or paste a product link"
                            className="h-12 min-w-0 flex-1 rounded-full border border-line bg-surface px-4 text-sm outline-none focus:border-obsidian" />
                        <button type="button" disabled={linkBusy || !link.trim()} onClick={addLink}
                            className="h-12 shrink-0 rounded-full border border-obsidian px-5 text-sm font-semibold disabled:opacity-40">
                            {linkBusy ? '…' : 'Add'}
                        </button>
                    </div>
                    <p className="text-center text-xs text-faint">
                        Links work for many stores. If one won&apos;t load, screenshot the product instead.
                    </p>
                </section>
            )}

            {active && token && (
                state.linked ? (
                    <section className="mt-6 rounded-2xl bg-obsidian p-5 text-cream">
                        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-gold">Emode account connected</p>
                        <p className="mt-2 text-sm text-cream/80">Send pieces from your wardrobe and save your looks in the Emode app.</p>
                        <a href={openInAppUrl(sessionId, token)} className="mt-4 inline-block rounded-full bg-cream px-5 py-2.5 text-sm font-semibold text-obsidian">
                            Open Emode
                        </a>
                    </section>
                ) : (
                    <a href={openInAppUrl(sessionId, token)}
                        className="mt-4 flex items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-4 py-3.5">
                        <span className="text-sm">
                            <span className="font-semibold">Already on Emode?</span>{' '}
                            <span className="text-muted">Send pieces from your wardrobe.</span>
                        </span>
                        <span className="shrink-0 text-sm font-semibold underline underline-offset-4">Open app</span>
                    </a>
                )
            )}

            {looks.length > 0 && !state.linked && (
                <AppCard where={active ? 'phone_look' : 'phone_ended'} onTap={(where) => track('app_cta_tapped', { where })} />
            )}

            {styling && (
                <p className="mt-6 rounded-xl bg-surface-strong px-4 py-3 text-center text-sm animate-soft-pulse">The mirror is styling a look…</p>
            )}

            {looks.length > 0 && (
                <section className="mt-8">
                    <h2 className="font-display text-xl font-semibold">Your looks</h2>
                    <div className="mt-3 flex flex-col gap-5">
                        {looks.map((look, i) => (
                            <LookCard key={look.id} look={look} number={looks.length - i} garments={garments}
                                onShop={(url) => track('product_link_opened', { url })} />
                        ))}
                    </div>
                </section>
            )}

            {garments.length > 0 && (
                <section className="mt-8">
                    <div className="flex items-baseline justify-between">
                        <h2 className="font-display text-xl font-semibold">Your pieces</h2>
                        <span className="text-xs text-faint">{garments.length} of {limit}</span>
                    </div>
                    <div className="mt-3 grid grid-cols-3 gap-3">
                        {garments.map((g) => (
                            <div key={g.id} className="relative overflow-hidden rounded-xl bg-surface ring-1 ring-line">
                                <div className="aspect-[3/4] bg-white">
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    {g.imageUrl && <img src={g.imageUrl} alt={g.title || 'Clothing'} className="h-full w-full object-contain p-1" />}
                                </div>
                                <p className="truncate px-2 py-1.5 text-[11px] text-muted">{g.title || (g.source === 'link' ? 'From a link' : 'Screenshot')}</p>
                                {active && (
                                    <button type="button" aria-label="Remove" onClick={() => remove(g.id)}
                                        className="absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-full bg-obsidian/80 text-sm text-cream">
                                        ×
                                    </button>
                                )}
                            </div>
                        ))}
                    </div>
                </section>
            )}

            <footer className="mt-12 border-t border-line pt-6 text-center text-xs leading-relaxed text-faint">
                <p>Your photo is deleted when the visit ends. Looks are kept for an hour so you can save them, then deleted.</p>
                <a href={EMODE_APP_URL} target="_blank" rel="noopener noreferrer" onClick={() => track('app_cta_tapped', { where: 'phone_footer' })}
                    className="mt-4 inline-block font-semibold text-obsidian underline underline-offset-4">
                    Try on clothes anywhere with Emode →
                </a>
            </footer>
        </Shell>
    );
}

function Shell({ children }: { children: React.ReactNode }) {
    return (
        <main data-theme="phone" className="min-h-dvh bg-bg px-5 pb-10 pt-6 text-fg">
            <div className="mx-auto max-w-md">
                <Wordmark className="text-[2rem]" />
                {children}
            </div>
        </main>
    );
}

/**
 * The moment the mirror has earned the most goodwill -- they just saw themselves
 * in something new -- is the moment to say this works from their couch too.
 */
function AppCard({ where, onTap }: { where: 'phone_look' | 'phone_ended'; onTap: (where: string) => void }) {
    return (
        <section className="mt-6 overflow-hidden rounded-2xl bg-obsidian text-cream">
            <div className="p-5">
                <p className="text-xs font-semibold uppercase tracking-[0.25em] text-gold">Keep every look</p>
                <h2 className="mt-2 font-display text-2xl font-semibold leading-tight tracking-tight">Try on anything, anytime — from your phone.</h2>
                <p className="mt-2 text-sm text-cream/75">
                    Emode keeps your wardrobe, your looks and the people whose style you love, all in one place.
                </p>
                <a href={EMODE_APP_URL} target="_blank" rel="noopener noreferrer" onClick={() => onTap(where)}
                    className="mt-4 inline-flex h-11 items-center rounded-full bg-cream px-5 text-sm font-semibold text-obsidian">
                    Get Emode — it’s free
                </a>
            </div>
        </section>
    );
}

function LookCard({ look, number, garments, onShop }: { look: Look; number: number; garments: Garment[]; onShop: (url: string) => void }) {
    const [saving, setSaving] = useState(false);
    const pieces = look.garmentIds.map((id) => garments.find((g) => g.id === id)).filter(Boolean) as Garment[];
    const shoppable = pieces.filter((g) => g.productUrl);

    const save = async () => {
        if (!look.imageUrl) return;
        setSaving(true);
        try {
            const blob = await (await fetch(look.imageUrl)).blob();
            const file = new File([blob], `emode-look-${number}.${blob.type.includes('png') ? 'png' : 'jpg'}`, { type: blob.type });
            // The share sheet is how a phone saves a photo to its camera roll;
            // a download link only lands it in Files.
            if (navigator.canShare?.({ files: [file] })) {
                await navigator.share({ files: [file], title: 'My Emode look' });
            } else {
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = file.name;
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
            }
        } catch (e) {
            if ((e as Error).name !== 'AbortError') window.open(look.imageUrl, '_blank');
        } finally {
            setSaving(false);
        }
    };

    return (
        <article className="overflow-hidden rounded-2xl bg-surface ring-1 ring-line">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={look.imageUrl!} alt={`Look ${number}`} className="w-full bg-white" />
            <div className="flex flex-col gap-3 p-4">
                <div className="flex items-center justify-between">
                    <span className="font-display font-semibold">Look {number}</span>
                    <button type="button" onClick={save} disabled={saving}
                        className="rounded-full bg-obsidian px-4 py-2 text-sm font-semibold text-cream disabled:opacity-50">
                        {saving ? 'Saving…' : 'Save photo'}
                    </button>
                </div>
                {shoppable.length > 0 && (
                    <div className="flex flex-col gap-1.5">
                        <span className="text-xs uppercase tracking-[0.2em] text-faint">Shop this look</span>
                        {shoppable.map((g) => (
                            <a key={g.id} href={g.productUrl!} target="_blank" rel="noopener noreferrer" onClick={() => onShop(g.productUrl!)}
                                className="truncate text-sm font-medium underline underline-offset-4">
                                {g.title || new URL(g.productUrl!).hostname}
                            </a>
                        ))}
                    </div>
                )}
            </div>
        </article>
    );
}
