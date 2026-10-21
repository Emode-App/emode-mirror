'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { drawFramed, openCamera, type Framing } from '@/lib/camera';
import { liveInput, LIVE_MODEL, LIVE_SECONDS, wearPiece, type LivePiece } from '@/lib/live';
import type { RackItem } from '@/lib/api';
import type { Rotation } from '@/lib/settings';
import { KioskButton } from './ui';

type Status = 'starting' | 'live' | 'ended' | 'error';

const pieceFromPick = (item: RackItem): LivePiece => ({
    key: `p:${item.id}`, productId: item.id, name: item.name,
    description: item.description ?? null, category: item.category, imageUrl: item.imageUrl,
});

/**
 * Live try-on: the shopper, dressed, in real time.
 *
 * The camera is cropped to this mirror's framing and sent, unmirrored, to
 * Decart over WebRTC; the dressed video that comes back is mirrored on screen
 * like a mirror. Quick picks swap a piece of the outfit without reconnecting
 * (new shoes replace the shoes; a suit replaces top and trousers). Each live
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
    onUnavailable,
    onPhoto,
    onDone,
}: {
    cameraId: string | null;
    rotation: Rotation;
    framing: Framing | null;
    pieces: LivePiece[];
    picks: RackItem[];
    getToken: () => Promise<string>;
    onLog: (phase: 'started' | 'ended' | 'failed', seconds?: number, reason?: string) => void;
    /** Live can't run for now (e.g. the Decart account is out of credits): stop offering it for a while. */
    onUnavailable?: () => void;
    /** Take a photo of the outfit being worn live. */
    onPhoto: (outfit: LivePiece[]) => void;
    onDone: () => void;
}) {
    const camRef = useRef<HTMLVideoElement>(null);
    const outRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const rtRef = useRef<{ set: (i: { prompt?: string; image?: Blob | string | null; enhance?: boolean }) => Promise<void>; disconnect: () => void } | null>(null);
    const cleanupRef = useRef<() => void>(() => {});
    const startedAt = useRef(0);
    const [status, setStatus] = useState<Status>('starting');
    const [message, setMessage] = useState<string | null>(null);
    const [secondsLeft, setSecondsLeft] = useState(LIVE_SECONDS);
    const [outfit, setOutfit] = useState<LivePiece[]>(pieces);
    const [swapping, setSwapping] = useState(false);
    const [retryable, setRetryable] = useState(false);
    // Bumped by "Try again" to run the whole connection again.
    const [attempt, setAttempt] = useState(0);

    // Latest props without restarting the connection when the kiosk re-renders.
    const props = useRef({ cameraId, rotation, framing, pieces, getToken, onLog, onUnavailable });
    useEffect(() => {
        props.current = { cameraId, rotation, framing, pieces, getToken, onLog, onUnavailable };
    });

    const stop = useCallback(() => {
        cleanupRef.current();
        cleanupRef.current = () => {};
    }, []);

    useEffect(() => {
        let cancelled = false;
        let timer: ReturnType<typeof setInterval> | undefined;
        let camera: MediaStream | null = null;
        let input: MediaStream | null = null;
        let logged = false;
        const p = props.current;

        // Give everything back: the model session, the camera, the stream we
        // drew for the model. Also run after a failed start, so a failure
        // never leaves the camera held for the next try.
        const release = () => {
            if (timer) clearInterval(timer);
            timer = undefined;
            rtRef.current?.disconnect();
            rtRef.current = null;
            camera?.getTracks().forEach((t) => t.stop());
            camera = null;
            input?.getTracks().forEach((t) => t.stop());
            input = null;
        };
        cleanupRef.current = () => {
            cancelled = true;
            release();
            if (logged) {
                logged = false;
                p.onLog('ended', Math.round((Date.now() - startedAt.current) / 1000));
            }
        };

        // What to tell the shopper, and whether trying again could help. The
        // real reason is logged for us, never shown on a public screen.
        const explain = (reason: string) => {
            if (/insufficient credits|credit|quota|payment|billing/i.test(reason)) {
                p.onUnavailable?.();
                return { text: 'Live is taking a break right now. You can still take a photo.', retry: false };
            }
            if (/limit|plenty/i.test(reason)) return { text: reason, retry: false };
            if (/camera|NotAllowed|NotFound|NotReadable|video source/i.test(reason)) {
                return { text: 'The camera isn’t available right now.', retry: true };
            }
            return { text: 'Live didn’t connect. Try again, or take a photo instead.', retry: true };
        };
        const fail = (reason: string) => {
            if (cancelled) return;
            console.warn('live failed', reason);
            release();
            p.onLog('failed', undefined, reason.slice(0, 160));
            const { text, retry } = explain(reason);
            setMessage(text);
            setRetryable(retry);
            setStatus('error');
        };

        (async () => {
            try {
                const { createDecartClient, models, resolveFpsNumber } = await import('@decartai/sdk');
                const model = models.realtime(LIVE_MODEL);
                const fps = resolveFpsNumber(model.fps, 25);
                // The model is 1280x720; a mirror is portrait, so it gets 720x1280.
                const outW = Math.min(model.width, model.height);
                const outH = Math.max(model.width, model.height);

                const opened = await openCamera(p.cameraId);
                if (cancelled) {
                    opened.getTracks().forEach((t) => t.stop());
                    return;
                }
                camera = opened;
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
                input = canvas.captureStream(fps);

                const client = createDecartClient({ apiKeyProvider: p.getToken, telemetry: false });
                const first = await liveInput(p.pieces);
                const rt = await client.realtime.connect(input, {
                    model,
                    mirror: false,
                    retries: 1,
                    onRemoteStream: (s: MediaStream) => {
                        const out = outRef.current;
                        if (!out) return;
                        out.srcObject = s;
                        out.play().catch(() => {});
                    },
                    initialState: {
                        prompt: { text: first.prompt, enhance: false },
                        ...(first.image ? { image: first.image } : {}),
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
                    if (/insufficient credits|credit|quota/i.test(e?.message || '')) fail(e?.message || 'credits');
                });
            } catch (e) {
                const err = e as { name?: string; message?: string; code?: string };
                fail([err?.code, err?.name, err?.message].filter(Boolean).join(': ') || String(e));
            }
        })();

        return () => cleanupRef.current();
    }, [attempt]);

    const retry = () => {
        stop();
        setMessage(null);
        setRetryable(false);
        setStatus('starting');
        setAttempt((n) => n + 1);
    };

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

    const dress = async (next: LivePiece[]) => {
        const rt = rtRef.current;
        if (!rt || swapping) return;
        setSwapping(true);
        setOutfit(next);
        try {
            const input = await liveInput(next);
            await rt.set({ prompt: input.prompt, image: input.image, enhance: false });
        } catch (e) {
            console.warn('live swap failed', e);
        } finally {
            setSwapping(false);
        }
    };
    const wear = (item: RackItem) => dress(wearPiece(outfit, pieceFromPick(item)));
    const original = outfit.length === pieces.length && outfit.every((o) => pieces.some((p) => p.key === o.key));

    const photo = () => {
        stop();
        onPhoto(outfit);
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
                <span className="max-w-[22rem] text-right text-[0.8rem] leading-[1.35] text-white/80">
                    {outfit.map((o) => o.name || 'Your piece').join(' + ')}
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
                            {status === 'error' && retryable && <KioskButton tone="light" onClick={retry}>Try again</KioskButton>}
                            <KioskButton tone={status === 'error' && retryable ? 'ghost-light' : 'light'} onClick={photo}>Take a photo of it</KioskButton>
                            <KioskButton tone="ghost-light" onClick={done}>Back</KioskButton>
                        </div>
                    </div>
                </div>
            )}

            {status === 'live' && (
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/50 to-transparent px-[2rem] pb-[3.4rem] pt-[5rem]">
                    {message && <p className="mb-[0.8rem] text-center text-[0.75rem] text-white/80">{message}</p>}
                    <div className="flex gap-[0.5rem] overflow-x-auto pb-[0.4rem] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                        <button type="button" onClick={() => dress(pieces)} disabled={swapping || original}
                            className={`grid w-[4.6rem] shrink-0 place-items-center rounded-[0.6rem] border-[0.08rem] text-center text-[0.55rem] font-semibold uppercase tracking-[0.12em] text-white
                                ${original ? 'border-gold bg-white/15' : 'border-white/30'}`}>
                            {original ? 'Your outfit' : 'Back to your outfit'}
                        </button>
                        {picks.map((item) => {
                            const on = outfit.some((o) => o.key === `p:${item.id}` || (o.productId === item.id));
                            return (
                                <button key={item.id} type="button" onClick={() => wear(item)} disabled={swapping}
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
