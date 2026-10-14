// Where "get the app" goes. TestFlight until Emode is on the App Store; set
// NEXT_PUBLIC_EMODE_APP_URL in Vercel to the App Store link the day it lands,
// no code change needed.
export const EMODE_APP_URL = process.env.NEXT_PUBLIC_EMODE_APP_URL
    ?? 'https://testflight.apple.com/join/MsphXM51';

/**
 * Hand this visit to the Emode app, already signed in, to send pieces from the
 * wardrobe. Uses the app's own scheme, which every installed build understands;
 * the token rides in the query because this URL never leaves the phone.
 */
export function openInAppUrl(sessionId: string, token: string) {
    return `emode://mirror/${sessionId}?t=${encodeURIComponent(token)}`;
}

/**
 * Whether the phone page offers "Open in Emode".
 *
 * Off until the app build that understands emode://mirror is live. The web
 * page deploys on every push; the app ships through App Review and over-the-air
 * updates on its own schedule. Offering the hand-off before the app can catch
 * it lands people on the app's "unmatched route" screen. Flip it on in Vercel
 * (NEXT_PUBLIC_MIRROR_APP_HANDOFF=1) the day the app update goes out.
 */
export const APP_HANDOFF_ENABLED = process.env.NEXT_PUBLIC_MIRROR_APP_HANDOFF === '1';
