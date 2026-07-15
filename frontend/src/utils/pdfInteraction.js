export function shouldZoomPdfWheel(event) {
    return Boolean(event?.ctrlKey && Number(event?.deltaY));
}
