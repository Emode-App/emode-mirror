import type { Viewport } from 'next';

// A public touchscreen: no pinch-zoom, no text selection, no double-tap delay.
// (Proto can also disable zoom at submission; this covers the launcher.)
export const viewport: Viewport = {
    width: 'device-width',
    initialScale: 1,
    maximumScale: 1,
    userScalable: false,
    // Lets the page read the iPad's home-bar inset (env(safe-area-inset-*)); a Luma has none.
    viewportFit: 'cover',
};

/**
 * Everything in the kiosk is sized in rem, and 1rem is one fortieth of the
 * 9:16 frame's width -- 54px on a Luma's 2160x3840 panel, proportionally less
 * in a desktop window. So a layout checked on a laptop is the layout the Luma
 * shows, just bigger. Scoped to this route group so the phone pages keep a
 * normal 16px.
 *
 * --kiosk-h is the height the frame may use. In Safari on an iPad, 100vh is
 * taller than what is visible under the toolbar, and the home bar sits over
 * the bottom edge, so there it is the visible height (dvh) less the safe
 * areas. Browsers without dvh -- and the Luma, which has no toolbar or home
 * bar -- keep 100vh, so the frame there is exactly what it was.
 */
const KIOSK_CSS = `
:root { --kiosk-h: 100vh; }
@supports (height: 100dvh) {
  :root { --kiosk-h: calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px)); }
  .kiosk-stage { padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }
}
html { font-size: min(2.5vw, calc(var(--kiosk-h) * 0.0140625)); }
.kiosk-frame { width: min(100vw, calc(var(--kiosk-h) * 0.5625)); height: min(var(--kiosk-h), 177.78vw); }
body { overflow: hidden; overscroll-behavior: none; touch-action: manipulation;
       -webkit-user-select: none; user-select: none; -webkit-tap-highlight-color: transparent; }
`;

export default function KioskLayout({ children }: { children: React.ReactNode }) {
    return (
        <>
            <style>{KIOSK_CSS}</style>
            {children}
        </>
    );
}
