// Supersample small type, while bounding the memory used by a zoomed page.
export function pdfRasterSize(width: number, height: number, devicePixelRatio: number) {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const scale = Math.min(Math.max(2, ratio * 1.5), Math.sqrt(8_000_000 / (width * height)), 16384 / Math.max(width, height));
  const pixelWidth = Math.max(1, Math.floor(width * scale));
  const pixelHeight = Math.max(1, Math.floor(height * scale));
  return { pixelWidth, pixelHeight, scaleX: pixelWidth / width, scaleY: pixelHeight / height };
}
