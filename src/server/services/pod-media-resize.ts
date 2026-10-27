/**
 * @fileoverview Server-side resize for media served through the
 * membership-checked pod media route.
 * @module server/services/pod-media-resize
 */

import sharp from "sharp";

/**
 * Formats we are willing to decode.
 *
 * `image/gif` is left out on purpose — a resize would flatten an animation to
 * its first frame. `image/svg+xml` is left out because rasterizing untrusted
 * SVG pulls in a whole external-entity surface for no payload win; both are
 * served as the original instead.
 */
const RESIZABLE_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/tiff",
  "image/heic",
  "image/heif",
]);

/**
 * Decode ceiling. `MAX_PHOTO_BYTES` lets a 50 MB upload through, and a
 * compressed file that size can decode to far more pixels than we want to
 * hold in a request — refuse rather than resize it.
 */
const MAX_INPUT_PIXELS = 50_000_000;

export const isResizableImageMime = (mime: string | null | undefined): boolean => {
  if (typeof mime !== "string") return false;
  const base = mime.toLowerCase().split(";")[0]?.trim();
  return base !== undefined && RESIZABLE_IMAGE_MIME_TYPES.has(base);
};

export interface ResizedImage {
  body: Buffer;
  contentType: string;
}

/**
 * Resize to `width` and re-encode as WebP.
 *
 * WebP unconditionally, rather than negotiating on `Accept`: it saves the
 * route a `Vary` and every browser that can run this app supports it. The
 * encoder also writes no metadata by default, which keeps the EXIF-strip
 * property of LAC-3174 intact for the derived bytes.
 *
 * Returns `null` on any decode or encode failure so the caller can fall back
 * to serving the original rather than turn a broken file into a 500.
 */
export const resizeMediaImage = async (
  input: ArrayBuffer,
  { width, quality }: { width: number; quality: number }
): Promise<ResizedImage | null> => {
  try {
    const body = await sharp(Buffer.from(input), {
      limitInputPixels: MAX_INPUT_PIXELS,
      failOn: "none",
    })
      // Honour EXIF orientation before it is discarded by the re-encode.
      .rotate()
      .resize({ width, withoutEnlargement: true, fit: "inside" })
      .webp({ quality })
      .toBuffer();
    return { body, contentType: "image/webp" };
  } catch {
    return null;
  }
};
