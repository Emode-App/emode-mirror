// Shrink a picked photo on the phone before it is sent.
//
// A screenshot off a current phone is 1-4 MB, often HEIC, and the model needs
// nowhere near that resolution to read a garment. Re-encoding through a canvas
// also turns whatever format the phone produced into a JPEG the server accepts.

export async function prepareUpload(file: File, maxEdge = 1600): Promise<string> {
    const bitmap = await createImageBitmap(file).catch(() => null);
    if (!bitmap) throw new Error(`${file.name || 'That file'} isn't an image we can read`);

    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    // JPEG has no transparency; a cut-out PNG would otherwise land on black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    return canvas.toDataURL('image/jpeg', 0.9);
}
