'use client';

import { useEffect, useRef, useState } from 'react';
import { clampFraming, listCameras, type CameraInfo, type Framing } from '@/lib/camera';
import { readLaunchParams, settings, type Rotation } from '@/lib/settings';
import { mirrorCall, type DeviceHello, type Theme } from '@/lib/api';
import { Wordmark } from '@/components/Wordmark';
import { FramedVideo } from '@/components/kiosk/FramedVideo';

/**
 * Hardware check for a new screen. Open it on the device itself.
 *
 * Proto's docs leave three things to find out on the hardware: which colour
 * reads as empty space on the panel, which video input is the real camera,
 * and how that camera is mounted. Each answer is saved on this screen and the
 * mirror picks it up on its next launch. Framing -- how far the photo zooms in
 * on where people stand -- is saved to the mirror itself, so it survives a
 * reinstall and can be adjusted remotely.
 */
export default function Calibrate() {
    const [info, setInfo] = useState<Record<string, string>>({});
    const [theme, setTheme] = useState<Theme | null>(null);
    const [cameras, setCameras] = useState<CameraInfo[]>([]);
    const [cameraId, setCameraId] = useState<string | null>(null);
    const [rotation, setRotation] = useState<Rotation>(0);
    const [cameraError, setCameraError] = useState<string | null>(null);
    const [resolution, setResolution] = useState('');
    const [touches, setTouches] = useState<{ id: number; x: number; y: number }[]>([]);
    const [maxTouches, setMaxTouches] = useState(0);
    const [saved, setSaved] = useState<string | null>(null);
    const [deviceKey, setDeviceKey] = useState<string | null>(null);
    const [framing, setFraming] = useState<Framing>({ zoom: 1, cx: 0.5, cy: 0.5 });
    const [showFull, setShowFull] = useState(false);
    const videoRef = useRef<HTMLVideoElement>(null);
    const streamRef = useRef<MediaStream | null>(null);

    useEffect(() => {
        const q = new URLSearchParams(window.location.search);
        setInfo({
            Viewport: `${window.innerWidth} × ${window.innerHeight}`,
            'Device pixel ratio': String(window.devicePixelRatio),
            Screen: `${window.screen.width} × ${window.screen.height}`,
            'Effective pixels': `${Math.round(window.innerWidth * window.devicePixelRatio)} × ${Math.round(window.innerHeight * window.devicePixelRatio)}`,
            'Proto serial': q.get('protoSerialNumber') || '— (enable “Include Serial Number” on the Proto app)',
            'Device key': q.get('device') || localStorage.getItem('emode-mirror.device') ? 'present' : 'missing',
            Browser: navigator.userAgent,
        });
        setTheme(settings.theme());
        const key = readLaunchParams().deviceKey;
        setDeviceKey(key);
        if (key) {
            mirrorCall<DeviceHello>({ action: 'device.hello' }, key)
                .then((h) => { if (h.framing) setFraming(clampFraming(h.framing)); })
                .catch(() => {});
        }
        setCameraId(settings.cameraId());
        setRotation(settings.rotation());
        listCameras()
            .then((list) => {
                setCameras(list);
                if (!settings.cameraId()) setCameraId(list.find((c) => !c.excluded)?.deviceId ?? list[0]?.deviceId ?? null);
            })
            .catch(() => setCameraError('Could not list cameras.'));
    }, []);

    useEffect(() => {
        if (!cameraId) return;
        let cancelled = false;
        streamRef.current?.getTracks().forEach((t) => t.stop());
        navigator.mediaDevices
            .getUserMedia({ video: { deviceId: { exact: cameraId }, width: { ideal: 3840 }, height: { ideal: 2160 } } })
            .then((stream) => {
                if (cancelled) return stream.getTracks().forEach((t) => t.stop());
                streamRef.current = stream;
                const s = stream.getVideoTracks()[0]?.getSettings();
                setResolution(s ? `${s.width} × ${s.height} @ ${Math.round(s.frameRate || 0)}fps` : '');
                if (videoRef.current) {
                    videoRef.current.srcObject = stream;
                    videoRef.current.play().catch(() => {});
                }
                setCameraError(null);
            })
            .catch((e) => !cancelled && setCameraError(`That camera would not open: ${e?.name || e}`));
        return () => {
            cancelled = true;
        };
    }, [cameraId]);

    useEffect(() => () => streamRef.current?.getTracks().forEach((t) => t.stop()), []);

    const nudge = (change: Partial<Framing>) => setFraming((f) => clampFraming({ ...f, ...change }));
    const saveFraming = async (next: Framing | null) => {
        if (!deviceKey) return flash('Open this page with the mirror’s device link to save framing');
        try {
            await mirrorCall({ action: 'device.framing', framing: next }, deviceKey);
            if (!next) setFraming({ zoom: 1, cx: 0.5, cy: 0.5 });
            flash(next ? 'Framing saved — the mirror uses it from its next visit' : 'Framing reset to the whole picture');
        } catch (e) {
            flash(`Couldn’t save: ${(e as Error).message}`);
        }
    };
    const shown = clampFraming(framing);

    const flash = (msg: string) => {
        setSaved(msg);
        setTimeout(() => setSaved(null), 2500);
    };

    const onTouch = (e: React.TouchEvent) => {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const pts = Array.from(e.touches).map((t) => ({ id: t.identifier, x: t.clientX - rect.left, y: t.clientY - rect.top }));
        setTouches(pts);
        setMaxTouches((m) => Math.max(m, pts.length));
    };

    const launchUrl = (() => {
        if (typeof window === 'undefined') return '/';
        const q = new URLSearchParams(window.location.search);
        const keep = new URLSearchParams();
        for (const k of ['device', 'protoSerialNumber']) if (q.get(k)) keep.set(k, q.get(k)!);
        return `/${keep.toString() ? `?${keep}` : ''}`;
    })();

    const section = 'rounded-[0.8rem] border-[0.06rem] border-line bg-surface p-[1.4rem]';
    const h2 = 'font-display text-[1.15rem] font-semibold';
    const btn = 'rounded-full px-[1.2rem] py-[0.6rem] text-[0.75rem] font-semibold font-display border-[0.06rem] border-line active:scale-95';

    return (
        <div data-theme="dark" className="h-screen overflow-y-auto bg-bg px-[2rem] py-[2.4rem] text-fg">
            <div className="mx-auto flex max-w-[40rem] flex-col gap-[1.4rem]">
                <div className="flex items-center justify-between">
                    <Wordmark className="text-[1.6rem]" />
                    <a href={launchUrl} className={`${btn} bg-fg text-bg`}>Open the mirror →</a>
                </div>
                <p className="text-[0.75rem] text-muted">Hardware check. Settings save on this screen only.</p>
                {saved && <p className="rounded-[0.5rem] bg-gold px-[1rem] py-[0.6rem] text-[0.75rem] font-semibold text-obsidian">{saved}</p>}

                {/* 1. Empty colour */}
                <section className={section}>
                    <h2 className={h2}>1 · Which side looks empty?</h2>
                    <p className="mt-[0.4rem] text-[0.72rem] text-muted">
                        Stand back from the panel. One of these should look like open space inside the display, the other like a solid sheet. The mirror uses the empty one as its background, and asks the AI to put you on it.
                    </p>
                    <div className="mt-[1rem] grid h-[18rem] grid-cols-2 overflow-hidden rounded-[0.6rem]">
                        <div className="grid place-items-center bg-black text-[0.8rem] text-white/70">Black</div>
                        <div className="grid place-items-center bg-white text-[0.8rem] text-black/60">White</div>
                    </div>
                    <div className="mt-[1rem] flex flex-wrap gap-[0.6rem]">
                        {(['dark', 'light'] as const).map((t) => (
                            <button key={t} type="button" className={`${btn} ${theme === t ? 'bg-gold text-obsidian border-gold' : ''}`}
                                onClick={() => { settings.setTheme(t); setTheme(t); flash(`Saved: ${t === 'dark' ? 'black' : 'white'} is empty`); }}>
                                {t === 'dark' ? 'Black looks empty' : 'White looks empty'}
                            </button>
                        ))}
                        <button type="button" className={btn} onClick={() => { settings.setTheme(null); setTheme(null); flash('Using the device default'); }}>
                            Use device default
                        </button>
                    </div>
                </section>

                {/* 2. Camera */}
                <section className={section}>
                    <h2 className={h2}>2 · Camera</h2>
                    <p className="mt-[0.4rem] text-[0.72rem] text-muted">
                        Inputs named HDMI or RealSense are skipped automatically, per Proto. Pick the one that shows you, then turn it until you&apos;re upright.
                    </p>
                    <div className="mt-[0.9rem] flex flex-col gap-[0.4rem]">
                        {cameras.length === 0 && <p className="text-[0.72rem] text-faint">{cameraError || 'Looking for cameras…'}</p>}
                        {cameras.map((c) => (
                            <button key={c.deviceId} type="button" onClick={() => setCameraId(c.deviceId)}
                                className={`${btn} text-left ${cameraId === c.deviceId ? 'bg-surface-strong border-gold' : ''}`}>
                                {c.label}{c.excluded ? '  · skipped by default' : ''}
                            </button>
                        ))}
                    </div>

                    <div className="relative mt-[1rem] aspect-[9/16] w-full overflow-hidden rounded-[0.6rem] bg-black">
                        <FramedVideo videoRef={videoRef} rotation={rotation} framing={showFull ? null : framing} />
                        {showFull ? (
                            <div className="pointer-events-none absolute border-[0.12rem] border-gold"
                                style={{
                                    left: `${(shown.cx - 0.5 / shown.zoom) * 100}%`,
                                    top: `${(shown.cy - 0.5 / shown.zoom) * 100}%`,
                                    width: `${100 / shown.zoom}%`,
                                    height: `${100 / shown.zoom}%`,
                                }} />
                        ) : (
                            <div className="pointer-events-none absolute inset-[6%] rounded-[0.6rem] border-[0.08rem] border-white/40" />
                        )}
                    </div>
                    <p className="mt-[0.5rem] text-[0.65rem] text-faint">
                        {resolution && `Sensor ${resolution}. `}{cameraError}
                    </p>
                    <div className="mt-[0.8rem] flex flex-wrap gap-[0.5rem]">
                        {([0, 90, 180, 270] as const).map((r) => (
                            <button key={r} type="button" className={`${btn} ${rotation === r ? 'bg-gold text-obsidian border-gold' : ''}`}
                                onClick={() => setRotation(r)}>
                                {r}°
                            </button>
                        ))}
                        <button type="button" className={`${btn} bg-fg text-bg`}
                            onClick={() => { settings.setCameraId(cameraId); settings.setRotation(rotation); flash('Camera saved'); }}>
                            Save camera
                        </button>
                    </div>
                </section>

                {/* 3. Framing */}
                <section className={section}>
                    <h2 className={h2}>3 · Framing</h2>
                    <p className="mt-[0.4rem] text-[0.72rem] text-muted">
                        Stand where shoppers will stand, then zoom and move until you fill the picture head to toe with a little room
                        around you. The preview above shows exactly what the photo will capture.
                        {resolution && ` At this zoom the photo is about ${Math.round(Number(resolution.split(' × ')[1]?.split(' ')[0] || 0) / shown.zoom)} pixels tall.`}
                    </p>
                    <div className="mt-[1rem] flex items-center gap-[0.8rem]">
                        <span className="w-[4.5rem] text-[0.72rem] text-faint">Zoom</span>
                        <input type="range" min={1} max={3.5} step={0.05} value={shown.zoom}
                            onChange={(e) => nudge({ zoom: Number(e.target.value) })} className="flex-1 accent-gold" />
                        <span className="w-[3rem] text-right font-display text-[0.8rem]">{shown.zoom.toFixed(2)}×</span>
                    </div>
                    <div className="mt-[0.9rem] flex flex-wrap items-center gap-[0.5rem]">
                        <span className="w-[4.5rem] text-[0.72rem] text-faint">Move view</span>
                        <button type="button" className={btn} onClick={() => nudge({ cy: shown.cy - 0.02 })}>Up</button>
                        <button type="button" className={btn} onClick={() => nudge({ cy: shown.cy + 0.02 })}>Down</button>
                        <button type="button" className={btn} onClick={() => nudge({ cx: shown.cx - 0.02 })}>Left</button>
                        <button type="button" className={btn} onClick={() => nudge({ cx: shown.cx + 0.02 })}>Right</button>
                    </div>
                    <div className="mt-[0.9rem] flex flex-wrap gap-[0.5rem]">
                        <button type="button" className={`${btn} ${showFull ? 'bg-gold text-obsidian border-gold' : ''}`} onClick={() => setShowFull((v) => !v)}>
                            {showFull ? 'Showing whole picture' : 'Show whole picture'}
                        </button>
                        <button type="button" className={`${btn} bg-fg text-bg`} onClick={() => saveFraming(shown)}>Save framing</button>
                        <button type="button" className={btn} onClick={() => saveFraming(null)}>Reset</button>
                    </div>
                </section>

                {/* 4. Touch */}
                <section className={section}>
                    <h2 className={h2}>4 · Touch</h2>
                    <p className="mt-[0.4rem] text-[0.72rem] text-muted">Put fingers down. Dots should land under them.</p>
                    <div onTouchStart={onTouch} onTouchMove={onTouch} onTouchEnd={onTouch}
                        className="relative mt-[1rem] h-[14rem] touch-none overflow-hidden rounded-[0.6rem] border-[0.06rem] border-dashed border-line">
                        {touches.map((t) => (
                            <span key={t.id} className="absolute h-[2rem] w-[2rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-gold/80" style={{ left: t.x, top: t.y }} />
                        ))}
                        <span className="absolute bottom-[0.6rem] right-[0.8rem] text-[0.65rem] text-faint">
                            {touches.length} now · {maxTouches} max
                        </span>
                    </div>
                </section>

                {/* 5. Readout */}
                <section className={section}>
                    <h2 className={h2}>5 · This screen</h2>
                    <dl className="mt-[0.8rem] grid grid-cols-[auto_1fr] gap-x-[1rem] gap-y-[0.4rem] text-[0.68rem]">
                        {Object.entries(info).map(([k, v]) => (
                            <div key={k} className="contents">
                                <dt className="text-faint">{k}</dt>
                                <dd className="break-all">{v}</dd>
                            </div>
                        ))}
                    </dl>
                    <p className="mt-[0.8rem] text-[0.65rem] text-faint">A Luma should report about 2160 × 3840 effective pixels in portrait.</p>
                </section>
            </div>
        </div>
    );
}
