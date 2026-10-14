'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Tone = 'primary' | 'secondary' | 'ghost' | 'light' | 'ghost-light';

const TONES: Record<Tone, string> = {
    primary: 'bg-fg text-bg shadow-[0_0.5rem_2.5rem_var(--glow)]',
    secondary: 'bg-surface text-fg border-[0.06rem] border-line',
    ghost: 'text-muted',
    light: 'bg-white text-obsidian shadow-[0_0.4rem_2rem_rgba(0,0,0,0.35)]',
    'ghost-light': 'text-white/85',
};

/**
 * Sized for a life-size touchscreen: about 7cm tall on a Luma, wide enough to
 * hit without looking, and never at the very top or bottom of the panel where
 * an adult cannot comfortably reach.
 */
export function KioskButton({
    tone = 'primary',
    className = '',
    children,
    ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone }) {
    return (
        <button
            type="button"
            className={`inline-flex min-h-[2.7rem] min-w-[18rem] items-center justify-center gap-[0.5rem] rounded-full px-[2.2rem]
                font-display text-[1.05rem] font-semibold tracking-[-0.01em] transition
                active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100 ${TONES[tone]} ${className}`}
            {...rest}
        >
            {children}
        </button>
    );
}

export function Eyebrow({ children }: { children: ReactNode }) {
    return (
        <p className="font-display text-[0.62rem] font-semibold uppercase tracking-[0.38em] text-gold">{children}</p>
    );
}

export function Title({ children, className = '' }: { children: ReactNode; className?: string }) {
    return (
        <h1 className={`font-display text-[2.6rem] font-semibold leading-[1.02] tracking-[-0.035em] ${className}`}>
            {children}
        </h1>
    );
}

/** A soft gold bloom behind content, so it reads as standing in the space. */
export function Bloom({ className = '' }: { className?: string }) {
    return (
        <div
            aria-hidden
            className={`pointer-events-none absolute left-1/2 top-1/2 h-[30rem] w-[30rem] rounded-full blur-[4rem] ${className}`}
            style={{ background: 'radial-gradient(circle, var(--glow), transparent 65%)', animation: 'mirror-breathe 7s ease-in-out infinite' }}
        />
    );
}
