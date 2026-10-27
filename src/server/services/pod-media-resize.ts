/**
 * @fileoverview Server-side resize for media served through the
 * membership-checked pod media route.
 * @module server/services/pod-media-resize
 */

import sharp from "sharp";

/**
 * Containers we are willing to decode, keyed on what sharp **sniffs from the
 * bytes** — never on the declared MIME type.
 *
 * sharp picks its decoder from the content, and its build here carries
 * decoders for svg, gif, tiff, pdf, jxl, dcraw, magick and more. A MIME-string
 * allowlist therefore restricts nothing: `podMedia.mimeType` is client-supplied
 * on the presigned upload path (`pods.ts:656`, stored at `:704`) and nothing
 * inspects the object, so SVG, GIF or TIFF bytes labelled `image/jpeg` would
 * sail through a declared-type check and decode anyway. Probed against sharp
 * 0.35.4: those three report `svg`, `gif` and `tiff`, so they are each
 * excludable here. Same reasoning `pod-media-metadata.ts` already applies
 * ("client-supplied MIME types are not trusted").
 *
 * The set is the intersection with `PHOTO_MIMES` in `pods.ts:604`, the only
 * things actually uploadable: jpeg, png, webp and heic/heif. AVIF also reports
 * `heif`, which is why one rung covers all three. GIF stays out because a
 * resize would flatten its animation, SVG because rasterizing untrusted markup
 * buys no payload win, and the rest because nothing can put them here.
 */
const DECODABLE_FORMATS = new Set(["jpeg", "png", "webp", "heif"]);

/**
 * Declared types worth *attempting*. This is a cheap routing hint, not a
 * security gate — the gate is `DECODABLE_FORMATS` above, applied to the
 * sniffed format inside `resizeMediaImage`. It exists only so the route does
 * not fetch and probe an object that claims to be a video.
 *
 * Mirrors `PHOTO_MIMES` (`pods.ts:604`).
 */
const RESIZE_CANDIDATE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

/**
 * Decode ceiling. `MAX_PHOTO_BYTES` lets a 50 MB upload through, and a
 * compressed file that size can decode to far more pixels than we want to
 * hold in a request — refuse rather than resize it.
 */
const MAX_INPUT_PIXELS = 50_000_000;

export const isResizeCandidateMime = (mime: string | null | undefined): boolean => {
  if (typeof mime !== "string") return false;
  const base = mime.toLowerCase().split(";")[0]?.trim();
  return base !== undefined && RESIZE_CANDIDATE_MIME_TYPES.has(base);
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
 * Returns `null` when the bytes are not a format we decode, or on any decode
 * or encode failure, so the caller can fall back to serving the original
 * rather than turn a broken file into a 500.
 */
export const resizeMediaImage = async (
  input: ArrayBuffer,
  { width, quality }: { width: number; quality: number }
): Promise<ResizedImage | null> => {
  const buffer = Buffer.from(input);
  try {
    // Header read, no decode. This is the authoritative format check: the
    // declared MIME never reaches sharp's decoder selection.
    const { format } = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    if (format === undefined || !DECODABLE_FORMATS.has(format)) return null;

    const body = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
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
