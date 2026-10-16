// The deploy that is live right now. Mirrors ask every few minutes and reload
// themselves between visits when it differs from the copy they are running.
export const dynamic = 'force-dynamic';

export function GET() {
    return Response.json(
        { build: process.env.VERCEL_GIT_COMMIT_SHA || 'dev' },
        { headers: { 'cache-control': 'no-store' } },
    );
}
