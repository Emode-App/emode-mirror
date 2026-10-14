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
