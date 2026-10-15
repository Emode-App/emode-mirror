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

/**
 * One frame as a portrait JPEG, flipped like a mirror.
 *
 * Flipped because the visitor has been looking at a mirrored preview, and the
 * look should show them the way they just saw themselves. Garment references
 * are not flipped, so printed text on clothing still reads correctly in the
 * result. Cropped to 9:16 from the centre of the sensor, after any rotation
 * the camera is mounted with.
 */
export function captureFrame(video: HTMLVideoElement, rotation: Rotation, maxHeight = 1920): string {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const rotated = rotation === 90 || rotation === 270;
    const srcW = rotated ? vh : vw;
    const srcH = rotated ? vw : vh;

    // Largest 9:16 rectangle that fits the (rotated) frame.
    let cropW = srcW;
    let cropH = (srcW * 16) / 9;
    if (cropH > srcH) {
        cropH = srcH;
        cropW = (srcH * 9) / 16;
    }
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
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.drawImage(video, -vw / 2, -vh / 2, vw, vh);

    return canvas.toDataURL('image/jpeg', 0.9);
}
