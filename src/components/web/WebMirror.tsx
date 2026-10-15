'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mirrorCall, MirrorError, type Category, type Garment, type SessionState } from '@/lib/api';
import { prepareUpload } from '@/lib/image';
import { saveImage } from '@/lib/save';
import { EMODE_APP_URL } from '@/lib/links';
import { Wordmark } from '@/components/Wordmark';
import { WebCamera } from './WebCamera';

/**
 * Emode Mirror on the visitor's own phone or laptop, reached from emode.style.
 *
 * The same visit, rules and try-on as the Luma, without the pairing: on a
 * kiosk the phone is how clothes get in, but here the device in hand is both
 * the mirror and the source, so pieces are added right on this screen.
 *
 * The key below is public by design -- every browser that opens this page
 * reads it. It identifies "the website" as a device; the server rations it per
 * visitor and per day, so it is not a credential worth stealing.
 */
const WEB_KEY = process.env.NEXT_PUBLIC_WEB_MIRROR_KEY ?? 'web_Nbj2aJHWX7Ec5oVynGSoa5zC';
const API_URL = process.env.NEXT_PUBLIC_MIRROR_API_URL ?? 'https://scvvbjheyfnxlsiiozta.supabase.co/functions/v1/mirror';
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? 'sb_publishable_xBWtFjEoKrG4wCSzGVkigw_A-i0UfJi';
const MAX_PIECES = 6;

type Stage = 'start' | 'pieces' | 'photo' | 'camera' | 'generating' | 'result' | 'done';

const CATEGORY_LABELS: Record<Category, string> = {
    tops: 'Tops', outerwear: 'Outerwear', bottoms: 'Bottoms', shoes: 'Shoes', accessories: 'Accessories', other: 'Other',
};
const CATEGORY_ORDER: Category[] = ['tops', 'outerwear', 'bottoms', 'shoes', 'accessories', 'other'];
const STYLING = ['Reading the fabric…', 'Matching your fit…', 'Getting the drape right…', 'Lighting the look…', 'Almost there…'];

export function WebMirror() {
    const [stage, setStage] = useState<Stage>('start');
    const [session, setSession] = useState<{ id: string; token: string } | null>(null);
    const [visit, setVisit] = useState<SessionState | null>(null);
    const [selected, setSelected] = useState<string[]>([]);
    const [photo, setPhoto] = useState<string | null>(null);
    const [lookId, setLookId] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [link, setLink] = useState('');
    const [tab, setTab] = useState<Category | 'all'>('all');
    const [line, setLine] = useState(0);
    const piecesInput = useRef<HTMLInputElement>(null);
    const photoInput = useRef<HTMLInputElement>(null);
    const seen = useRef<Set<string>>(new Set());

    const kiosk = useCallback(<T,>(body: Record<string, unknown>) => mirrorCall<T>(body, WEB_KEY), []);
    const asPhone = useCallback(<T,>(body: Record<string, unknown>) =>
        mirrorCall<T>({ ...body, sessionId: session?.id, token: session?.token }), [session]);

    useEffect(() => {
        if (!error) return;
        const t = setTimeout(() => setError(null), 7000);
        return () => clearTimeout(t);
    }, [error]);

    // ── visit state ───────────────────────────────────────────────────────
    const refresh = useCallback(async () => {
        if (!session) return;
        try {
            setVisit(await kiosk<SessionState>({ action: 'session.state', sessionId: session.id }));
        } catch (e) {
            if ((e as MirrorError).code === 'session_gone') {
                setSession(null);
                setStage('start');
                setError('That visit timed out. Start again whenever you like.');
            }
        }
    }, [session, kiosk]);

    useEffect(() => {
        if (!session || !['pieces', 'photo', 'generating', 'result'].includes(stage)) return;
        refresh();
        const id = setInterval(refresh, stage === 'generating' ? 1500 : 2500);
        return () => clearInterval(id);
    }, [session, stage, refresh]);

    // New pieces arrive selected, up to the limit -- someone who adds a jacket
    // and jeans wants to see the jacket and jeans.
    useEffect(() => {
        if (!visit) return;
        const fresh = visit.garments.filter((g) => !seen.current.has(g.id)).map((g) => g.id);
        fresh.forEach((id) => seen.current.add(id));
        const ids = new Set(visit.garments.map((g) => g.id));
        setSelected((sel) => {
            const kept = sel.filter((id) => ids.has(id));
            return [...kept, ...fresh].slice(0, MAX_PIECES);
        });
    }, [visit]);

    const look = visit?.looks.find((l) => l.id === lookId) ?? null;
    useEffect(() => {
        if (stage === 'generating' && look?.status === 'succeeded' && look.imageUrl) setStage('result');
    }, [stage, look]);

    useEffect(() => {
        if (stage !== 'generating') return;
        setLine(0);
        const t = setInterval(() => setLine((n) => Math.min(n + 1, STYLING.length - 1)), 5000);
        return () => clearInterval(t);
    }, [stage]);

    // Leaving the page ends the visit, which deletes the photo then and there
    // rather than waiting for the server's idle sweep.
    useEffect(() => {
        if (!session) return;
        const end = () => {
            fetch(API_URL, {
                method: 'POST',
                keepalive: true,
                headers: { 'content-type': 'application/json', apikey: ANON_KEY, authorization: `Bearer ${ANON_KEY}`, 'x-mirror-device-key': WEB_KEY },
                body: JSON.stringify({ action: 'session.end', sessionId: session.id, reason: 'cancel' }),
            }).catch(() => {});
        };
        window.addEventListener('pagehide', end);
        return () => window.removeEventListener('pagehide', end);
    }, [session]);

    // ── actions ───────────────────────────────────────────────────────────
    const start = async () => {
        setBusy(true);
        setError(null);
        try {
            const r = await kiosk<{ sessionId: string; token: string }>({ action: 'session.start', consent: true, adult: true });
            seen.current = new Set();
            setSession({ id: r.sessionId, token: r.token });
            setVisit(null);
            setSelected([]);
            setPhoto(null);
            setStage('pieces');
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(false);
        }
    };

    const addFiles = async (files: FileList | null) => {
        if (!files?.length || !session) return;
        const room = 12 - (visit?.garments.length ?? 0);
        const list = Array.from(files).slice(0, Math.max(0, room));
        if (!list.length) return setError('That’s 12 pieces — remove one to add another.');
        for (let i = 0; i < list.length; i++) {
            setProgress(list.length > 1 ? `Adding ${i + 1} of ${list.length}…` : 'Adding…');
            try {
                await asPhone({ action: 'garment.upload', image: await prepareUpload(list[i]) });
            } catch (e) {
                setError((e as Error).message);
            }
        }
        setProgress(null);
        if (piecesInput.current) piecesInput.current.value = '';
        refresh();
    };

    const addLink = async () => {
        const url = link.trim();
        if (!url) return;
        setProgress('Fetching the product…');
        try {
            await asPhone({ action: 'garment.link', url: /^https?:\/\//i.test(url) ? url : `https://${url}` });
            setLink('');
            refresh();
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setProgress(null);
        }
    };

    const remove = async (id: string) => {
        setVisit((v) => (v ? { ...v, garments: v.garments.filter((g) => g.id !== id) } : v));
        try {
            await asPhone({ action: 'garment.remove', garmentId: id });
        } catch { /* the next refresh tells the truth */ }
        refresh();
    };

    const toggle = (id: string) => setSelected((sel) => {
        if (sel.includes(id)) return sel.filter((x) => x !== id);
        if (sel.length >= MAX_PIECES) {
            setError(`Up to ${MAX_PIECES} pieces at once — tap one to take it off.`);
            return sel;
        }
        return [...sel, id];
    });

    const generate = async () => {
        if (!session || !selected.length) return;
        setError(null);
        try {
            const r = await kiosk<{ lookId: string }>({ action: 'look.generate', sessionId: session.id, garmentIds: selected });
            setLookId(r.lookId);
            setStage('generating');
        } catch (e) {
            const err = e as MirrorError;
            if (err.code === 'no_photo') return setStage('photo');
            setError(err.message);
            setStage('pieces');
        }
    };

    const submitPhoto = async (dataUrl: string) => {
        if (!session) return;
        setBusy(true);
        try {
            await kiosk({ action: 'session.capture', sessionId: session.id, image: dataUrl });
            setPhoto(dataUrl);
            setVisit((v) => (v ? { ...v, hasPhoto: true } : v));
            await generate();
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(false);
        }
    };

    const uploadPhoto = async (files: FileList | null) => {
        const file = files?.[0];
        if (!file) return;
        try {
            await submitPhoto(await prepareUpload(file, 1920));
        } catch (e) {
            setError((e as Error).message);
        }
        if (photoInput.current) photoInput.current.value = '';
    };

    const finish = async () => {
        if (session) {
            try {
                await kiosk({ action: 'session.end', sessionId: session.id, reason: 'finish' });
            } catch { /* swept regardless */ }
        }
        setPhoto(null);
        setStage('done');
    };

    const restart = () => {
        setSession(null);
        setVisit(null);
        setLookId(null);
        setStage('start');
    };

    // ── render helpers ────────────────────────────────────────────────────
    const garments = useMemo(() => visit?.garments ?? [], [visit]);
    const looks = (visit?.looks ?? []).filter((l) => l.status === 'succeeded' && l.imageUrl);
    const counts = useMemo(() => {
        const c = new Map<Category, number>();
        garments.forEach((g) => c.set(g.category ?? 'other', (c.get(g.category ?? 'other') ?? 0) + 1));
        return c;
    }, [garments]);
    const tabs = CATEGORY_ORDER.filter((c) => counts.get(c));
    const shown = tab === 'all' || tabs.length < 2 ? garments : garments.filter((g) => (g.category ?? 'other') === tab);
    const pieceOf = (id: string) => garments.find((g) => g.id === id);

    const primary = 'h-14 w-full rounded-full bg-cream font-display text-base font-semibold text-obsidian transition active:scale-[0.98] disabled:opacity-40';
    const secondary = 'h-12 w-full rounded-full border border-line text-sm font-semibold transition active:scale-[0.98] disabled:opacity-40';

    return (
        <main data-theme="dark" className="min-h-dvh bg-bg text-fg">
            <div className="mx-auto flex min-h-dvh w-full max-w-[460px] flex-col px-5 pb-10 pt-6">
                <header className="flex items-center justify-between">
                    <a href="https://www.emode.style/mirror" aria-label="Emode Mirror"><Wordmark className="text-[1.6rem]" /></a>
                    {session && stage !== 'done' && (
                        <button type="button" onClick={finish} className="text-sm font-semibold text-muted">Finish</button>
                    )}
                </header>

                {error && <p className="mt-5 rounded-2xl bg-surface-strong px-4 py-3 text-center text-sm">{error}</p>}

                {stage === 'start' && (
                    <section className="flex flex-1 flex-col pt-10 animate-rise">
                        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-gold">Emode Mirror</p>
                        <h1 className="mt-3 font-display text-5xl font-semibold leading-[0.95] tracking-tight">Try on<br />anything.</h1>
                        <p className="mt-4 text-muted">Add clothes from any store, take a photo, and see them on you — right here.</p>

                        <ul className="mt-8 space-y-3 rounded-3xl border border-line p-5 text-sm text-muted">
                            <li><span className="font-semibold text-fg">One photo</span> of you, to dress you in what you pick.</li>
                            <li><span className="font-semibold text-fg">Deleted when you finish</span> — or when you leave the page.</li>
                            <li><span className="font-semibold text-fg">Your looks are yours</span> to save. We keep them an hour, then delete them.</li>
                            <li><span className="font-semibold text-fg">Made with AI</span> — your photo and clothes go to an AI image service to create each look.</li>
                        </ul>

                        <div className="mt-auto pt-10">
                            <button type="button" disabled={busy} onClick={start} className={primary}>
                                {busy ? 'Starting…' : 'I’m 18 or over — let’s go'}
                            </button>
                            <p className="mt-3 text-center text-xs text-faint">No account needed.</p>
                        </div>
                    </section>
                )}

                {stage === 'pieces' && (
                    <section className="flex flex-1 flex-col pt-8 animate-rise">
                        <h1 className="font-display text-3xl font-semibold tracking-tight">Add your clothes.</h1>
                        <p className="mt-2 text-sm text-muted">Screenshots from any store, or a product link. Pick up to {MAX_PIECES} to wear.</p>

                        <input ref={piecesInput} type="file" accept="image/*" multiple hidden onChange={(e) => addFiles(e.target.files)} />
                        <div className="mt-6 space-y-3">
                            <button type="button" disabled={!!progress} onClick={() => piecesInput.current?.click()} className={primary}>
                                {progress || 'Add screenshots'}
                            </button>
                            <div className="flex gap-2">
                                <input value={link} onChange={(e) => setLink(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addLink()}
                                    inputMode="url" autoCapitalize="none" autoCorrect="off" placeholder="…or paste a product link"
                                    className="h-12 min-w-0 flex-1 rounded-full border border-line bg-surface px-4 text-sm outline-none focus:border-fg" />
                                <button type="button" disabled={!!progress || !link.trim()} onClick={addLink}
                                    className="h-12 shrink-0 rounded-full border border-fg px-5 text-sm font-semibold disabled:opacity-40">Add</button>
                            </div>
                            <p className="text-center text-xs text-faint">Links work for many stores. If one won&apos;t load, screenshot it instead.</p>
                        </div>

                        {garments.length > 0 && (
                            <>
                                {tabs.length > 1 && (
                                    <div className="mt-6 flex gap-2 overflow-x-auto pb-1">
                                        {(['all', ...tabs] as const).map((c) => (
                                            <button key={c} type="button" onClick={() => setTab(c)}
                                                className={`shrink-0 rounded-full px-3.5 py-1.5 text-xs font-semibold ${tab === c ? 'bg-fg text-bg' : 'border border-line text-muted'}`}>
                                                {c === 'all' ? `All ${garments.length}` : `${CATEGORY_LABELS[c]} ${counts.get(c)}`}
                                            </button>
                                        ))}
                                    </div>
                                )}
                                <div className="mt-4 grid grid-cols-3 gap-3">
                                    {shown.map((g) => <PieceTile key={g.id} garment={g} index={selected.indexOf(g.id)} onToggle={() => toggle(g.id)} onRemove={() => remove(g.id)} />)}
                                </div>
                            </>
                        )}

                        <div className="mt-auto space-y-3 pt-8">
                            <button type="button" disabled={!selected.length} onClick={() => (visit?.hasPhoto ? generate() : setStage('photo'))} className={primary}>
                                {selected.length ? `Try it on · ${selected.length} piece${selected.length > 1 ? 's' : ''}` : 'Add a piece to start'}
                            </button>
                            {looks.length > 0 && (
                                <button type="button" onClick={() => { setLookId(looks[looks.length - 1].id); setStage('result'); }} className={secondary}>My looks</button>
                            )}
                        </div>
                    </section>
                )}

                {stage === 'photo' && (
                    <section className="flex flex-1 flex-col pt-8 animate-rise">
                        <h1 className="font-display text-3xl font-semibold tracking-tight">Now, you.</h1>
                        <p className="mt-2 text-sm text-muted">A full-body photo — standing, head to toe — works best.</p>
                        <input ref={photoInput} type="file" accept="image/*" hidden onChange={(e) => uploadPhoto(e.target.files)} />
                        <div className="mt-6 space-y-3">
                            <button type="button" onClick={() => setStage('camera')} className="w-full rounded-3xl border border-line p-5 text-left transition active:scale-[0.99]">
                                <p className="font-display text-lg font-semibold">Take a photo</p>
                                <p className="mt-1 text-sm text-muted">Prop your phone or laptop up — we&apos;ll count you in.</p>
                            </button>
                            <button type="button" disabled={busy} onClick={() => photoInput.current?.click()} className="w-full rounded-3xl border border-line p-5 text-left transition active:scale-[0.99] disabled:opacity-50">
                                <p className="font-display text-lg font-semibold">{busy ? 'Uploading…' : 'Upload a photo of me'}</p>
                                <p className="mt-1 text-sm text-muted">Pick one you already have.</p>
                            </button>
                        </div>
                        <button type="button" onClick={() => setStage('pieces')} className="mt-6 text-sm text-muted">Back to my clothes</button>
                    </section>
                )}

                {stage === 'camera' && (
                    <section className="pt-6 animate-rise">
                        <WebCamera
                            busy={busy}
                            onUse={submitPhoto}
                            onUploadInstead={() => { setStage('photo'); setTimeout(() => photoInput.current?.click(), 50); }}
                            onBack={() => setStage('photo')}
                        />
                    </section>
                )}

                {stage === 'generating' && (
                    <section className="flex flex-1 flex-col items-center justify-center pt-8 text-center">
                        <div className="relative aspect-[9/16] w-full max-w-[300px] overflow-hidden rounded-3xl bg-surface">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            {photo && <img src={photo} alt="" className="absolute inset-0 h-full w-full object-cover opacity-40 blur-[2px]" />}
                            {look?.status !== 'failed' && (
                                <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-transparent via-[var(--glow)] to-transparent" style={{ animation: 'mirror-scan 3.2s linear infinite' }} />
                            )}
                        </div>
                        {look?.status === 'failed' ? (
                            <>
                                <h1 className="mt-6 font-display text-2xl font-semibold">That one didn&apos;t work.</h1>
                                <p className="mt-2 text-sm text-muted">{look.error}</p>
                                <div className="mt-6 w-full space-y-3">
                                    <button type="button" onClick={generate} className={primary}>Try again</button>
                                    <button type="button" onClick={() => setStage('pieces')} className={secondary}>Change outfit</button>
                                </div>
                            </>
                        ) : (
                            <>
                                <h1 className="mt-6 font-display text-3xl font-semibold">Styling you.</h1>
                                <p key={line} className="mt-2 text-muted animate-rise">{STYLING[line]}</p>
                                <p className="mt-6 text-xs text-faint">Usually 20–40 seconds.</p>
                            </>
                        )}
                    </section>
                )}

                {stage === 'result' && look?.imageUrl && (
                    <section className="flex flex-1 flex-col pt-6 animate-rise">
                        <div className="relative aspect-[9/16] w-full overflow-hidden rounded-3xl bg-black">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={look.imageUrl} alt="Your look" className="h-full w-full object-contain" />
                        </div>

                        {looks.length > 1 && (
                            <div className="mt-3 flex gap-2 overflow-x-auto">
                                {looks.map((l) => (
                                    <button key={l.id} type="button" onClick={() => setLookId(l.id)}
                                        className={`h-20 w-12 shrink-0 overflow-hidden rounded-lg ${l.id === look.id ? 'ring-2 ring-gold' : 'opacity-60'}`}>
                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                        <img src={l.imageUrl!} alt="" className="h-full w-full object-cover" />
                                    </button>
                                ))}
                            </div>
                        )}

                        <div className="mt-4 flex flex-wrap gap-2">
                            {look.garmentIds.map(pieceOf).filter(Boolean).map((g) => g!.productUrl ? (
                                <a key={g!.id} href={g!.productUrl} target="_blank" rel="noopener noreferrer"
                                    className="rounded-full border border-line px-3 py-1.5 text-xs underline-offset-2 hover:underline">
                                    Shop: {(g!.title || new URL(g!.productUrl).hostname).slice(0, 40)}
                                </a>
                            ) : null)}
                        </div>

                        <div className="mt-6 space-y-3">
                            <button type="button" onClick={() => saveImage(look.imageUrl!, `emode-look`)} className={primary}>Save this look</button>
                            <div className="flex gap-3">
                                <button type="button" onClick={() => setStage('pieces')} className={secondary}>Change outfit</button>
                                <button type="button" onClick={() => setStage('photo')} className={secondary}>New photo</button>
                            </div>
                        </div>

                        <a href={EMODE_APP_URL} target="_blank" rel="noopener noreferrer"
                            onClick={() => asPhone({ action: 'event.track', type: 'app_cta_tapped', where: 'phone_look' }).catch(() => {})}
                            className="mt-8 block rounded-3xl bg-surface p-5">
                            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-gold">Keep every look</p>
                            <p className="mt-2 font-display text-xl font-semibold leading-snug">Your wardrobe, your looks and the people whose style you love — in one app.</p>
                            <p className="mt-3 text-sm font-semibold underline underline-offset-4">Get Emode — it&apos;s free</p>
                        </a>
                    </section>
                )}

                {stage === 'done' && (
                    <section className="flex flex-1 flex-col items-center justify-center text-center animate-rise">
                        <h1 className="font-display text-4xl font-semibold tracking-tight">Thanks for trying it on.</h1>
                        <p className="mt-3 text-muted">Your photo has been deleted.</p>
                        <div className="mt-8 w-full space-y-3">
                            <a href={EMODE_APP_URL} target="_blank" rel="noopener noreferrer" className={`${primary} inline-flex items-center justify-center`}>Get the Emode app</a>
                            <button type="button" onClick={restart} className={secondary}>Start again</button>
                        </div>
                    </section>
                )}
            </div>
        </main>
    );
}

function PieceTile({ garment, index, onToggle, onRemove }: { garment: Garment; index: number; onToggle: () => void; onRemove: () => void }) {
    const on = index >= 0;
    return (
        <div className={`relative overflow-hidden rounded-2xl bg-white transition ${on ? 'ring-2 ring-gold' : 'ring-1 ring-line'}`}>
            <button type="button" onClick={onToggle} className="block aspect-[3/4] w-full">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {garment.imageUrl && <img src={garment.imageUrl} alt={garment.title || 'Clothing'} className="h-full w-full object-contain p-1" />}
            </button>
            {on && (
                <span className="pointer-events-none absolute left-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-gold text-xs font-bold text-obsidian">{index + 1}</span>
            )}
            <button type="button" aria-label="Remove" onClick={onRemove}
                className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-obsidian/80 text-xs text-cream">×</button>
        </div>
    );
}
