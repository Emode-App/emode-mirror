'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/**
 * A QR code for a URL, always dark modules on white.
 *
 * Inverted codes look better on a black kiosk but plenty of phone cameras will
 * not read them, and a code nobody can scan is decoration. The white card is
 * the price of it working first time.
 */
export function Qr({ value, className = '' }: { value: string; className?: string }) {
    const [svg, setSvg] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        QRCode.toString(value, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#0a0a0a', light: '#ffffff' } })
            .then((s) => { if (!cancelled) setSvg(s); })
            .catch(() => { if (!cancelled) setSvg(null); });
        return () => { cancelled = true; };
    }, [value]);

    return (
        <div className={`rounded-[0.6rem] bg-white p-[0.9rem] shadow-[0_0.4rem_2rem_var(--glow)] ${className}`}>
            {svg ? (
                <div className="aspect-square w-full [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: svg }} />
            ) : (
                <div className="aspect-square w-full animate-pulse rounded bg-neutral-200" />
            )}
        </div>
    );
}
