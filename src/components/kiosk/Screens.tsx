'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Category, Garment, Look } from '@/lib/api';
import { Qr } from '@/components/Qr';
import { Wordmark } from '@/components/Wordmark';
import { Bloom, Eyebrow, KioskButton, Title } from './ui';

// The frame is 40rem wide and ~71rem tall. Decoration lives in the top third,
// out of reach on a life-size panel; everything a visitor touches sits in the
// band an adult can reach without stretching.

export function Unregistered({ message }: { message: string }) {
    return (
        <div className="flex h-full flex-col items-center justify-center gap-[1.6rem] px-[4rem] text-center">
            <Wordmark className="text-[3rem]" />
            <p className="mt-[2rem] font-display text-[1.5rem] font-semibold">{message}</p>
            <p className="text-[0.85rem] text-muted">
                Launch this screen with its device link, or open <span className="font-mono">/calibrate</span> to check the hardware.
            </p>
        </div>
    );
}

export function Attract({ location, onStart }: { location: string | null; onStart: () => void }) {
    return (
        <button type="button" onClick={onStart} className="relative flex h-full w-full flex-col items-center text-center">
            <Bloom className="top-[42%]" />
            <Wordmark className="relative mt-[7rem] text-[3.6rem]" />

            <div className="relative mt-auto flex flex-col items-center gap-[1.2rem] px-[3rem]">
                <Eyebrow>A mirror that dresses you</Eyebrow>
                <Title className="text-[3.6rem]">Try on<br />anything.</Title>
                <p className="max-w-[28rem] text-[1.05rem] leading-[1.45] text-muted">
                    Send clothes from your phone. See them on you, right here.
                </p>
            </div>

            <div className="relative mb-[9rem] mt-[5rem] flex flex-col items-center gap-[0.8rem]">
                <span className="grid h-[4.2rem] w-[4.2rem] place-items-center rounded-full border-[0.08rem] border-line animate-soft-pulse">
                    <span className="h-[1.1rem] w-[1.1rem] rounded-full bg-gold" />
                </span>
                <span className="font-display text-[1.05rem] font-medium tracking-[0.02em]">Touch to begin</span>
            </div>

            {location && <span className="absolute bottom-[2.4rem] text-[0.6rem] uppercase tracking-[0.3em] text-faint">{location}</span>}
        </button>
    );
}

export function Consent({ busy, onAccept, onDecline }: { busy: boolean; onAccept: () => void; onDecline: () => void }) {
    const points = [
        ['One photo', 'The mirror takes a single photo of you to dress you in the clothes you choose.'],
        ['Deleted when you finish', 'Your photo is erased the moment you tap Finish, or if you walk away.'],
        ['Yours for an hour', 'Your looks wait on your phone for an hour so you can save them, then they’re deleted too.'],
        ['Made with AI', 'Your photo and clothes are sent to an AI image service to create each look.'],
    ];
    return (
        <div className="flex h-full flex-col px-[3.4rem] pt-[8rem]">
            <Eyebrow>Before we begin</Eyebrow>
            <Title className="mt-[0.8rem]">One photo.<br />Then it&apos;s gone.</Title>

            <ul className="mt-[3rem] flex flex-col gap-[1.6rem]">
                {points.map(([head, body], i) => (
                    <li key={head} className="flex gap-[1.1rem] animate-rise" style={{ animationDelay: `${120 * i}ms` }}>
                        <span className="mt-[0.15rem] grid h-[1.8rem] w-[1.8rem] shrink-0 place-items-center rounded-full border-[0.06rem] border-gold/60 font-display text-[0.75rem] text-gold">
                            {i + 1}
                        </span>
                        <div>
                            <p className="font-display text-[1.15rem] font-semibold">{head}</p>
                            <p className="mt-[0.2rem] text-[0.88rem] leading-[1.45] text-muted">{body}</p>
                        </div>
                    </li>
                ))}
            </ul>

            <div className="mt-auto mb-[9rem] flex flex-col items-center gap-[0.9rem]">
                <KioskButton disabled={busy} onClick={onAccept}>
                    {busy ? 'Starting…' : 'I’m 18 or over — let’s go'}
                </KioskButton>
                <KioskButton tone="ghost" onClick={onDecline}>Not now</KioskButton>
            </div>
        </div>
    );
}

export function GarmentTile({
    garment,
    selectedIndex,
    onToggle,
    size = 'md',
}: {
    garment: Garment;
    selectedIndex?: number;
    onToggle?: () => void;
    size?: 'sm' | 'md';
}) {
    const selected = selectedIndex !== undefined && selectedIndex >= 0;
    const Tag = onToggle ? 'button' : 'div';
    return (
        <Tag
            {...(onToggle ? { type: 'button', onClick: onToggle } : {})}
            className={`group relative flex flex-col overflow-hidden rounded-[0.8rem] bg-surface text-left transition
                ${selected ? 'ring-[0.14rem] ring-gold' : 'ring-[0.06rem] ring-line'} ${onToggle ? 'active:scale-[0.97]' : ''}`}
        >
            <div className={`relative w-full ${size === 'sm' ? 'aspect-square' : 'aspect-[3/4]'} bg-white`}>
                {garment.imageUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={garment.imageUrl} alt={garment.title || 'Clothing'} className="absolute inset-0 h-full w-full object-contain p-[0.4rem]" />
                )}
                {selected && (
                    <span className="absolute right-[0.4rem] top-[0.4rem] grid h-[1.5rem] w-[1.5rem] place-items-center rounded-full bg-gold font-display text-[0.75rem] font-bold text-obsidian">
                        {selectedIndex! + 1}
                    </span>
                )}
            </div>
            {size === 'md' && (
                <span className="truncate px-[0.6rem] py-[0.45rem] text-[0.62rem] text-muted">
                    {garment.title || (garment.source === 'link' ? 'From a link' : 'Screenshot')}
                </span>
            )}
        </Tag>
    );
}

/** Says a wardrobe is connected without saying whose -- this is a public screen. */
function LinkedNote() {
    return (
        <p className="inline-flex items-center gap-[0.5rem] rounded-full border-[0.06rem] border-gold/50 px-[0.9rem] py-[0.35rem] text-[0.7rem] text-gold">
            <span className="h-[0.45rem] w-[0.45rem] rounded-full bg-gold" />
            Emode wardrobe connected
        </p>
    );
}

export function Pair({
    phoneUrl,
    garments,
    linked,
    onContinue,
    onCancel,
}: {
    phoneUrl: string;
    garments: Garment[];
    linked: boolean;
    onContinue: () => void;
    onCancel: () => void;
}) {
    return (
        <div className="flex h-full flex-col items-center px-[3rem] pt-[6.5rem] text-center">
            <Eyebrow>Step one</Eyebrow>
            <Title className="mt-[0.8rem]">Bring your clothes.</Title>
            <p className="mt-[1rem] max-w-[28rem] text-[1rem] leading-[1.45] text-muted">
                Scan with your phone&apos;s camera, then send screenshots or product links — or pieces from your Emode wardrobe.
            </p>

            <Qr value={phoneUrl} className="mt-[2.4rem] w-[15rem]" />
            {linked && <div className="mt-[1.2rem]"><LinkedNote /></div>}

            <div className="mt-[2.4rem] w-full">
                {garments.length === 0 ? (
                    <p className="text-[0.95rem] text-faint animate-soft-pulse">Waiting for your first piece…</p>
                ) : (
                    <>
                        <p className="mb-[0.9rem] font-display text-[0.95rem] font-medium">
                            {garments.length} {garments.length === 1 ? 'piece' : 'pieces'} added
                        </p>
                        <div className="flex justify-center gap-[0.7rem]">
                            {garments.slice(-5).map((g) => (
                                <div key={g.id} className="w-[5.2rem] animate-rise">
                                    <GarmentTile garment={g} size="sm" />
                                </div>
                            ))}
                        </div>
                    </>
                )}
            </div>

            <div className="mt-auto mb-[8rem] flex flex-col items-center gap-[0.9rem]">
                <KioskButton disabled={garments.length === 0} onClick={onContinue}>Continue</KioskButton>
                <KioskButton tone="ghost" onClick={onCancel}>Cancel</KioskButton>
            </div>
        </div>
    );
}

const CATEGORY_LABELS: Record<Category, string> = {
    tops: 'Tops',
    outerwear: 'Outerwear',
    bottoms: 'Bottoms',
    shoes: 'Shoes',
    accessories: 'Accessories',
    other: 'Other',
};
const CATEGORY_ORDER: Category[] = ['tops', 'outerwear', 'bottoms', 'shoes', 'accessories', 'other'];

export function Wardrobe({
    garments,
    selected,
    maxPieces,
    hasPhoto,
    hasLooks,
    linked,
    phoneUrl,
    error,
    onToggle,
    onTryOn,
    onNewPhoto,
    onBackToLooks,
    onFinish,
}: {
    garments: Garment[];
    selected: string[];
    maxPieces: number;
    hasPhoto: boolean;
    hasLooks: boolean;
    linked: boolean;
    phoneUrl: string;
    error: string | null;
    onToggle: (id: string) => void;
    onTryOn: () => void;
    onNewPhoto: () => void;
    onBackToLooks: () => void;
    onFinish: () => void;
}) {
    // Grouped the way the app's wardrobe already is. Tabs only appear once
    // there is more than one kind of thing to choose between; a piece that has
    // not been classified yet counts as Other until it is.
    const [tab, setTab] = useState<Category | 'all'>('all');
    const counts = useMemo(() => {
        const c = new Map<Category, number>();
        for (const g of garments) c.set(g.category ?? 'other', (c.get(g.category ?? 'other') ?? 0) + 1);
        return c;
    }, [garments]);
    const tabs = CATEGORY_ORDER.filter((c) => counts.get(c));
    const showTabs = tabs.length > 1;
    const shown = tab === 'all' || !showTabs ? garments : garments.filter((g) => (g.category ?? 'other') === tab);
    useEffect(() => {
        if (tab !== 'all' && !counts.get(tab)) setTab('all');
    }, [tab, counts]);

    return (
        <div className="flex h-full flex-col px-[2.6rem] pt-[5rem]">
            <div className="flex items-end justify-between gap-[1rem]">
                <div>
                    <Eyebrow>Step two</Eyebrow>
                    <Title className="mt-[0.7rem] text-[2.3rem]">Build your outfit.</Title>
                    <p className="mt-[0.6rem] text-[0.92rem] text-muted">
                        Tap what you want to wear — up to {maxPieces}.
                    </p>
                </div>
                <div className="flex shrink-0 flex-col items-center gap-[0.4rem]">
                    <Qr value={phoneUrl} className="w-[5.6rem] p-[0.4rem]" />
                    <span className="text-[0.55rem] uppercase tracking-[0.2em] text-faint">Add more</span>
                </div>
            </div>

            {(linked || showTabs) && (
                <div className="mt-[1.4rem] flex flex-col gap-[0.9rem]">
                    {linked && <LinkedNote />}
                    {showTabs && (
                        <div className="flex gap-[0.5rem] overflow-x-auto pb-[0.2rem]">
                            {(['all', ...tabs] as const).map((c) => (
                                <button key={c} type="button" onClick={() => setTab(c)}
                                    className={`shrink-0 rounded-full px-[1rem] py-[0.5rem] font-display text-[0.75rem] font-semibold transition
                                        ${tab === c ? 'bg-fg text-bg' : 'border-[0.06rem] border-line text-muted'}`}>
                                    {c === 'all' ? `All ${garments.length}` : `${CATEGORY_LABELS[c]} ${counts.get(c)}`}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            )}

            <div className="mt-[1.4rem] grid min-h-0 flex-1 auto-rows-min grid-cols-3 gap-[0.9rem] overflow-y-auto pb-[1rem]">
                {shown.map((g) => (
                    <GarmentTile key={g.id} garment={g} selectedIndex={selected.indexOf(g.id)} onToggle={() => onToggle(g.id)} />
                ))}
            </div>

            {error && <p className="mb-[0.8rem] rounded-[0.6rem] bg-surface px-[1rem] py-[0.7rem] text-center text-[0.85rem]">{error}</p>}

            <div className="mb-[5.5rem] mt-[1rem] flex flex-col items-center gap-[0.8rem]">
                <KioskButton disabled={selected.length === 0} onClick={onTryOn}>
                    {selected.length === 0 ? 'Choose a piece' : `Try it on${selected.length > 1 ? ` · ${selected.length} pieces` : ''}`}
                </KioskButton>
                <div className="flex gap-[0.6rem]">
                    {hasPhoto && <KioskButton tone="secondary" className="min-w-[11rem]" onClick={onNewPhoto}>New photo</KioskButton>}
                    {hasLooks && <KioskButton tone="secondary" className="min-w-[11rem]" onClick={onBackToLooks}>My looks</KioskButton>}
                    <KioskButton tone="ghost" className="min-w-[8rem]" onClick={onFinish}>Finish</KioskButton>
                </div>
            </div>
        </div>
    );
}

const STYLING_LINES = ['Reading the fabric…', 'Matching your fit…', 'Getting the drape right…', 'Lighting the look…', 'Almost there…'];

export function Generating({
    photo,
    pieces,
    failure,
    onRetry,
    onChangeOutfit,
}: {
    photo: string | null;
    pieces: Garment[];
    failure: string | null;
    onRetry: () => void;
    onChangeOutfit: () => void;
}) {
    const [line, setLine] = useState(0);
    useEffect(() => {
        if (failure) return;
        const t = setInterval(() => setLine((n) => Math.min(n + 1, STYLING_LINES.length - 1)), 5000);
        return () => clearInterval(t);
    }, [failure]);

    return (
        <div className="relative h-full overflow-hidden">
            {photo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photo} alt="" className="absolute inset-0 h-full w-full object-cover opacity-35 blur-[0.15rem]" />
            ) : (
                <Bloom />
            )}
            {!failure && (
                <div className="pointer-events-none absolute inset-x-0 top-0 h-[8rem] bg-gradient-to-b from-transparent via-[var(--glow)] to-transparent" style={{ animation: 'mirror-scan 3.2s linear infinite' }} />
            )}

            <div className="relative flex h-full flex-col items-center justify-center px-[3rem] text-center">
                {failure ? (
                    <>
                        <Title className="text-[2.2rem]">That one didn&apos;t work.</Title>
                        <p className="mt-[1rem] max-w-[28rem] text-[1rem] text-muted">{failure}</p>
                        <div className="mt-[3rem] flex flex-col items-center gap-[0.9rem]">
                            <KioskButton onClick={onRetry}>Try again</KioskButton>
                            <KioskButton tone="secondary" onClick={onChangeOutfit}>Change outfit</KioskButton>
                        </div>
                    </>
                ) : (
                    <>
                        <div className="flex gap-[0.7rem]">
                            {pieces.map((g, i) => (
                                <div key={g.id} className="w-[5rem] animate-rise" style={{ animationDelay: `${i * 150}ms` }}>
                                    <GarmentTile garment={g} size="sm" />
                                </div>
                            ))}
                        </div>
                        <Title className="mt-[3rem] text-[2.6rem]">Styling you.</Title>
                        <p key={line} className="mt-[1rem] text-[1.05rem] text-muted animate-rise">{STYLING_LINES[line]}</p>
                        <p className="mt-[4rem] text-[0.75rem] text-faint">Usually 20–40 seconds.</p>
                    </>
                )}
            </div>
        </div>
    );
}

export function Result({
    look,
    looks,
    pieces,
    onSelectLook,
    onChangeOutfit,
    onNewPhoto,
    onFinish,
}: {
    look: Look;
    looks: Look[];
    pieces: Garment[];
    onSelectLook: (id: string) => void;
    onChangeOutfit: () => void;
    onNewPhoto: () => void;
    onFinish: () => void;
}) {
    const done = looks.filter((l) => l.status === 'succeeded' && l.imageUrl);
    const number = done.findIndex((l) => l.id === look.id) + 1;

    return (
        <div className="relative flex h-full flex-col">
            <div className="relative flex-1">
                {/* A shadow on the floor under the figure: the cue that makes a
                    person on a Proto read as standing inside it. */}
                <div aria-hidden className="absolute bottom-[1.5rem] left-1/2 h-[2.4rem] w-[24rem] -translate-x-1/2 rounded-[50%] blur-[1.2rem]" style={{ background: 'radial-gradient(ellipse, var(--glow), transparent 70%)' }} />
                {look.imageUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={look.imageUrl} alt="Your look" className="absolute inset-0 h-full w-full object-contain animate-rise" />
                )}
                <div className="absolute left-[2.4rem] top-[3rem]">
                    <Eyebrow>Look {number || done.length}</Eyebrow>
                </div>
            </div>

            <div className="relative bg-gradient-to-t from-[var(--bg)] via-[var(--bg)] to-transparent px-[2.6rem] pb-[4.5rem] pt-[2rem]">
                {done.length > 1 && (
                    <div className="mb-[1.2rem] flex justify-center gap-[0.5rem]">
                        {done.map((l) => (
                            <button key={l.id} type="button" onClick={() => onSelectLook(l.id)}
                                className={`h-[4.6rem] w-[2.6rem] overflow-hidden rounded-[0.4rem] ${l.id === look.id ? 'ring-[0.12rem] ring-gold' : 'opacity-60 ring-[0.06rem] ring-line'}`}>
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={l.imageUrl!} alt="" className="h-full w-full object-cover" />
                            </button>
                        ))}
                    </div>
                )}

                <div className="mb-[1.4rem] flex justify-center gap-[0.5rem]">
                    {pieces.map((g) => (
                        <div key={g.id} className="w-[3.6rem]"><GarmentTile garment={g} size="sm" /></div>
                    ))}
                </div>

                <div className="flex flex-col items-center gap-[0.8rem]">
                    <div className="flex gap-[0.6rem]">
                        <KioskButton tone="secondary" className="min-w-[13rem]" onClick={onChangeOutfit}>Change outfit</KioskButton>
                        <KioskButton tone="secondary" className="min-w-[13rem]" onClick={onNewPhoto}>New photo</KioskButton>
                    </div>
                    <KioskButton onClick={onFinish}>Finish</KioskButton>
                    <p className="text-[0.7rem] text-faint">Your looks are waiting on your phone.</p>
                </div>
            </div>
        </div>
    );
}

export function Ending({ phoneUrl, retainUntil, onDone }: { phoneUrl: string | null; retainUntil: string | null; onDone: () => void }) {
    const [left, setLeft] = useState(20);
    useEffect(() => {
        if (left <= 0) {
            onDone();
            return;
        }
        const t = setTimeout(() => setLeft((n) => n - 1), 1000);
        return () => clearTimeout(t);
    }, [left, onDone]);

    const until = retainUntil
        ? new Date(retainUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : null;

    return (
        <div className="relative flex h-full flex-col items-center px-[3rem] pt-[9rem] text-center">
            <Bloom className="top-[38%]" />
            <Wordmark className="relative text-[2.6rem]" />
            <Title className="relative mt-[4rem]">Thanks for<br />trying it on.</Title>
            <p className="relative mt-[1.4rem] max-w-[28rem] text-[1rem] leading-[1.5] text-muted">
                Your photo has been deleted. Your looks are on your phone{until ? ` until ${until}` : ' for the next hour'} — save the ones you love.
            </p>
            {phoneUrl && (
                <div className="relative mt-[2.6rem] flex flex-col items-center gap-[0.6rem]">
                    <Qr value={phoneUrl} className="w-[8rem] p-[0.5rem]" />
                    <span className="text-[0.6rem] uppercase tracking-[0.22em] text-faint">Lost the page? Scan again</span>
                </div>
            )}
            <div className="relative mt-auto mb-[8rem] flex flex-col items-center gap-[0.6rem]">
                <KioskButton tone="secondary" onClick={onDone}>Done</KioskButton>
                <span className="text-[0.7rem] text-faint">Resetting in {left}s</span>
            </div>
        </div>
    );
}

export function StillThere({ secondsLeft, onStay }: { secondsLeft: number; onStay: () => void }) {
    return (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center px-[3rem] text-center backdrop-blur-[0.4rem]"
            style={{ background: 'color-mix(in srgb, var(--bg) 92%, transparent)' }}>
            <Title>Still there?</Title>
            <p className="mt-[1.2rem] max-w-[26rem] text-[1rem] text-muted">
                We&apos;ll end this visit and delete your photo in {secondsLeft} seconds.
            </p>
            <KioskButton className="mt-[3rem]" onClick={onStay}>I&apos;m still here</KioskButton>
        </div>
    );
}
