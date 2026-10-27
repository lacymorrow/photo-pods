/**
 * @fileoverview Filename extension for downloaded pod media.
 * @module lib/pods/media-extension
 */

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/gif": "gif",
  "image/avif": "avif",
};

/**
 * Pick a file extension for a downloaded media blob.
 *
 * Private and group pods serve media through `/api/pods/media/{id}`, which has
 * no extension in the path (LAC-3173), so the content type is the primary
 * source. Parsing the URL is only a fallback for the direct object URLs that
 * public pods still use.
 */
export const extensionFor = (blobType: string | null | undefined, url: string): string => {
  const mime = (blobType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const fromMime = EXT_BY_MIME[mime];
  if (fromMime) return fromMime;

  const path = url.split("?")[0] ?? "";
  const lastSegment = path.split("/").pop() ?? "";
  const dot = lastSegment.lastIndexOf(".");
  const fromUrl = dot > 0 ? lastSegment.slice(dot + 1) : "";
  return /^[a-z0-9]{1,5}$/i.test(fromUrl) ? fromUrl.toLowerCase() : "jpg";
};
