// Live try-on: the shopper sees themselves dressed in the camera's live video
// (Decart's Lucy virtual try-on, over WebRTC). The model works from one
// reference photo plus a text instruction, so an outfit becomes the photo of
// its main piece and a sentence describing all of it.

import type { Category } from './api';

export const LIVE_MODEL = 'lucy-vton-latest';
/** How long one live stretch lasts before it stops on its own (cost cap). */
export const LIVE_SECONDS = 120;

export interface LivePiece {
    name: string | null;
    description: string | null;
    category: Category | null;
    imageUrl: string | null;
}

// Which piece's photo leads: the one that covers the most of the person.
const LEAD: Category[] = ['suits', 'dresses', 'outerwear', 'tops', 'bottoms', 'shoes', 'accessories', 'other'];

// Decart's prompting guide: "substitute" what the piece replaces.
const SUBSTITUTE: Partial<Record<Category, string>> = {
    suits: 'Substitute the outfit with',
    dresses: 'Substitute the outfit with',
    tops: 'Substitute the current top with',
    outerwear: 'Substitute the current top layer with',
    bottoms: 'Substitute the lower body garment with',
    shoes: 'Substitute the footwear with',
};

function words(p: LivePiece) {
    return (p.description || p.name || 'the garment in the reference image').trim().replace(/[.\s]+$/, '');
}

/** The instruction and reference photo for an outfit of one or more pieces. */
export function liveOutfit(pieces: LivePiece[]): { prompt: string; image: string | null } {
    const sorted = [...pieces].sort((a, b) => LEAD.indexOf(a.category ?? 'other') - LEAD.indexOf(b.category ?? 'other'));
    const lead = sorted[0];
    if (!lead) return { prompt: 'Keep the outfit as it is.', image: null };
    let prompt: string;
    if (sorted.length === 1) {
        prompt = lead.category === 'accessories'
            ? `Add ${words(lead)} to the outfit.`
            : `${SUBSTITUTE[lead.category ?? 'other'] ?? 'Substitute the outfit with'} ${words(lead)}.`;
    } else {
        const list = sorted.map(words);
        const last = list.pop();
        prompt = `Substitute the outfit with ${list.join(', ')} and ${last}.`;
    }
    // The model refuses prompts past about 750 characters.
    return { prompt: prompt.slice(0, 700), image: lead.imageUrl };
}
