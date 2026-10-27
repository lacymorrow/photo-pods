/**
 * @fileoverview Browser-side HEIC/HEIF transcode for Photopods uploads (LAC-5712).
 *
 * The product invites HEIC — it is in `PHOTO_MIMES` (`pods.ts:604`) and in the
 * browse `accept` attribute (`photo-upload.tsx`) — because that is what an
 * iPhone's photo library actually holds. Nothing downstream could read it:
 *
 * - A Chromium `<img>` pointed at HEVC-coded .heic bytes reports
 *   `naturalWidth === 0`. Measured, not inferred: the grid and the lightbox
 *   showed a broken image for every such upload.
 * - This build's sharp cannot decode it either. libheif 1.23.2 here is AV1
 *   only (`sharp.format.heif.input.fileSuffix` is `['.avif']`), so a real
 *   iPhone .heic reports `format: "heif"`, `compression: "hevc"` from the
 *   header and then fails mid-decode with "Decoder plugin generated an
 *   error". The media route caught that and served the original undecodable
 *   bytes straight back.
 *
 * Fixing it server-side would mean a libvips rebuild carrying HEVC, with the
 * patent licensing and the native-dependency risk on the Vercel build that
 * implies. Decoding in the browser instead keeps the server dependency-free
 * and fixes the problem at the source rather than at every reader: once the
 * bytes leave here as JPEG, the grid, the lightbox, the resizer and the EXIF
 * backstop all work with no HEIC special case anywhere.
 *
 * `heic2any` wraps the same libheif, compiled to asm.js, and does carry HEVC.
 * It is behind a dynamic `import()` so its ~343 KB gzipped never reaches a
 * visitor who does not pick a HEIC. Measured in Chromium against real
 * `sips`-encoded HEVC files: 467 ms for 1600x1600, 1.5 s for 4032x4032 (more
 * pixels than an iPhone 12 MP frame). It yields to the event loop while it
 * works — 89 of an expected 90 animation frames still ran during that 1.5 s,
 * longest gap 76 ms — so this needs no Worker to keep the UI responsive.
 *
 * Client-safe module: no server imports, and the decoder is only reachable in
 * a browser.
 *
 * @module lib/pods/decode-heic-client
 */

import { isHeicFile } from "@/lib/pods/heic";

/**
 * Matches `JPEG_QUALITY` in `strip-exif-client.ts`. The two are the same
 * tradeoff — this is the archival copy, and the serving layer re-encodes it
 * down to WebP per request anyway.
 */
const JPEG_QUALITY = 0.92;

/** Swap a `.heic`/`.heif` extension for `.jpg`, since the bytes are now JPEG. */
export const jpegFilename = (name: string): string =>
  /\.[^.]+$/.test(name) ? name.replace(/\.[^.]+$/, ".jpg") : `${name}.jpg`;

/**
 * Transcode a HEIC/HEIF file to JPEG in the browser.
 *
 * Returns `null` — never throws — when the file is not HEIC, when there is no
 * browser, or when the decode fails, so callers can fall through to whatever
 * they would have done without a decoder.
 *
 * The output carries no EXIF, XMP or IPTC. libheif renders to pixels and
 * heic2any re-encodes from those, so the metadata is dropped rather than
 * copied. Verified against a real HEVC .heic whose source metadata sharp
 * reported as `hasExif: true`: the JPEG out of here reports `exif`, `xmp` and
 * `iptc` all absent. That is what lets `stripExifClientSide` return this
 * result directly instead of paying for a second canvas round-trip, and it
 * keeps the LAC-3174 strip property intact on this path.
 *
 * Rotation is applied, not merely tagged: libheif honours the HEIF `irot`
 * box while decoding. A 1200x900 source rotated to 900x1200 comes out of here
 * 900x1200, so photos do not land sideways.
 *
 * Note the file grows. HEVC is a better compressor than JPEG, so expect
 * roughly 2-3x the bytes (measured 317 KB -> 896 KB at 4032x4032). Real
 * iPhone frames land in the low single-digit megabytes, well inside the 50 MB
 * `MAX_PHOTO_BYTES` cap that `requestPresignedUpload` checks against this
 * post-transcode size.
 */
export const transcodeHeicToJpeg = async (file: File): Promise<File | null> => {
  if (typeof window === "undefined") return null;
  if (!isHeicFile(file)) return null;

  try {
    const { default: heic2any } = await import("heic2any");
    const converted = await heic2any({ blob: file, toType: "image/jpeg", quality: JPEG_QUALITY });
    // heic2any returns an array only when asked for every image in a
    // multi-image container. We ask for one, but narrow defensively.
    const blob = Array.isArray(converted) ? converted[0] : converted;
    if (!blob || blob.size === 0) return null;

    return new File([blob], jpegFilename(file.name), {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });
  } catch {
    return null;
  }
};
