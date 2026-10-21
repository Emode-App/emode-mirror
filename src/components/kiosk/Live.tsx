'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { drawFramed, openCamera, type Framing } from '@/lib/camera';
import { liveOutfit, LIVE_MODEL, LIVE_SECONDS, type LivePiece } from '@/lib/live';
import type { RackItem } from '@/lib/api';
import type { Rotation } from '@/lib/settings';
import { KioskButton } from './ui';

type Status = 'starting' | 'live' | 'ended' | 'error';

/** What the shopper is wearing live: their outfit, or one quick pick. */
type Wearing = { kind: 'outfit' } | { kind: 'pick'; item: RackItem };

/**
 * Live try-on: the shopper, dressed, in real time.
 *
 * The camera is cropped to this mirror's framing and sent, unmirrored, to
 * Decart over WebRTC; the dressed video that comes back is mirrored on screen
 * like a mirror. Quick picks swap the garment without reconnecting. Each live
 * stretch stops by itself after LIVE_SECONDS -- live costs by the second --
 * and "Take a photo" hands over to the still-photo flow for a sharp keeper.
 */
export function Live({
    cameraId,
    rotation,
    framing,
    pieces,
    picks,
    getToken,
    onLog,
    onPhoto,
    onDone,
}: {
    cameraId: string | null;
    rotation: Rotation;
    framing: Framing | null;
    pieces: LivePiece[];
    picks: RackItem[];
    getToken: () => Promise<string>;
    onLog: (phase: 'started' | 'ended', seconds?: number) => void;
    onPhoto: (pick: RackItem | null) => void;
    onDone: () => void;
}) {
    const camRef = useRef<HTMLVideoElement>(null);
    const outRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const rtRef = useRef<{ set: (i: { prompt?: string; image?: string | null; enhance?: boolean }) => Promise<void>; disconnect: () => void } | null>(null);
    const cleanupRef = useRef<() => void>(() => {});
    const startedAt = useRef(0);
    const [status, setStatus] = useState<Status>('starting');
    const [message, setMessage] = useState<string | null>(null);
    const [secondsLeft, setSecondsLeft] = useState(LIVE_SECONDS);
    const [wearing, setWearing] = useState<Wearing>({ kind: 'outfit' });
    const [swapping, setSwapping] = useState(false);

    // Latest props without restarting the connection when the kiosk re-renders.
    const props = useRef({ cameraId, rotation, framing, pieces, getToken, onLog });
    useEffect(() => {
        props.current = { cameraId, rotation, framing, pieces, getToken, onLog };
    });

    const stop = useCallback(() => {
        cleanupRef.current();
        cleanupRef.current = () => {};
    }, []);

    useEffect(() => {
        let cancelled = false;
        let timer: ReturnType<typeof setInterval> | undefined;
        let camera: MediaStream | null = null;
        let logged = false;
        const p = props.current;

        cleanupRef.current = () => {
            cancelled = true;
            if (timer) clearInterval(timer);
            rtRef.current?.disconnect();
            rtRef.current = null;
            camera?.getTracks().forEach((t) => t.stop());
            if (logged) {
                logged = false;
                p.onLog('ended', Math.round((Date.now() - startedAt.current) / 1000));
            }
        };

        (async () => {
            try {
                const { createDecartClient, models, resolveFpsNumber } = await import('@decartai/sdk');
                const model = models.realtime(LIVE_MODEL);
                const fps = resolveFpsNumber(model.fps, 25);
                // The model is 1280x720; a mirror is portrait, so it gets 720x1280.
                const outW = Math.min(model.width, model.height);
                const outH = Math.max(model.width, model.height);

                camera = await openCamera(p.cameraId);
                if (cancelled) return;
                const cam = camRef.current!;
                cam.srcObject = camera;
                await cam.play().catch(() => {});

                const canvas = canvasRef.current!;
                canvas.width = outW;
                canvas.height = outH;
                const ctx = canvas.getContext('2d')!;
                timer = setInterval(() => {
                    if (cam.videoWidth) drawFramed(ctx, cam, p.rotation, p.framing, outW, outH, false);
                }, 1000 / fps);
                const input = canvas.captureStream(fps);

                const client = createDecartClient({ apiKeyProvider: p.getToken, telemetry: false });
                const outfit = liveOutfit(p.pieces);
                const rt = await client.realtime.connect(input, {
                    model,
                    mirror: false,
                    retries: 2,
                    onRemoteStream: (s: MediaStream) => {
                        const out = outRef.current;
                        if (!out) return;
                        out.srcObject = s;
                        out.play().catch(() => {});
                    },
                    initialState: {
                        prompt: { text: outfit.prompt, enhance: false },
                        ...(outfit.image ? { image: outfit.image } : {}),
                    },
                });
                if (cancelled) {
                    rt.disconnect();
                    return;
                }
                rtRef.current = rt;
                const onState = (state: string) => {
                    if (state === 'generating' && !logged) {
                        logged = true;
                        startedAt.current = Date.now();
                        p.onLog('started');
                        setStatus('live');
                    } else if (state === 'disconnected' && !cancelled) {
                        setStatus((s) => (s === 'live' ? 'ended' : s));
                    }
                };
                rt.on('connectionChange', onState);
                onState(rt.getConnectionState());
                rt.on('error', (e: { message?: string; code?: string }) => {
                    console.warn('live error', e?.code, e?.message);
                    if (e?.code === 'WEB_RTC_ERROR') setMessage('The network here is blocking live video.');
                });
            } catch (e) {
                if (cancelled) return;
                console.warn('live failed to start', e);
                const text = (e as Error)?.message || '';
                setMessage(/limit|plenty/i.test(text) ? text
                    : /camera|NotAllowed|NotFound/i.test(text) ? 'The camera isn’t available right now.'
                        : 'Live isn’t available right now. You can still take a photo.');
                setStatus('error');
            }
        })();

        return () => cleanupRef.current();
    }, []);

    // The stretch stops on its own; live is billed by the second.
    useEffect(() => {
        if (status !== 'live') return;
        const id = setInterval(() => {
            const left = LIVE_SECONDS - Math.floor((Date.now() - startedAt.current) / 1000);
            setSecondsLeft(Math.max(0, left));
            if (left <= 0) {
                stop();
                setStatus('ended');
            }
        }, 500);
        return () => clearInterval(id);
    }, [status, stop]);

    const wear = async (next: Wearing) => {
        const rt = rtRef.current;
        if (!rt || swapping) return;
        setSwapping(true);
        setWearing(next);
        const outfit = next.kind === 'outfit'
            ? liveOutfit(pieces)
            : liveOutfit([{ name: next.item.name, description: next.item.description ?? null, category: next.item.category, imageUrl: next.item.imageUrl }]);
        try {
            await rt.set({ prompt: outfit.prompt, image: outfit.image, enhance: false });
        } catch (e) {
            console.warn('live swap failed', e);
        } finally {
            setSwapping(false);
        }
    };

    const photo = () => {
        const pick = wearing.kind === 'pick' ? wearing.item : null;
        stop();
        onPhoto(pick);
    };
    const done = () => {
        stop();
        onDone();
    };

    const mm = `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`;

    return (
        <div className="absolute inset-0 bg-black">
            {/* Inputs: the camera, and the framed portrait crop sent to the model. */}
            <video ref={camRef} muted playsInline className="pointer-events-none absolute h-px w-px opacity-0" />
            <canvas ref={canvasRef} className="hidden" />

            {/* What comes back, mirrored like a mirror. */}
            <video ref={outRef} muted playsInline autoPlay
                className="absolute inset-0 h-full w-full object-cover"
                style={{ transform: 'scaleX(-1)', opacity: status === 'live' ? 1 : 0.25 }} />

            <div className="absolute inset-x-0 top-0 flex items-start justify-between bg-gradient-to-b from-black/70 to-transparent px-[2.2rem] pb-[4rem] pt-[2.4rem] text-white">
                <div className="flex items-center gap-[0.6rem]">
                    <span className={`h-[0.7rem] w-[0.7rem] rounded-full ${status === 'live' ? 'bg-red-500 animate-soft-pulse' : 'bg-white/40'}`} />
                    <span className="font-display text-[0.9rem] font-semibold uppercase tracking-[0.25em]">Live</span>
                    {status === 'live' && <span className="text-[0.85rem] text-white/70">{mm}</span>}
                </div>
                <span className="max-w-[20rem] truncate text-right text-[0.8rem] text-white/80">
                    {wearing.kind === 'pick' ? wearing.item.name : 'Your outfit'}
                </span>
            </div>

            {status === 'starting' && (
                <div className="absolute inset-0 grid place-items-center px-[4rem] text-center text-white">
                    <div>
                        <p className="font-display text-[1.6rem] font-semibold animate-soft-pulse">Getting the mirror ready…</p>
                        <p className="mt-[0.8rem] text-[0.8rem] text-white/60">
                            Step back so the mirror sees you head to toe. Live sends the camera&apos;s video to an AI video service while it&apos;s on.
                        </p>
                    </div>
                </div>
            )}

            {(status === 'ended' || status === 'error') && (
                <div className="absolute inset-0 grid place-items-center bg-black/70 px-[4rem] text-center text-white">
                    <div className="flex flex-col items-center gap-[1rem]">
                        <p className="font-display text-[1.6rem] font-semibold">{status === 'ended' ? 'That’s live for now.' : 'Live didn’t start.'}</p>
                        {message && <p className="text-[0.85rem] text-white/70">{message}</p>}
                        <div className="mt-[0.6rem] flex flex-col items-center gap-[0.7rem]">
                            <KioskButton tone="light" onClick={photo}>Take a photo of it</KioskButton>
                            <KioskButton tone="ghost-light" onClick={done}>Back</KioskButton>
                        </div>
                    </div>
                </div>
            )}

            {status === 'live' && (
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/50 to-transparent px-[2rem] pb-[3.4rem] pt-[5rem]">
                    {message && <p className="mb-[0.8rem] text-center text-[0.75rem] text-white/80">{message}</p>}
                    <div className="flex gap-[0.5rem] overflow-x-auto pb-[0.4rem] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                        <button type="button" onClick={() => wear({ kind: 'outfit' })} disabled={swapping}
                            className={`grid w-[4.6rem] shrink-0 place-items-center rounded-[0.6rem] border-[0.08rem] text-center text-[0.55rem] font-semibold uppercase tracking-[0.12em] text-white
                                ${wearing.kind === 'outfit' ? 'border-gold bg-white/15' : 'border-white/30'}`}>
                            Your outfit
                        </button>
                        {picks.map((item) => {
                            const on = wearing.kind === 'pick' && wearing.item.id === item.id;
                            return (
                                <button key={item.id} type="button" onClick={() => wear({ kind: 'pick', item })} disabled={swapping}
                                    aria-label={item.name}
                                    className={`relative aspect-[3/4] w-[4.6rem] shrink-0 overflow-hidden rounded-[0.6rem] bg-white ${on ? 'ring-[0.16rem] ring-gold' : ''}`}>
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img src={item.imageUrl} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-contain p-[0.15rem]" />
                                </button>
                            );
                        })}
                    </div>
                    <div className="mt-[1rem] flex justify-center gap-[0.6rem]">
                        <KioskButton tone="light" className="min-w-[13rem]" onClick={photo}>Take a photo</KioskButton>
                        <KioskButton tone="ghost-light" className="min-w-[8rem]" onClick={done}>Done</KioskButton>
                    </div>
                </div>
            )}
        </div>
    );
}
