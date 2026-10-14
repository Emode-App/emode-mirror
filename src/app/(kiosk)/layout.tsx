import type { Viewport } from 'next';

// A public touchscreen: no pinch-zoom, no text selection, no double-tap delay.
// (Proto can also disable zoom at submission; this covers the launcher.)
export const viewport: Viewport = {
    width: 'device-width',
    initialScale: 1,
    maximumScale: 1,
    userScalable: false,
};

/**
 * Everything in the kiosk is sized in rem, and 1rem is one fortieth of the
 * 9:16 frame's width -- 54px on a Luma's 2160x3840 panel, proportionally less
 * in a desktop window. So a layout checked on a laptop is the layout the Luma
 * shows, just bigger. Scoped to this route group so the phone pages keep a
 * normal 16px.
 */
const KIOSK_CSS = `
html { font-size: min(2.5vw, 1.40625vh); }
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
