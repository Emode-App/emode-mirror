// Camera access on a Proto Luma, or any screen with a webcam.
//
// Proto grants camera access to apps without a permission prompt, but a Luma
// reports more than one video input: the real camera, plus a capture device on
// its second HDMI port (and an Epic adds a RealSense depth camera). Proto's
// own guidance is to filter those out by label, which is what usableCameras
// does -- "RealSense" in full, since plenty of ordinary webcams on other
// screens are made by Realtek. If that still picks the wrong one, /calibrate
// stores an explicit choice that wins.

import type { Rotation } from './settings';

export interface CameraInfo {
    deviceId: string;
    label: string;
    excluded: boolean;
}

const NOT_A_CAMERA = /hdmi|realsense/i;

export async function listCameras(): Promise<CameraInfo[]> {
    // Labels are empty until the page has been granted a stream once.
    try {
        const probe = await navigator.mediaDevices.getUserMedia({ video: true });
        probe.getTracks().forEach((t) => t.stop());
    } catch {
        /* no camera, or refused: list whatever is visible */
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
        .filter((d) => d.kind === 'videoinput')
        .map((d, i) => ({
            deviceId: d.deviceId,
            label: d.label || `Camera ${i + 1}`,
            excluded: !!d.label && NOT_A_CAMERA.test(d.label),
        }));
}

export async function openCamera(preferredId?: string | null): Promise<MediaStream> {
    const cameras = await listCameras();
    const chosen = cameras.find((c) => c.deviceId === preferredId)
        ?? cameras.find((c) => !c.excluded)
        ?? cameras[0];
    if (!chosen) throw new Error('No camera found');

    return navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
            deviceId: { exact: chosen.deviceId },
            width: { ideal: 3840 },
            height: { ideal: 2160 },
            frameRate: { ideal: 30 },
        },
    });
}

/** How far the photo zooms in, and where: the centre of the view in the mirrored preview. */
export interface Framing {
    zoom: number;
    cx: number;
    cy: number;
}

/** A framing that stays inside the camera's picture (no zooming past its edges). */
export function clampFraming(framing: Framing | null | undefined): Framing {
    const zoom = Math.min(4, Math.max(1, framing?.zoom ?? 1));
    const half = 0.5 / zoom;
    const clamp = (v: number | undefined) => Math.min(1 - half, Math.max(half, v ?? 0.5));
    return { zoom, cx: clamp(framing?.cx), cy: clamp(framing?.cy) };
}

/**
 * One frame as a portrait JPEG, flipped like a mirror.
 *
 * Flipped because the visitor has been looking at a mirrored preview, and the
 * look should show them the way they just saw themselves. Garment references
 * are not flipped, so printed text on clothing still reads correctly in the
 * result. Cropped to 9:16 from the centre of the sensor, after any rotation
 * the camera is mounted with, then to this mirror's framing -- the same part
 * of the picture the preview showed.
 */
export function captureFrame(video: HTMLVideoElement, rotation: Rotation, framing?: Framing | null, maxHeight = 1920): string {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const rotated = rotation === 90 || rotation === 270;
    const srcW = rotated ? vh : vw;
    const srcH = rotated ? vw : vh;

    // Largest 9:16 rectangle that fits the (rotated) frame.
    let baseW = srcW;
    let baseH = (srcW * 16) / 9;
    if (baseH > srcH) {
        baseH = srcH;
        baseW = (srcH * 9) / 16;
    }

    // Then the framing's window within it, in the preview's (mirrored) terms.
    const { zoom, cx, cy } = clampFraming(framing);
    const cropW = baseW / zoom;
    const cropH = baseH / zoom;
    const offX = (cx - 0.5) * baseW; // mirrored: right in the preview is left on the sensor
    const offY = (cy - 0.5) * baseH;

    const scale = Math.min(1, maxHeight / cropH);
    const outW = Math.round(cropW * scale);
    const outH = Math.round(cropH * scale);

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d')!;

    ctx.translate(outW / 2, outH / 2);
    ctx.scale(-1, 1);
    ctx.scale(scale, scale);
    ctx.translate(offX, -offY);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.drawImage(video, -vw / 2, -vh / 2, vw, vh);

    return canvas.toDataURL('image/jpeg', 0.9);
}
