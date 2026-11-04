'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mirrorCall, MirrorError, type DeviceHello, type RackItem, type SessionState, type Theme } from '@/lib/api';
import { readLaunchParams, settings, type LaunchParams } from '@/lib/settings';
import { Capture } from './Capture';
import { Live } from './Live';
import type { LivePiece } from '@/lib/live';
import { Attract, Consent, Ending, Generating, Pair, Result, StillThere, Unregistered, Visitor, Wardrobe } from './Screens';
import { EMODE_APP_URL, RETAILERS_URL } from '@/lib/links';

type Stage =
    | { name: 'boot' }
    | { name: 'visitor' }
    | { name: 'unregistered'; message: string }
    | { name: 'attract' }
    | { name: 'consent' }
    | { name: 'pair' }
    | { name: 'wardrobe' }
    | { name: 'capture' }
    | { name: 'generating'; lookId: string }
    | { name: 'result'; lookId: string }
    | { name: 'live' }
    | { name: 'ending' };

// How long a screen may sit untouched before the mirror asks, and how long it
// waits for an answer before ending the visit. Pairing is longer because the
// visitor is legitimately looking at their phone, not the mirror.
const IDLE_MS = 90_000;
const IDLE_PAIRING_MS = 180_000;
const IDLE_GRACE_MS = 15_000;
const IDLE_STAGES = new Set<Stage['name']>(['consent', 'pair', 'wardrobe', 'capture', 'result']);

export function Kiosk() {
    const [launch, setLaunch] = useState<LaunchParams | null>(null);
    const [hello, setHello] = useState<DeviceHello | null>(null);
    const [theme, setTheme] = useState<Theme>('dark');
    const [stage, setStage] = useState<Stage>({ name: 'boot' });
    const [session, setSession] = useState<{ id: string; token: string } | null>(null);
    const [state, setState] = useState<SessionState | null>(null);
    const [selected, setSelected] = useState<string[]>([]);
    // The still the visitor approved, kept in memory only, as the backdrop
    // while their look generates. Never written anywhere on this screen.
    const [photo, setPhoto] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [idleLeft, setIdleLeft] = useState<number | null>(null);
    const [ending, setEnding] = useState<{ phoneUrl: string | null; retainUntil: string | null } | null>(null);
    // The pieces a Live stretch started from, and the screen it was opened
    // from -- where "Done" goes back to, with everything still on it.
    const [liveIds, setLiveIds] = useState<string[]>([]);
    const [liveFrom, setLiveFrom] = useState<Stage>({ name: 'pair' });
    const [liveOffUntil, setLiveOffUntil] = useState(0);
    // The store's rack, when this mirror belongs to a store that has one.
    const [rack, setRack] = useState<RackItem[]>([]);
    const [rackPending, setRackPending] = useState<string | null>(null);
    const [wardrobeTab, setWardrobeTab] = useState<'rack' | 'all'>('all');

    const lastTouch = useRef(Date.now());
    const autoSelected = useRef(false);
    const garmentCount = useRef(0);
    const camera = useMemo(() => (typeof window === 'undefined'
        ? { id: null, rotation: 0 as const }
        : { id: settings.cameraId(), rotation: settings.rotation() }), []);

    const maxPieces = hello?.limits.garmentsPerLook ?? 6;
    const phoneUrl = session && typeof window !== 'undefined'
        ? `${window.location.origin}/s/${session.id}#${session.token}`
        : '';

    const call = useCallback(<T,>(body: Record<string, unknown>) => mirrorCall<T>(body, launch?.deviceKey), [launch]);

    // ── Boot ──────────────────────────────────────────────────────────────
    useEffect(() => {
        const params = readLaunchParams();
        setLaunch(params);
        setTheme(params.themeOverride ?? settings.theme() ?? 'dark');
        // No device link at all is a visitor, not a broken mirror. A key that
        // the server refuses is a mirror that needs attention, and says so.
        if (!params.deviceKey) {
            setStage({ name: 'visitor' });
            return;
        }

        let retry: ReturnType<typeof setTimeout>;
        const connect = () => mirrorCall<DeviceHello>({ action: 'device.hello', protoSerial: params.protoSerial }, params.deviceKey)
            .then((h) => {
                setHello(h);
                setTheme(params.themeOverride ?? settings.theme() ?? h.device.theme);
                setStage({ name: 'attract' });
            })
            .catch((e: MirrorError) => {
                setStage({ name: 'unregistered', message: e.message });
                // Venue Wi-Fi drops. Keep trying rather than wait for someone
                // to notice the screen and power-cycle it.
                if (e.code === 'offline') retry = setTimeout(connect, 10_000);
            });
        connect();
        return () => clearTimeout(retry);
    }, []);

    const reset = useCallback(() => {
        setSession(null);
        setState(null);
        setSelected([]);
        setPhoto(null);
        setEnding(null);
        setError(null);
        setIdleLeft(null);
        autoSelected.current = false;
        garmentCount.current = 0;
        setStage(hello ? { name: 'attract' } : { name: 'boot' });
    }, [hello]);

    // ── Polling the visit ─────────────────────────────────────────────────
    const polling = session && ['pair', 'wardrobe', 'generating', 'result', 'capture'].includes(stage.name);
    useEffect(() => {
        if (!polling || !session) return;
        let stopped = false;
        const tick = async () => {
            try {
                const next = await call<SessionState>({ action: 'session.state', sessionId: session.id });
                if (!stopped) setState(next);
            } catch (e) {
                const err = e as MirrorError;
                if (!stopped && err.code === 'session_gone') reset();
            }
        };
        tick();
        const id = setInterval(tick, stage.name === 'generating' ? 1500 : 2000);
        return () => {
            stopped = true;
            clearInterval(id);
        };
    }, [polling, session, stage.name, call, reset]);

    // Garments arriving from the phone are activity, and keep the selection honest.
    useEffect(() => {
        if (!state) return;
        if (state.garments.length !== garmentCount.current) {
            garmentCount.current = state.garments.length;
            lastTouch.current = Date.now();
        }
        const ids = new Set(state.garments.map((g) => g.id));
        setSelected((sel) => (sel.every((id) => ids.has(id)) ? sel : sel.filter((id) => ids.has(id))));
    }, [state]);

    // A look finishing moves the mirror on by itself.
    useEffect(() => {
        if (stage.name !== 'generating' || !state) return;
        const look = state.looks.find((l) => l.id === stage.lookId);
        if (look?.status === 'succeeded' && look.imageUrl) setStage({ name: 'result', lookId: look.id });
    }, [state, stage]);

    // ── Actions ───────────────────────────────────────────────────────────
    const accept = async () => {
        setBusy(true);
        setError(null);
        try {
            const r = await call<{ sessionId: string; token: string }>({ action: 'session.start', consent: true, adult: true });
            setSession({ id: r.sessionId, token: r.token });
            setState(null);
            setSelected([]);
            autoSelected.current = false;
            setStage({ name: 'pair' });
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(false);
        }
    };

    // The rack is read fresh for each visit, so pieces the store adds or sells
    // out of show up without restarting the screen.
    const hasRack = !!(hello?.rack?.available ?? hello?.store?.hasRack);
    // What the start and result screens offer to scan: the app, Emode for
    // retailers (only on Emode's own mirrors), and this mirror's credit line.
    const share = { appUrl: EMODE_APP_URL, retailersUrl: hello?.store ? null : RETAILERS_URL, credit: hello?.credit ?? null };
    useEffect(() => {
        if (!session || !hasRack) return;
        call<{ items: RackItem[] }>({ action: 'catalog.list' })
            .then((r) => setRack(r.items))
            .catch(() => setRack([]));
    }, [session, hasRack, call]);

    // Checks in every few minutes while it is on, so a store's dashboard can
    // tell a mirror that is quiet from one that is switched off -- and so the
    // screen notices when its store's rack fills or changes.
    const online = !!hello;
    useEffect(() => {
        if (!online || !launch?.deviceKey) return;
        const id = setInterval(() => {
            mirrorCall<DeviceHello>({ action: 'device.hello' }, launch.deviceKey).then(setHello).catch(() => {});
        }, 5 * 60_000);
        return () => clearInterval(id);
    }, [online, launch]);

    // A mirror stays open for days, so it would keep running whatever version
    // it loaded. Every few minutes it asks which deploy is live; when that is
    // newer, it reloads itself -- but only while idle on the start screen, never
    // in the middle of someone's visit.
    const [updateReady, setUpdateReady] = useState(false);
    useEffect(() => {
        const mine = process.env.NEXT_PUBLIC_BUILD_ID;
        if (!online || !mine || mine === 'dev') return;
        const check = () => fetch('/version', { cache: 'no-store' })
            .then((r) => r.json())
            .then((v: { build?: string }) => { if (v.build && v.build !== 'dev' && v.build !== mine) setUpdateReady(true); })
            .catch(() => {});
        const id = setInterval(check, 3 * 60_000);
        return () => clearInterval(id);
    }, [online]);
    useEffect(() => {
        if (updateReady && stage.name === 'attract' && !session) window.location.reload();
    }, [updateReady, stage.name, session]);

    const openWardrobe = (tab: 'rack' | 'all' = 'all') => {
        // First time in from the phone: everything they sent is probably what
        // they want on, so start with it all selected rather than make them
        // tap each piece. Arriving at the rack, nothing is chosen for them.
        if (!autoSelected.current && state && tab === 'all') {
            autoSelected.current = true;
            // Keep anything already picked from the rack on the first screen.
            const ownIds = state.garments.filter((g) => g.source !== 'catalog').map((g) => g.id);
            setSelected((sel) => [...new Set([...sel, ...ownIds])].slice(0, maxPieces));
        }
        setWardrobeTab(tab);
        setStage({ name: 'wardrobe' });
    };

    // A rack piece becomes a garment on first tap; after that it toggles like
    // any other piece.
    const toggleRack = async (productId: string) => {
        if (!session) return;
        const existing = state?.garments.find((g) => g.productId === productId);
        if (existing) return toggle(existing.id);
        if (selected.length >= maxPieces) {
            setError(`Up to ${maxPieces} pieces at once — tap one to take it off.`);
            return;
        }
        setRackPending(productId);
        try {
            const r = await call<{ garmentId: string }>({ action: 'garment.from_catalog', sessionId: session.id, productId });
            setSelected((sel) => (sel.includes(r.garmentId) ? sel : [...sel, r.garmentId].slice(0, maxPieces)));
            setState(await call<SessionState>({ action: 'session.state', sessionId: session.id }));
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setRackPending(null);
        }
    };

    const toggle = (id: string) => {
        setError(null);
        setSelected((sel) => {
            if (sel.includes(id)) return sel.filter((x) => x !== id);
            if (sel.length >= maxPieces) {
                setError(`Up to ${maxPieces} pieces at once — tap one to take it off.`);
                return sel;
            }
            return [...sel, id];
        });
    };

    const generate = async (garmentIds = selected) => {
        if (!session) return;
        setError(null);
        try {
            const r = await call<{ lookId: string }>({ action: 'look.generate', sessionId: session.id, garmentIds });
            setStage({ name: 'generating', lookId: r.lookId });
        } catch (e) {
            const err = e as MirrorError;
            if (err.code === 'no_photo') {
                setStage({ name: 'capture' });
                return;
            }
            setError(err.message);
            setStage({ name: 'wardrobe' });
        }
    };

    const tryOn = () => (state?.hasPhoto ? generate() : setStage({ name: 'capture' }));

    const submitPhoto = async (dataUrl: string) => {
        if (!session) return;
        setBusy(true);
        try {
            await call({ action: 'session.capture', sessionId: session.id, image: dataUrl });
            setPhoto(dataUrl);
            setState((s) => (s ? { ...s, hasPhoto: true } : s));
            await generate();
        } catch (e) {
            setError((e as Error).message);
            setStage({ name: 'wardrobe' });
        } finally {
            setBusy(false);
        }
    };

    // Why the visit ended goes to the server for the funnel: a visit that ran
    // out the idle timer and one that finished on purpose are different stories.
    const finish = useCallback(async (reason: 'finish' | 'idle' | 'cancel' = 'finish') => {
        setIdleLeft(null);
        if (!session) {
            reset();
            return;
        }
        const ended = session;
        const url = phoneUrl;
        setPhoto(null);
        setStage({ name: 'ending' });
        setEnding({ phoneUrl: url, retainUntil: null });
        try {
            const r = await call<{ retainMinutes: number }>({ action: 'session.end', sessionId: ended.id, reason });
            setEnding({ phoneUrl: url, retainUntil: new Date(Date.now() + r.retainMinutes * 60_000).toISOString() });
        } catch {
            // The server sweep ends it regardless; the screen should not hang.
        }
        setSession(null);
    }, [session, phoneUrl, call, reset]);

    // ── Idle ──────────────────────────────────────────────────────────────
    const stageRef = useRef(stage);
    const finishRef = useRef(finish);
    useEffect(() => {
        stageRef.current = stage;
        lastTouch.current = Date.now();
    }, [stage]);
    useEffect(() => { finishRef.current = finish; }, [finish]);

    useEffect(() => {
        const touched = () => {
            lastTouch.current = Date.now();
            setIdleLeft(null);
        };
        window.addEventListener('pointerdown', touched, true);
        const id = setInterval(() => {
            const name = stageRef.current.name;
            if (!IDLE_STAGES.has(name)) return;
            const limit = name === 'pair' ? IDLE_PAIRING_MS : IDLE_MS;
            const idle = Date.now() - lastTouch.current;
            if (idle < limit) {
                setIdleLeft(null);
                return;
            }
            const left = Math.ceil((limit + IDLE_GRACE_MS - idle) / 1000);
            if (left <= 0) finishRef.current('idle');
            else setIdleLeft(left);
        }, 1000);
        return () => {
            window.removeEventListener('pointerdown', touched, true);
            clearInterval(id);
        };
    }, []);

    useEffect(() => {
        if (!error) return;
        const t = setTimeout(() => setError(null), 7000);
        return () => clearTimeout(t);
    }, [error]);

    // ── Render ────────────────────────────────────────────────────────────
    const garments = state?.garments ?? [];
    const looks = state?.looks ?? [];
    const piecesFor = (ids: string[]) => ids.map((id) => garments.find((g) => g.id === id)).filter(Boolean) as typeof garments;

    // Live: the realtime try-on, offered only where the mirror has it set up.
    const goLive = (ids: string[]) => {
        if (!ids.length) return;
        setLiveIds(ids);
        setLiveFrom(stage);
        setStage({ name: 'live' });
    };
    // After Live says it can't run (out of credits), stop offering it for a while.
    const liveOn = !!hello?.live && Date.now() > liveOffUntil;
    const onLive = liveOn && session ? () => goLive(selected) : undefined;
    const latestLook = [...looks].reverse().find((l) => l.status === 'succeeded' && l.imageUrl);

    let screen: React.ReactNode = null;
    switch (stage.name) {
        case 'boot':
            screen = <div className="grid h-full place-items-center text-[1rem] text-faint animate-soft-pulse">Starting…</div>;
            break;
        case 'visitor':
            screen = <Visitor appUrl={EMODE_APP_URL} />;
            break;
        case 'unregistered':
            screen = <Unregistered message={stage.message} />;
            break;
        case 'attract':
            screen = <Attract location={hello?.device.location ?? null} store={hello?.store ?? null} rackAvailable={hasRack} share={share} onStart={() => setStage({ name: 'consent' })} />;
            break;
        case 'consent':
            screen = <Consent busy={busy} onAccept={accept} onDecline={reset} />;
            break;
        case 'pair':
            screen = (
                <Pair
                    phoneUrl={phoneUrl}
                    garments={garments}
                    linked={!!state?.linked}
                    store={hello?.store ?? null}
                    rack={rack}
                    rackPending={rackPending}
                    selected={selected}
                    maxPieces={maxPieces}
                    error={error}
                    onToggleRack={toggleRack}
                    onTryOn={tryOn}
                    onLive={onLive}
                    onContinue={() => openWardrobe('all')}
                    onBrowseRack={() => openWardrobe('rack')}
                    onCancel={() => finish('cancel')}
                />
            );
            break;
        case 'wardrobe':
            screen = (
                <Wardrobe
                    garments={garments}
                    selected={selected}
                    maxPieces={maxPieces}
                    hasPhoto={!!state?.hasPhoto}
                    hasLooks={!!latestLook}
                    linked={!!state?.linked}
                    phoneUrl={phoneUrl}
                    error={error}
                    store={hello?.store ?? null}
                    rack={rack}
                    rackPending={rackPending}
                    initialTab={wardrobeTab}
                    onToggle={toggle}
                    onToggleRack={toggleRack}
                    onTryOn={tryOn}
                    onLive={onLive}
                    onNewPhoto={() => setStage({ name: 'capture' })}
                    onBackToLooks={() => latestLook && setStage({ name: 'result', lookId: latestLook.id })}
                    onFinish={() => finish('finish')}
                />
            );
            break;
        case 'live':
            screen = session && (
                <Live
                    cameraId={camera.id}
                    rotation={camera.rotation}
                    framing={hello?.framing ?? null}
                    pieces={piecesFor(liveIds).map((g): LivePiece => ({
                        key: g.id, garmentId: g.id, productId: g.productId ?? undefined,
                        name: g.title, description: g.description, category: g.category, imageUrl: g.imageUrl,
                    }))}
                    picks={rack.slice(0, 30)}
                    getToken={() => call<{ apiKey: string }>({ action: 'live.token', sessionId: session.id }).then((r) => r.apiKey)}
                    onLog={(phase, seconds, reason) => { call({ action: 'live.log', sessionId: session.id, phase, seconds, reason }).catch(() => {}); }}
                    onUnavailable={() => setLiveOffUntil(Date.now() + 10 * 60_000)}
                    onSnap={async (image, outfit) => {
                        lastTouch.current = Date.now();
                        // The pieces worn live, as pieces of the visit, so the snap
                        // goes home with links to them like any look.
                        const ids = (await Promise.all(outfit.map(async (piece) => {
                            if (piece.garmentId) return piece.garmentId;
                            if (!piece.productId) return null;
                            try {
                                const r = await call<{ garmentId: string }>({ action: 'garment.from_catalog', sessionId: session.id, productId: piece.productId });
                                return r.garmentId;
                            } catch {
                                return null;
                            }
                        }))).filter((id): id is string => !!id);
                        await call({ action: 'look.snapshot', sessionId: session.id, image, garmentIds: ids });
                        try {
                            setState(await call<SessionState>({ action: 'session.state', sessionId: session.id }));
                        } catch { /* the next poll catches up */ }
                    }}
                    remote={{
                        paired: !!state?.phonePaired,
                        setOpen: (open) => { call({ action: 'session.camera', sessionId: session.id, open }).catch(() => {}); },
                        poll: () => call<{ pressed: boolean }>({ action: 'session.shutter', sessionId: session.id }).then((r) => r.pressed),
                    }}
                    onShowLooks={() => {
                        lastTouch.current = Date.now();
                        if (latestLook) setStage({ name: 'result', lookId: latestLook.id });
                        else setStage(liveFrom);
                    }}
                    onPhoto={async (outfit) => {
                        lastTouch.current = Date.now();
                        // Rack pieces worn live become pieces of the visit, then the photo.
                        const ids: string[] = [];
                        for (const piece of outfit) {
                            if (piece.garmentId) {
                                ids.push(piece.garmentId);
                            } else if (piece.productId) {
                                try {
                                    const r = await call<{ garmentId: string }>({ action: 'garment.from_catalog', sessionId: session.id, productId: piece.productId });
                                    ids.push(r.garmentId);
                                } catch (e) {
                                    setError((e as Error).message);
                                }
                            }
                        }
                        setSelected(ids.slice(0, maxPieces));
                        try {
                            setState(await call<SessionState>({ action: 'session.state', sessionId: session.id }));
                        } catch { /* the regular poll catches up */ }
                        setStage({ name: 'capture' });
                    }}
                    onDone={() => {
                        lastTouch.current = Date.now();
                        setStage(liveFrom);
                    }}
                />
            );
            break;
        case 'capture':
            screen = (
                <Capture
                    cameraId={camera.id}
                    rotation={camera.rotation}
                    busy={busy}
                    framing={hello?.framing ?? null}
                    remote={session ? {
                        paired: !!state?.phonePaired,
                        setOpen: (open) => { call({ action: 'session.camera', sessionId: session.id, open }).catch(() => {}); },
                        poll: () => call<{ pressed: boolean }>({ action: 'session.shutter', sessionId: session.id }).then((r) => r.pressed),
                    } : undefined}
                    onUse={submitPhoto}
                    onCancel={() => setStage({ name: 'wardrobe' })}
                />
            );
            break;
        case 'generating': {
            const look = looks.find((l) => l.id === stage.lookId);
            screen = (
                <Generating
                    photo={photo}
                    pieces={piecesFor(look?.garmentIds ?? selected)}
                    failure={look?.status === 'failed' ? (look.error || 'Something went wrong.') : null}
                    onRetry={() => generate(look?.garmentIds ?? selected)}
                    onChangeOutfit={() => setStage({ name: 'wardrobe' })}
                />
            );
            break;
        }
        case 'result': {
            const look = looks.find((l) => l.id === stage.lookId);
            screen = look ? (
                <Result
                    look={look}
                    looks={looks}
                    pieces={piecesFor(look.garmentIds)}
                    share={share}
                    onSelectLook={(id) => setStage({ name: 'result', lookId: id })}
                    onChangeOutfit={() => setStage({ name: 'wardrobe' })}
                    onNewPhoto={() => setStage({ name: 'capture' })}
                    onLive={liveOn ? () => goLive(look.garmentIds) : undefined}
                    onFinish={() => finish('finish')}
                />
            ) : null;
            break;
        }
        case 'ending':
            screen = <Ending phoneUrl={ending?.phoneUrl ?? null} retainUntil={ending?.retainUntil ?? null} onDone={reset} />;
            break;
    }

    return (
        <div data-theme={theme} className="kiosk-stage fixed inset-0 grid place-items-center bg-bg text-fg">
            {/* Always 9:16, whatever the window. On a Luma that is the whole panel. */}
            <div className="kiosk-frame relative overflow-hidden">
                {screen}

                {error && stage.name !== 'wardrobe' && stage.name !== 'pair' && (
                    <div className="absolute inset-x-[2.6rem] top-[2.4rem] z-40 rounded-[0.7rem] bg-surface-strong px-[1.2rem] py-[0.9rem] text-center text-[0.9rem] animate-rise">
                        {error}
                    </div>
                )}

                {idleLeft !== null && <StillThere secondsLeft={idleLeft} onStay={() => { lastTouch.current = Date.now(); setIdleLeft(null); }} />}
            </div>
        </div>
    );
}
