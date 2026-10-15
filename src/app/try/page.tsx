import type { Metadata } from 'next';
import { WebMirror } from '@/components/web/WebMirror';

export const metadata: Metadata = {
    title: 'Try it on — Emode Mirror',
    description: 'Add clothes from any store, take a photo, and see them on you.',
};

// Emode Mirror on your own phone or laptop. Linked from emode.style/mirror.
export default function TryPage() {
    return <WebMirror />;
}
