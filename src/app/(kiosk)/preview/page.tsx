'use client';

import { notFound, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { Attract, Result, type ShareInfo } from '@/components/kiosk/Screens';
import type { Garment, Look } from '@/lib/api';
import { EMODE_APP_URL, RETAILERS_URL } from '@/lib/links';

/**
 * Development only: kiosk screens with made-up data, for checking a layout
 * without a camera, a visit or a generated look.
 *
 *   /preview?screen=attract|result[&credit=0][&store=1]
 */
function Preview() {
    const q = useSearchParams();
    const share: ShareInfo = {
        appUrl: EMODE_APP_URL,
        retailersUrl: q.get('store') === '1' ? null : RETAILERS_URL,
        credit: q.get('credit') === '0' ? null : {
            name: 'Brandon Talla',
            title: 'AI Native Software Engineering Analyst (TDP)',
            url: 'https://www.linkedin.com/in/brandon-talla',
        },
    };
    const look: Look = {
        id: 'look-1', status: 'succeeded', error: null, garmentIds: ['g1', 'g2'],
        imageUrl: '/rack/men/black-suit.jpg', createdAt: new Date().toISOString(),
    };
    const pieces = [
        { id: 'g1', source: 'catalog', productId: null, category: 'suits', title: 'Black Suit', productUrl: null, imageUrl: '/rack/men/black-suit.jpg' },
        { id: 'g2', source: 'catalog', productId: null, category: 'shoes', title: 'Sneakers', productUrl: null, imageUrl: '/rack/men/white-sneakers.jpg' },
    ] as Garment[];

    const screen = q.get('screen') === 'result'
        ? <Result look={look} looks={[look]} pieces={pieces} share={share} onSelectLook={() => {}} onChangeOutfit={() => {}} onNewPhoto={() => {}} onFinish={() => {}} />
        : <Attract location="Workplace pilot" store={null} rackAvailable share={share} onStart={() => {}} />;

    return (
        <div data-theme="dark" className="fixed inset-0 grid place-items-center bg-bg text-fg">
            <div className="relative overflow-hidden" style={{ width: 'min(100vw, 56.25vh)', height: 'min(100vh, 177.78vw)' }}>
                {screen}
            </div>
        </div>
    );
}

export default function PreviewPage() {
    if (process.env.NODE_ENV === 'production') notFound();
    return (
        <Suspense>
            <Preview />
        </Suspense>
    );
}
