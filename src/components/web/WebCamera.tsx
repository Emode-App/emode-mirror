'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { captureFrame, openFrontCamera } from '@/lib/camera';

type Phase = 'starting' | 'live' | 'countdown' | 'review' | 'error';

/**
 * Full-body photo on the visitor's own phone or laptop.
 *
 * Unlike the Luma, the person has to tap the button and then walk back into
 * frame, so the countdown is long. Uploading an existing photo is always one
 * tap away -- for anyone without a camera, without a shelf to prop the phone
 * on, or who simply has a better picture already.
 */
export function WebCamera({
    busy,
    onUse,
    onUploadInstead,
    onBack,
}: {
    busy: boolean;
    onUse: (dataUrl: string) => void;
    onUploadInstead: () => void;
    onBack: () => void;
}) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const [phase, setPhase] = useState<Phase>('starting');
    const [count, setCount] = useState(7);
    const [still, setStill] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        openFrontCamera()
            .then((stream) => {
                if (cancelled) return stream.getTracks().forEach((t) => t.stop());
                streamRef.current = stream;
                if (videoRef.current) {
                    videoRef.current.srcObject = stream;
                    videoRef.current.play().catch(() => {});
                }
                setPhase('live');
            })
            .catch(() => !cancelled && setPhase('error'));
        return () => {
            cancelled = true;
            streamRef.current?.getTracks().forEach((t) => t.stop());
        };
    }, []);

    const snap = useCallback(() => {
        const v = videoRef.current;
        if (!v?.videoWidth) return;
        setStill(captureFrame(v, 0));
        setPhase('review');
    }, []);

    useEffect(() => {
        if (phase !== 'countdown') return;
        if (count === 0) return snap();
        const t = setTimeout(() => setCount((c) => c - 1), 1000);
        return () => clearTimeout(t);
    }, [phase, count, snap]);

    return (
        <div className="flex flex-col gap-4">
            <div className="relative aspect-[9/16] w-full overflow-hidden rounded-3xl bg-neutral-900">
                <video ref={videoRef} muted playsInline
                    className="absolute inset-0 h-full w-full object-cover"
                    style={{ transform: 'scaleX(-1)', opacity: phase === 'review' ? 0 : 1 }} />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {still && phase === 'review' && <img src={still} alt="Your photo" className="absolute inset-0 h-full w-full object-cover" />}

                {(phase === 'live' || phase === 'countdown') && (
                    <div className="pointer-events-none absolute inset-4 rounded-2xl border-2 border-white/30" />
                )}
                {phase === 'countdown' && count > 0 && (
                    <div className="absolute inset-0 grid place-items-center bg-black/20">
                        <div className="text-center text-white">
                            <span key={count} className="block font-display text-[7rem] font-bold leading-none drop-shadow-lg" style={{ animation: 'mirror-count 1s ease-out both' }}>{count}</span>
                            <span className="mt-2 block text-sm font-semibold drop-shadow">Step back — head to toe</span>
                        </div>
                    </div>
                )}
                {phase === 'starting' && <p className="absolute inset-0 grid place-items-center text-sm text-white/70 animate-soft-pulse">Starting the camera…</p>}
                {phase === 'error' && (
                    <div className="absolute inset-0 grid place-items-center p-8 text-center">
                        <p className="text-white/80">The camera isn&apos;t available. Upload a full-body photo instead.</p>
                    </div>
                )}
            </div>

            {phase === 'live' && (
                <>
                    <button type="button" onClick={() => { setCount(7); setPhase('countdown'); }}
                        className="h-14 rounded-full bg-cream font-display text-base font-semibold text-obsidian active:scale-[0.98]">
                        Start the timer
                    </button>
                    <p className="text-center text-xs text-faint">Prop your phone or laptop up, tap, then step back until you&apos;re head to toe in frame.</p>
                </>
            )}
            {phase === 'countdown' && (
                <button type="button" onClick={() => setPhase('live')} className="h-12 rounded-full border border-line text-sm font-semibold">Cancel</button>
            )}
            {phase === 'review' && still && (
                <div className="flex gap-3">
                    <button type="button" disabled={busy} onClick={() => { setStill(null); setPhase('live'); }}
                        className="h-14 flex-1 rounded-full border border-line font-semibold disabled:opacity-40">Retake</button>
                    <button type="button" disabled={busy} onClick={() => onUse(still)}
                        className="h-14 flex-[2] rounded-full bg-cream font-display font-semibold text-obsidian disabled:opacity-50">
                        {busy ? 'Saving…' : 'Use this photo'}
                    </button>
                </div>
            )}
            <div className="flex justify-between text-sm">
                <button type="button" onClick={onBack} className="text-muted underline-offset-4 hover:underline">Back</button>
                <button type="button" onClick={onUploadInstead} className="font-semibold underline underline-offset-4">Upload a photo instead</button>
            </div>
        </div>
    );
}
