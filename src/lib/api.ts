// Client for the `mirror` edge function, shared by the kiosk and the phone.
//
// The values below are public by design: the anon key only gets a request to
// the function's front door. What a caller may actually do is decided there,
// by the device key (kiosk) or the session token (phone).

const API_URL = process.env.NEXT_PUBLIC_MIRROR_API_URL
    ?? 'https://scvvbjheyfnxlsiiozta.supabase.co/functions/v1/mirror';
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    ?? 'sb_publishable_xBWtFjEoKrG4wCSzGVkigw_A-i0UfJi';

export type Theme = 'dark' | 'light';

import type { Framing } from './camera';

export type Category = 'suits' | 'tops' | 'outerwear' | 'bottoms' | 'dresses' | 'shoes' | 'accessories' | 'other';

export interface Garment {
    id: string;
    source: 'upload' | 'link' | 'wardrobe' | 'catalog';
    /** For pieces from a store's rack: the rack item they came from. */
    productId: string | null;
    /** Filled in a few seconds after an upload or link, by a classifier; immediate for wardrobe pieces. */
    category: Category | null;
    title: string | null;
    productUrl: string | null;
    imageUrl: string | null;
}

export interface Look {
    id: string;
    status: 'pending' | 'succeeded' | 'failed';
    error: string | null;
    garmentIds: string[];
    imageUrl: string | null;
    createdAt: string;
}

export interface SessionState {
    id: string;
    status: 'active' | 'ended';
    hasPhoto: boolean;
    /** An Emode account has claimed this visit from the app. Never says whose. */
    linked: boolean;
    /** A phone has scanned this visit's code, so it can work as the camera button. */
    phonePaired: boolean;
    /** The mirror's camera is waiting for the photo; the phone may press the button. */
    cameraOpen: boolean;
    endedAt: string | null;
    retainUntil: string | null;
    garments: Garment[];
    looks: Look[];
}

export interface PhoneState extends SessionState {
    device: { name: string | null; location: string | null };
    limits: { garmentsPerSession: number };
}

export interface StoreInfo {
    name: string;
    logoUrl: string | null;
    /** The store's Emode Business account has live listings to try on. */
    hasRack: boolean;
}

export interface DeviceHello {
    device: { name: string; location: string | null; theme: Theme };
    /** The store this mirror belongs to, if any. Null for Emode's own mirrors. */
    store: StoreInfo | null;
    /** What can be tried on without a phone: the store's own rack, or Emode's house rack. */
    rack: { available: boolean; house: boolean };
    /** How far the photo zooms in for this mirror's camera, set at /calibrate. */
    framing: Framing | null;
    limits: { garmentsPerLook: number; idleMinutes: number; retainMinutes: number };
}

export interface RackItem {
    id: string;
    name: string;
    brand: string | null;
    price: number | null;
    currency: string | null;
    imageUrl: string;
    category: Category;
    /** Who it's cut for, when the rack says (Emode's house rack does). */
    gender: 'women' | 'men' | null;
}

export interface RackStatus {
    /** The retailer's catalog the rack is copied from: a Google Shopping feed or a Shopify link. */
    feedUrl: string | null;
    /** An Emode Business account's listings are part of the rack too. */
    emodeShop: boolean;
    count: number;
    byCategory: Partial<Record<Category, number>>;
    syncedAt: string | null;
    syncing: boolean;
    /** An error from the last refresh, or a note about it. */
    message: string | null;
    preview: { id: string; name: string; price: number | null; currency: string | null; imageUrl: string }[];
}

export interface StoreDashboard {
    store: { name: string; logoUrl: string | null; hasRack: boolean };
    rack: RackStatus;
    days: number;
    totals: {
        visits: number;
        pairedRate: number;
        looks: number;
        looksPerVisit: number;
        avgLookSeconds: number;
        appTaps: number;
        linkOpens: number;
        members: number;
    };
    mirrors: { name: string; location: string | null; active: boolean; online: boolean; lastSeenAt: string | null; visits: number; looks: number }[];
    daily: { date: string; visits: number; looks: number }[];
    topRack: { id: string; name: string; price: number | null; currency: string | null; imageUrl: string | null; tries: number }[];
    topLinks: { host: string; title: string; count: number }[];
}

/** A price as a shopper reads it: "$120", "£89.50". */
export function formatPrice(price: number, currency: string | null): string {
    try {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: currency || 'USD',
            minimumFractionDigits: price % 1 ? 2 : 0,
            maximumFractionDigits: 2,
        }).format(price);
    } catch {
        return `$${price.toFixed(2)}`;
    }
}

export class MirrorError extends Error {
    constructor(message: string, public status: number, public code?: string) {
        super(message);
    }
}

export async function mirrorCall<T>(body: Record<string, unknown>, deviceKey?: string | null): Promise<T> {
    let res: Response;
    try {
        res = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                apikey: ANON_KEY,
                authorization: `Bearer ${ANON_KEY}`,
                ...(deviceKey ? { 'x-mirror-device-key': deviceKey } : {}),
            },
            body: JSON.stringify(body),
            cache: 'no-store',
        });
    } catch {
        throw new MirrorError('Could not reach Emode. Check the connection and try again.', 0, 'offline');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new MirrorError(data?.error || 'Something went wrong', res.status, data?.code);
    return data as T;
}
