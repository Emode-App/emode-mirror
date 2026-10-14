// Per-screen settings for the kiosk, kept in the browser on that screen.
//
// The device key normally arrives in the launch URL configured on the Proto,
// and is remembered so a reload or a crash-restart without the query string
// still comes back as the same mirror. The rest is chosen on /calibrate.

import type { Theme } from './api';

const KEYS = {
    device: 'emode-mirror.device',
    theme: 'emode-mirror.theme',
    cameraId: 'emode-mirror.cameraId',
    rotation: 'emode-mirror.rotation',
} as const;

export type Rotation = 0 | 90 | 180 | 270;

function read(key: string): string | null {
    try {
        return window.localStorage.getItem(key);
    } catch {
        return null;
    }
}

function write(key: string, value: string | null) {
    try {
        if (value === null) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, value);
    } catch {
        /* private mode or storage disabled: the URL still works */
    }
}

export interface LaunchParams {
    deviceKey: string | null;
    protoSerial: string | null;
    themeOverride: Theme | null;
}

/** What this launch was given, falling back to what this screen remembers. */
export function readLaunchParams(): LaunchParams {
    const q = new URLSearchParams(window.location.search);
    const fromUrl = q.get('device');
    if (fromUrl) write(KEYS.device, fromUrl);
    const theme = q.get('theme');
    return {
        deviceKey: fromUrl || read(KEYS.device),
        protoSerial: q.get('protoSerialNumber'),
        themeOverride: theme === 'dark' || theme === 'light' ? theme : null,
    };
}

export const settings = {
    theme: (): Theme | null => {
        const v = read(KEYS.theme);
        return v === 'dark' || v === 'light' ? v : null;
    },
    setTheme: (t: Theme | null) => write(KEYS.theme, t),
    cameraId: () => read(KEYS.cameraId),
    setCameraId: (id: string | null) => write(KEYS.cameraId, id),
    rotation: (): Rotation => {
        const v = Number(read(KEYS.rotation));
        return ([0, 90, 180, 270] as const).includes(v as Rotation) ? (v as Rotation) : 0;
    },
    setRotation: (r: Rotation) => write(KEYS.rotation, String(r)),
};
