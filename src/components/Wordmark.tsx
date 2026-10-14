/** EMODE. in the app's own setting -- heavy, tight -- with MIRROR beneath in gold. */
export function Wordmark({ className = '', showMirror = true }: { className?: string; showMirror?: boolean }) {
    return (
        <div className={`flex flex-col items-center leading-none ${className}`}>
            <span className="font-sans font-black tracking-[-0.055em]" style={{ fontSize: '1em' }}>
                EMODE.
            </span>
            {showMirror && (
                <span className="mt-[0.28em] font-display font-medium uppercase tracking-[0.42em] text-gold" style={{ fontSize: '0.24em', paddingLeft: '0.42em' }}>
                    Mirror
                </span>
            )}
        </div>
    );
}
