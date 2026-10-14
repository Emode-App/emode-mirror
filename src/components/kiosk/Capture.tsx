'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { captureFrame, openCamera } from '@/lib/camera';
import type { Rotation } from '@/lib/settings';
import { KioskButton } from './ui';

type Phase = 'starting' | 'live' | 'countdown' | 'review' | 'error';

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
    onUse,
    onCancel,
}: {
    cameraId: string | null;
    rotation: Rotation;
    busy: boolean;
    onUse: (dataUrl: string) => void;
    onCancel: () => void;
}) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const [phase, setPhase] = useState<Phase>('starting');
    const [count, setCount] = useState(3);
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
        setStill(captureFrame(video, rotation));
        setFlash((n) => n + 1);
        setPhase('review');
    }, [rotation]);

    useEffect(() => {
        if (phase !== 'countdown') return;
        if (count === 0) {
            snap();
            return;
        }
        const t = setTimeout(() => setCount((c) => c - 1), 1000);
        return () => clearTimeout(t);
    }, [phase, count, snap]);

    const rotated = rotation === 90 || rotation === 270;

    return (
        <div className="absolute inset-0">
            {/* Live, mirrored. Rotated first for a camera mounted on its side. */}
            <video
                ref={videoRef}
                muted
                playsInline
                className="absolute left-1/2 top-1/2 object-cover"
                style={{
                    width: rotated ? '177.78%' : '100%',
                    height: rotated ? '56.25%' : '100%',
                    transform: `translate(-50%, -50%) rotate(${rotation}deg) scaleX(-1)`,
                    opacity: phase === 'review' ? 0 : 1,
                }}
            />

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
                {(phase === 'live' || phase === 'countdown') && (
                    <>
                        <p className="font-display text-[1.9rem] font-semibold tracking-[-0.02em]">Step back</p>
                        <p className="mt-[0.4rem] text-[0.95rem] text-white/80">Until you can see yourself head to toe.</p>
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
                        <KioskButton tone="light" onClick={() => { setCount(3); setPhase('countdown'); }}>
                            Take my photo
                        </KioskButton>
                        <KioskButton tone="ghost-light" onClick={onCancel}>Back</KioskButton>
                    </>
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
