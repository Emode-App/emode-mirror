'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { captureFrame, openCamera, type Framing } from '@/lib/camera';
import type { Rotation } from '@/lib/settings';
import { FramedVideo } from './FramedVideo';
import { KioskButton } from './ui';

type Phase = 'starting' | 'live' | 'countdown' | 'review' | 'error';

// The shopper taps the button at arm's length, then has to walk back far
// enough for the camera to see them head to toe. Three seconds was not
// enough; ten is, with room to turn around and settle.
const STEP_BACK_SECONDS = 10;
// Pressed on the phone, the shopper is already standing back: just long
// enough to lower the phone and stand still.
const PHONE_SECONDS = 3;

/** The phone that scanned the code, working as a second camera button. */
export interface RemoteShutter {
    paired: boolean;
    /** Tell the phone the camera is (or is no longer) waiting for the photo. */
    setOpen: (open: boolean) => void;
    /** Whether the phone's button was pressed since the last ask. */
    poll: () => Promise<boolean>;
}

/**
 * A short tone, so someone walking backwards hears the photo coming without
 * watching the screen. The audio context is made on the tap that starts the
 * countdown, which is what lets it play at all.
 */
function tone(ctx: AudioContext | null, freq: number, ms: number) {
    if (!ctx) return;
    try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + ms / 1000);
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + ms / 1000 + 0.02);
    } catch {
        /* no sound is fine */
    }
}

/**
 * Full-body photo, taken like a mirror.
 *
 * Nothing leaves the screen until the visitor has seen the still and chosen to
 * use it -- a retake replaces the frame here, not a file on the server.
 */
export function Capture({
    cameraId,
    rotation,
    busy,
    framing,
    remote,
    onUse,
    onCancel,
}: {
    cameraId: string | null;
    rotation: Rotation;
    busy: boolean;
    /** This mirror's zoom onto where people stand; null for the whole picture. */
    framing?: Framing | null;
    remote?: RemoteShutter;
    onUse: (dataUrl: string) => void;
    onCancel: () => void;
}) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const [phase, setPhase] = useState<Phase>('starting');
    const [count, setCount] = useState(STEP_BACK_SECONDS);
    const audioRef = useRef<AudioContext | null>(null);
    const [fromPhone, setFromPhone] = useState(false);
    const remoteRef = useRef(remote);
    useEffect(() => {
        remoteRef.current = remote;
    });
    const paired = !!remote?.paired;
    const [still, setStill] = useState<string | null>(null);
    const [flash, setFlash] = useState(0);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        openCamera(cameraId)
            .then((stream) => {
                if (cancelled) {
                    stream.getTracks().forEach((t) => t.stop());
                    return;
                }
                streamRef.current = stream;
                if (videoRef.current) {
                    videoRef.current.srcObject = stream;
                    videoRef.current.play().catch(() => {});
                }
                setPhase('live');
            })
            .catch(() => {
                if (cancelled) return;
                setError("The camera isn't available right now.");
                setPhase('error');
            });
        return () => {
            cancelled = true;
            streamRef.current?.getTracks().forEach((t) => t.stop());
            streamRef.current = null;
        };
    }, [cameraId]);

    const snap = useCallback(() => {
        const video = videoRef.current;
        if (!video || !video.videoWidth) return;
        setStill(captureFrame(video, rotation, framing));
        setFlash((n) => n + 1);
        tone(audioRef.current, 1320, 180);
        setPhase('review');
    }, [rotation, framing]);

    useEffect(() => {
        if (phase !== 'countdown') return;
        if (count === 0) {
            snap();
            return;
        }
        if (count <= 3) tone(audioRef.current, 880, 120);
        const t = setTimeout(() => setCount((c) => c - 1), 1000);
        return () => clearTimeout(t);
    }, [phase, count, snap]);

    useEffect(() => () => {
        audioRef.current?.close().catch(() => {});
    }, []);

    const startCountdown = useCallback((seconds: number, phone: boolean) => {
        if (!audioRef.current) {
            try {
                const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
                audioRef.current = Ctx ? new Ctx() : null;
            } catch {
                audioRef.current = null;
            }
        }
        audioRef.current?.resume().catch(() => {});
        setFromPhone(phone);
        setCount(seconds);
        setPhase('countdown');
    }, []);

    // While the camera is waiting, the paired phone shows its own button.
    // Either button works; whichever is pressed first takes the photo.
    const waiting = phase === 'live';
    useEffect(() => {
        if (!paired) return;
        remoteRef.current?.setOpen(waiting);
        if (!waiting) return;
        let stopped = false;
        const id = setInterval(async () => {
            const pressed = await (remoteRef.current?.poll() ?? Promise.resolve(false)).catch(() => false);
            if (pressed && !stopped) startCountdown(PHONE_SECONDS, true);
        }, 1000);
        return () => {
            stopped = true;
            clearInterval(id);
        };
    }, [waiting, paired, startCountdown]);
    useEffect(() => () => remoteRef.current?.setOpen(false), []);

    return (
        <div className="absolute inset-0">
            {/* Live, mirrored, rotated for the mount, zoomed to the framing. */}
            <FramedVideo videoRef={videoRef} rotation={rotation} framing={framing} hidden={phase === 'review'} />

            {still && phase === 'review' && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={still} alt="Your photo" className="absolute inset-0 h-full w-full object-cover" />
            )}

            {flash > 0 && (
                <div key={flash} className="pointer-events-none absolute inset-0 bg-white" style={{ animation: 'mirror-flash 0.5s ease-out forwards' }} />
            )}

            {/* Framing guide while live. */}
            {(phase === 'live' || phase === 'countdown') && (
                <div className="pointer-events-none absolute inset-[2.2rem] rounded-[1.2rem] border-[0.12rem] border-white/35" />
            )}

            <div className="absolute inset-x-0 top-0 bg-gradient-to-b from-black/70 to-transparent px-[2rem] pb-[6rem] pt-[2.6rem] text-center text-white">
                {phase === 'starting' && <p className="text-[1.3rem] font-display animate-soft-pulse">Starting the camera…</p>}
                {phase === 'live' && (
                    <>
                        <p className="font-display text-[1.9rem] font-semibold tracking-[-0.02em]">Tap, then step back</p>
                        <p className="mt-[0.4rem] text-[0.95rem] text-white/80">
                            You&apos;ll have {STEP_BACK_SECONDS} seconds to get your whole body in the frame, head to toe.
                        </p>
                        {paired && (
                            <p className="mx-auto mt-[0.9rem] max-w-[30rem] rounded-full bg-white/12 px-[1.2rem] py-[0.5rem] text-[0.9rem] text-white">
                                Or step back first and tap <span className="font-semibold">Take my photo</span> on your phone.
                            </p>
                        )}
                    </>
                )}
                {phase === 'countdown' && (
                    <>
                        <p className="font-display text-[2.6rem] font-semibold tracking-[-0.02em]">{fromPhone ? 'Hold still' : 'Step back'}</p>
                        <p className="mt-[0.4rem] text-[1.1rem] text-white/85">
                            {fromPhone ? 'Look at the mirror.' : 'Head to toe in the frame. Stand still.'}
                        </p>
                    </>
                )}
                {phase === 'review' && (
                    <>
                        <p className="font-display text-[1.9rem] font-semibold tracking-[-0.02em]">Happy with this?</p>
                        <p className="mt-[0.4rem] text-[0.95rem] text-white/80">This is the photo we&apos;ll dress you in.</p>
                    </>
                )}
                {phase === 'error' && <p className="font-display text-[1.4rem]">{error}</p>}
            </div>

            {phase === 'countdown' && count > 0 && (
                <div className="pointer-events-none absolute inset-0 grid place-items-center">
                    <span key={count} className="font-display text-[11rem] font-bold text-white drop-shadow-[0_0.3rem_2rem_rgba(0,0,0,0.6)]" style={{ animation: 'mirror-count 1s ease-out both' }}>
                        {count}
                    </span>
                </div>
            )}

            <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-[1rem] bg-gradient-to-t from-black/75 to-transparent px-[3rem] pb-[5rem] pt-[8rem]">
                {phase === 'live' && (
                    <>
                        <KioskButton tone="light" onClick={() => startCountdown(STEP_BACK_SECONDS, false)}>
                            Take my photo
                        </KioskButton>
                        <KioskButton tone="ghost-light" onClick={onCancel}>Back</KioskButton>
                    </>
                )}
                {phase === 'countdown' && (
                    <KioskButton tone="ghost-light" onClick={() => setPhase('live')}>Stop</KioskButton>
                )}
                {phase === 'review' && still && (
                    <>
                        <KioskButton tone="light" disabled={busy} onClick={() => onUse(still)}>
                            {busy ? 'Saving…' : 'Use this photo'}
                        </KioskButton>
                        <KioskButton tone="ghost-light" disabled={busy} onClick={() => { setStill(null); setPhase('live'); }}>
                            Retake
                        </KioskButton>
                    </>
                )}
                {phase === 'error' && <KioskButton tone="light" onClick={onCancel}>Back</KioskButton>}
            </div>
        </div>
    );
}
