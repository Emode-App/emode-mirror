// Live try-on: the shopper sees themselves dressed in the camera's live video
// (Decart's Lucy virtual try-on, over WebRTC). The model takes ONE reference
// photo plus a text instruction, so an outfit of several pieces becomes one
// flat-lay picture of all of them, and a sentence describing each.

import type { Category } from './api';

export const LIVE_MODEL = 'lucy-vton-latest';
/**
 * How long one live try-on lasts before it stops on its own. Live is billed
 * by the second, so each try-on is a short look, not a session.
 */
export const LIVE_SECONDS = 15;

export interface LivePiece {
    /** Stable identity within an outfit: a garment id, or "p:" + a rack item id. */
    key: string;
    /** Already a piece of the visit. */
    garmentId?: string;
    /** A rack item not yet added to the visit. */
    productId?: string;
    name: string | null;
    description: string | null;
    category: Category | null;
    imageUrl: string | null;
}

// Where a piece sits on the body, top to bottom: the order of the flat-lay,
// and the order the sentence lists them in.
const BODY_ORDER: Category[] = ['outerwear', 'suits', 'dresses', 'tops', 'bottoms', 'shoes', 'accessories', 'other'];
// How much of the flat-lay's height each kind of piece gets.
const HEIGHT: Record<Category, number> = {
    suits: 0.8, dresses: 0.8, outerwear: 0.45, tops: 0.42, bottoms: 0.45, shoes: 0.2, accessories: 0.18, other: 0.35,
};
// What each kind of piece occupies, so a new one replaces what it covers.
const SLOTS: Record<Category, string[]> = {
    suits: ['top', 'bottom', 'outer'], dresses: ['top', 'bottom'], outerwear: ['outer'], tops: ['top'],
    bottoms: ['bottom'], shoes: ['feet'], accessories: [], other: [],
};
// What to call a piece when nothing better is known yet.
const NOUN: Record<Category, string> = {
    suits: 'the suit', dresses: 'the dress', outerwear: 'the jacket', tops: 'the top', bottoms: 'the trousers or skirt',
    shoes: 'the shoes', accessories: 'the accessory', other: 'the garment',
};
// Decart's prompting guide: "substitute" what a single piece replaces.
const SUBSTITUTE: Partial<Record<Category, string>> = {
    suits: 'Substitute the outfit with',
    dresses: 'Substitute the outfit with',
    tops: 'Substitute the current top with',
    outerwear: 'Substitute the current top layer with',
    bottoms: 'Substitute the lower body garment with',
    shoes: 'Substitute the footwear with',
};

const cat = (p: LivePiece): Category => p.category ?? 'other';
const byBody = (pieces: LivePiece[]) => [...pieces].sort((a, b) => BODY_ORDER.indexOf(cat(a)) - BODY_ORDER.indexOf(cat(b)));
const words = (p: LivePiece) => (p.description || p.name || NOUN[cat(p)]).trim().replace(/[.\s]+$/, '');

/**
 * Put a piece on: it replaces whatever it covers (new shoes replace the
 * shoes, a suit replaces the top and the trousers), and tapping a piece
 * already worn takes it off -- as long as something is left on.
 */
export function wearPiece(outfit: LivePiece[], piece: LivePiece): LivePiece[] {
    // The same rack item, whether already added to the visit or not.
    const same = (a: LivePiece) => a.key === piece.key || (!!piece.productId && a.productId === piece.productId);
    if (outfit.some(same)) {
        return outfit.length > 1 ? outfit.filter((p) => !same(p)) : outfit;
    }
    const covers = SLOTS[cat(piece)];
    return [...outfit.filter((p) => !SLOTS[cat(p)].some((s) => covers.includes(s))), piece];
}

/** The instruction for an outfit of one or more pieces. */
export function livePrompt(pieces: LivePiece[]): string {
    const sorted = byBody(pieces);
    const lead = sorted[0];
    if (!lead) return 'Keep the outfit as it is.';
    let prompt: string;
    if (sorted.length === 1) {
        prompt = cat(lead) === 'accessories'
            ? `Add ${words(lead)} to the outfit.`
            : `${SUBSTITUTE[cat(lead)] ?? 'Substitute the outfit with'} ${words(lead)}.`;
    } else {
        const list = sorted.map(words);
        const last = list.pop();
        prompt = `Substitute the outfit with the clothes in the reference image, worn together: ${list.join(', ')} and ${last}.`;
    }
    // The model refuses prompts past about 750 characters.
    return prompt.slice(0, 700);
}

function loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`image failed: ${url}`));
        img.src = url;
    });
}

/**
 * One reference picture for the whole outfit: the pieces laid out top to
 * bottom on white, the way they'd be worn. A single piece is sent as it is.
 * If a photo can't be drawn (a store whose images refuse cross-origin use),
 * it falls back to the main piece's own photo.
 */
async function outfitImage(pieces: LivePiece[]): Promise<Blob | string | null> {
    const sorted = byBody(pieces).filter((p) => p.imageUrl);
    if (sorted.length <= 1) return sorted[0]?.imageUrl ?? null;
    try {
        const images = await Promise.all(sorted.map((p) => loadImage(p.imageUrl!)));
        const W = 768;
        const H = 1152;
        const pad = 24;
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, W, H);
        const total = sorted.reduce((n, p) => n + HEIGHT[cat(p)], 0);
        let y = pad;
        sorted.forEach((p, i) => {
            const slotH = ((H - pad * (sorted.length + 1)) * HEIGHT[cat(p)]) / total;
            const img = images[i];
            const scale = Math.min((W - pad * 2) / img.width, slotH / img.height);
            const w = img.width * scale;
            const h = img.height * scale;
            ctx.drawImage(img, (W - w) / 2, y + (slotH - h) / 2, w, h);
            y += slotH + pad;
        });
        return await new Promise<Blob | string | null>((resolve) =>
            canvas.toBlob((b) => resolve(b ?? sorted[0].imageUrl), 'image/jpeg', 0.9));
    } catch (e) {
        console.warn('outfit image fell back to one piece', e);
        return byBody(pieces)[0]?.imageUrl ?? null;
    }
}

/** Everything the model needs to dress someone in an outfit. */
export async function liveInput(pieces: LivePiece[]): Promise<{ prompt: string; image: Blob | string | null }> {
    return { prompt: livePrompt(pieces), image: await outfitImage(pieces) };
}
