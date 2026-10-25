import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ImageAttachment } from '../shared/protocol';

const INLINE_LIMIT = 48 * 1024; // base64 chars

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

/**
 * Moves large images out of chat messages: writes them once (named by content
 * hash) under the extension's storage and replaces the payload with a
 * `file://` URL. ChatPanel turns that into a webview URL before posting.
 */
export class ImageCache {
  private ensured = false;

  constructor(readonly dir: string) {}

  externalize = (img: ImageAttachment): ImageAttachment => {
    if (!img.data || img.data.length <= INLINE_LIMIT) return img;
    try {
      if (!this.ensured) {
        mkdirSync(this.dir, { recursive: true });
        this.ensured = true;
      }
      const hash = createHash('sha1').update(img.data).digest('hex');
      const file = join(this.dir, `${hash}.${EXT[img.mediaType] ?? 'img'}`);
      if (!existsSync(file)) writeFileSync(file, Buffer.from(img.data, 'base64'));
      return { mediaType: img.mediaType, name: img.name, data: '', url: pathToFileURL(file).toString() };
    } catch {
      return img;
    }
  };
}
