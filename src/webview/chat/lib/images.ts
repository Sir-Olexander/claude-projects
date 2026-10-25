import type { ImageAttachment } from '../../../shared/protocol';

const SUPPORTED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** The API rejects very large images; downscale anything bigger than this. */
const MAX_BYTES = 3.5 * 1024 * 1024;
const MAX_DIMENSION = 2000;

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function splitDataUrl(url: string): { mediaType: string; data: string } {
  const m = /^data:([^;,]+)(?:;base64)?,(.*)$/s.exec(url);
  return m ? { mediaType: m[1], data: m[2] } : { mediaType: 'image/png', data: '' };
}

async function downscale(dataUrl: string): Promise<{ mediaType: string; data: string }> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const scale = Math.min(1, MAX_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return splitDataUrl(dataUrl);
  ctx.drawImage(img, 0, 0, w, h);
  return splitDataUrl(canvas.toDataURL('image/jpeg', 0.85));
}

export function isImageFile(f: { type: string }): boolean {
  return SUPPORTED.has(f.type);
}

/** Reads an image file into an attachment, downscaling large ones. */
export async function fileToAttachment(file: File): Promise<ImageAttachment | undefined> {
  if (!isImageFile(file)) return undefined;
  const url = await readAsDataUrl(file);
  let { mediaType, data } = splitDataUrl(url);
  if (file.size > MAX_BYTES || data.length * 0.75 > MAX_BYTES) {
    try {
      ({ mediaType, data } = await downscale(url));
    } catch {
      // keep original
    }
  }
  return { mediaType, data, name: file.name || 'image' };
}

/**
 * <img> source for an attachment: the extension's cached webview URL when it
 * sent one (history and tool-result images), else a data: URL.
 */
export function attachmentSrc(a: ImageAttachment): string {
  if (a.url) return a.url;
  return `data:${a.mediaType || 'image/png'};base64,${a.data}`;
}
