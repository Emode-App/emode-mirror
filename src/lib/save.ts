/**
 * Put a finished look on the visitor's device.
 *
 * On phones the share sheet is how an image reaches the camera roll; a download
 * link only lands it in Files. Elsewhere, an ordinary download. If both fail,
 * the image opens in a tab where it can be saved by hand.
 */
export async function saveImage(url: string, name: string): Promise<void> {
    try {
        const blob = await (await fetch(url)).blob();
        const file = new File([blob], `${name}.${blob.type.includes('png') ? 'png' : 'jpg'}`, { type: blob.type });
        if (navigator.canShare?.({ files: [file] })) {
            await navigator.share({ files: [file], title: 'My Emode look' });
            return;
        }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = file.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } catch (e) {
        if ((e as Error).name !== 'AbortError') window.open(url, '_blank');
    }
}
