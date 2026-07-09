/**
 * Map a DOM rect (viewfinder cutout) onto video pixel coordinates when the
 * <video> uses object-fit: cover.
 */
export function mapCoverCropToVideo(video, videoDisplayRect, cropDisplayRect) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;

    const dw = videoDisplayRect.width;
    const dh = videoDisplayRect.height;
    if (!dw || !dh) return null;

    // object-fit: cover scale
    const scale = Math.max(dw / vw, dh / vh);
    const renderedW = vw * scale;
    const renderedH = vh * scale;
    const offsetX = (dw - renderedW) / 2;
    const offsetY = (dh - renderedH) / 2;

    const relLeft = cropDisplayRect.left - videoDisplayRect.left;
    const relTop = cropDisplayRect.top - videoDisplayRect.top;

    let sx = (relLeft - offsetX) / scale;
    let sy = (relTop - offsetY) / scale;
    let sw = cropDisplayRect.width / scale;
    let sh = cropDisplayRect.height / scale;

    // Clamp to video bounds
    sx = Math.max(0, Math.min(vw - 1, sx));
    sy = Math.max(0, Math.min(vh - 1, sy));
    sw = Math.max(1, Math.min(vw - sx, sw));
    sh = Math.max(1, Math.min(vh - sy, sh));

    return { sx, sy, sw, sh };
}

/**
 * Draw the cropped page region from video onto a canvas and return JPEG data URL.
 */
export function capturePageRegion(video, cutoutEl, quality = 0.92) {
    if (!video || !cutoutEl) return null;
    const videoRect = video.getBoundingClientRect();
    const cutRect = cutoutEl.getBoundingClientRect();
    const crop = mapCoverCropToVideo(video, videoRect, cutRect);
    if (!crop) return null;

    const canvas = document.createElement('canvas');
    // Upscale slightly for OCR quality if crop is small
    const outW = Math.round(Math.max(crop.sw, 900));
    const scale = outW / crop.sw;
    canvas.width = outW;
    canvas.height = Math.round(crop.sh * scale);

    const ctx = canvas.getContext('2d');
    ctx.drawImage(
        video,
        crop.sx,
        crop.sy,
        crop.sw,
        crop.sh,
        0,
        0,
        canvas.width,
        canvas.height
    );
    return canvas.toDataURL('image/jpeg', quality);
}
