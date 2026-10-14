'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mirrorCall, MirrorError, type DeviceHello, type SessionState, type Theme } from '@/lib/api';
import { readLaunchParams, settings, type LaunchParams } from '@/lib/settings';
import { Capture } from './Capture';
import { Attract, Consent, Ending, Generating, Pair, Result, StillThere, Unregistered, Wardrobe } from './Screens';

type Stage =
    | { name: 'boot' }
    | { name: 'unregistered'; message: string }
    | { name: 'attract' }
    | { name: 'consent' }
    | { name: 'pair' }
    | { name: 'wardrobe' }
    | { name: 'capture' }
    | { name: 'generating'; lookId: string }
    | { name: 'result'; lookId: string }
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
        if (!params.deviceKey) {
            setStage({ name: 'unregistered', message: 'This screen isn’t set up as an Emode Mirror yet.' });
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

    const openWardrobe = () => {
        // First time in: everything they sent is probably what they want on,
        // so start with it all selected rather than make them tap each piece.
        if (!autoSelected.current && state) {
            autoSelected.current = true;
            setSelected(state.garments.slice(-maxPieces).map((g) => g.id));
        }
        setStage({ name: 'wardrobe' });
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

    const finish = useCallback(async () => {
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
            const r = await call<{ retainMinutes: number }>({ action: 'session.end', sessionId: ended.id });
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
            if (left <= 0) finishRef.current();
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
    const latestLook = [...looks].reverse().find((l) => l.status === 'succeeded' && l.imageUrl);

    let screen: React.ReactNode = null;
    switch (stage.name) {
        case 'boot':
            screen = <div className="grid h-full place-items-center text-[1rem] text-faint animate-soft-pulse">Starting…</div>;
            break;
        case 'unregistered':
            screen = <Unregistered message={stage.message} />;
            break;
        case 'attract':
            screen = <Attract location={hello?.device.location ?? null} onStart={() => setStage({ name: 'consent' })} />;
            break;
        case 'consent':
            screen = <Consent busy={busy} onAccept={accept} onDecline={reset} />;
            break;
        case 'pair':
            screen = <Pair phoneUrl={phoneUrl} garments={garments} onContinue={openWardrobe} onCancel={finish} />;
            break;
        case 'wardrobe':
            screen = (
                <Wardrobe
                    garments={garments}
                    selected={selected}
                    maxPieces={maxPieces}
                    hasPhoto={!!state?.hasPhoto}
                    hasLooks={!!latestLook}
                    phoneUrl={phoneUrl}
                    error={error}
                    onToggle={toggle}
                    onTryOn={tryOn}
                    onNewPhoto={() => setStage({ name: 'capture' })}
                    onBackToLooks={() => latestLook && setStage({ name: 'result', lookId: latestLook.id })}
                    onFinish={finish}
                />
            );
            break;
        case 'capture':
            screen = (
                <Capture
                    cameraId={camera.id}
                    rotation={camera.rotation}
                    busy={busy}
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
                    onSelectLook={(id) => setStage({ name: 'result', lookId: id })}
                    onChangeOutfit={() => setStage({ name: 'wardrobe' })}
                    onNewPhoto={() => setStage({ name: 'capture' })}
                    onFinish={finish}
                />
            ) : null;
            break;
        }
        case 'ending':
            screen = <Ending phoneUrl={ending?.phoneUrl ?? null} retainUntil={ending?.retainUntil ?? null} onDone={reset} />;
            break;
    }

    return (
        <div data-theme={theme} className="fixed inset-0 grid place-items-center bg-bg text-fg">
            {/* Always 9:16, whatever the window. On a Luma that is the whole panel. */}
            <div className="relative overflow-hidden" style={{ width: 'min(100vw, 56.25vh)', height: 'min(100vh, 177.78vw)' }}>
                {screen}

                {error && stage.name !== 'wardrobe' && (
                    <div className="absolute inset-x-[2.6rem] top-[2.4rem] z-40 rounded-[0.7rem] bg-surface-strong px-[1.2rem] py-[0.9rem] text-center text-[0.9rem] animate-rise">
                        {error}
                    </div>
                )}

                {idleLeft !== null && <StillThere secondsLeft={idleLeft} onStay={() => { lastTouch.current = Date.now(); setIdleLeft(null); }} />}
            </div>
        </div>
    );
}
