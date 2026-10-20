'use client';

import type { RefObject } from 'react';
import { clampFraming, type Framing } from '@/lib/camera';
import type { Rotation } from '@/lib/settings';

/**
 * The live camera, mirrored, rotated for how the camera is mounted, and
 * zoomed to this mirror's framing -- exactly the part captureFrame keeps.
 *
 * A wide camera high on a tall screen sees mostly ceiling with the shopper
 * small at the bottom; the framing crops in on where people stand.
 */
export function FramedVideo({
    videoRef,
    rotation,
    framing,
    hidden = false,
}: {
    videoRef: RefObject<HTMLVideoElement | null>;
    rotation: Rotation;
    framing: Framing | null | undefined;
    hidden?: boolean;
}) {
    const { zoom, cx, cy } = clampFraming(framing);
    const rotated = rotation === 90 || rotation === 270;
    return (
        <div className="absolute inset-0 overflow-hidden">
            <div
                className="absolute inset-0"
                style={{
                    // Move the framing's centre to the middle, then zoom about it.
                    transform: `scale(${zoom}) translate(${(0.5 - cx) * 100}%, ${(0.5 - cy) * 100}%)`,
                    transformOrigin: 'center',
                }}
            >
                <video
                    ref={videoRef}
                    muted
                    playsInline
                    className="absolute left-1/2 top-1/2 object-cover"
                    style={{
                        width: rotated ? '177.78%' : '100%',
                        height: rotated ? '56.25%' : '100%',
                        transform: `translate(-50%, -50%) rotate(${rotation}deg) scaleX(-1)`,
                        opacity: hidden ? 0 : 1,
                    }}
                />
            </div>
        </div>
    );
}
