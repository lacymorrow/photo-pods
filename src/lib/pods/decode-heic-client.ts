/**
 * @fileoverview Browser-side HEIC/HEIF transcode for Photopods uploads (LAC-5712).
 *
 * The product invites HEIC — it is in the browse `accept` attribute
 * (`photo-upload.tsx`) — because that is what an iPhone's photo library
 * actually holds. Nothing downstream could read it:
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
 * longest gap 76 ms — so this needs no Worker of our own to keep the UI
 * responsive.
 *
 * Failure is never silent past this module. `PHOTO_MIMES` no longer accepts
 * HEIC (LAC-5717), so a `null` from here means `uploadPodPhoto` throws and
 * the user sees a real error, rather than a stored tile that can never
 * render.
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

/**
 * Mirrors `MAX_PHOTO_BYTES` in `server/actions/pods.ts`, which is the
 * authority — it cannot be imported because that module is `"use server"`
 * and may only export async functions.
 *
 * Checked before the decode, not after (LAC-5717). Transcoding grows the
 * file (HEVC out-compresses JPEG by roughly 2-3x), so an input already over
 * the cap cannot produce an upload the server will take, and spending tens
 * of seconds of asm.js decode to learn that is pure waste. Deliberately the
 * same number rather than a tighter guess: anything below it might still
 * fit, and rejecting a photo the server would have accepted is the worse
 * error.
 */
const MAX_HEIC_INPUT_BYTES = 50 * 1024 * 1024;

/**
 * Ceiling on a single decode (LAC-5717). Without it a decode that never
 * settles leaves `uploadPodPhoto` awaiting forever and the upload UI stuck
 * with no error at all. 60 s is ~40x the measured 1.5 s worst case, which
 * leaves room for a low-end phone and still bounds the hang.
 */
const DECODE_TIMEOUT_MS = 60_000;

/** Race sentinel. `const` + `Symbol()` infers `unique symbol`, so `===` narrows. */
const TIMED_OUT = Symbol("heic-decode-timeout");

type Heic2Any = (opts: { blob: Blob; toType: string; quality: number }) => Promise<Blob | Blob[]>;

/** Swap a `.heic`/`.heif` extension for `.jpg`, since the bytes are now JPEG. */
export const jpegFilename = (name: string): string =>
  /\.[^.]+$/.test(name) ? name.replace(/\.[^.]+$/, ".jpg") : `${name}.jpg`;

/**
 * Blob URL that heic2any built its one worker from, captured at import time.
 *
 * heic2any 0.0.4 does `window.__heic2any__worker = new Worker(...)` once, at
 * module top level, and never re-creates it. A `Worker` instance does not
 * expose the script it was constructed from, and the dynamic `import()` is
 * module-cached so re-importing will not re-run that line, so the only way to
 * ever rebuild the worker is to record the URL as it goes past. The URL stays
 * valid for the life of the document: heic2any never revokes it.
 */
let workerScriptUrl: string | null = null;

let heic2anyPromise: Promise<Heic2Any> | null = null;

const loadHeic2Any = (): Promise<Heic2Any> => {
  if (heic2anyPromise) return heic2anyPromise;

  const loading = (async (): Promise<Heic2Any> => {
    // No `Worker` means no worker to capture and none to rebuild later. The
    // decode itself is heic2any's problem, so just import and let it fail
    // however it fails.
    const RealWorker = typeof window.Worker === "function" ? window.Worker : null;
    if (RealWorker) {
      // One-shot, and restored in `finally` before any caller gets control
      // back. A Proxy rather than a wrapper function so `instanceof`, the
      // prototype and the static shape of `Worker` are all untouched.
      window.Worker = new Proxy(RealWorker, {
        construct(target, args: [string | URL, WorkerOptions?]) {
          workerScriptUrl = String(args[0]);
          return Reflect.construct(target, args);
        },
      });
    }
    try {
      return (await import("heic2any")).default as unknown as Heic2Any;
    } finally {
      if (RealWorker) window.Worker = RealWorker;
    }
  })();

  // A failed chunk load should not poison every later upload in the tab.
  loading.catch(() => {
    heic2anyPromise = null;
  });
  heic2anyPromise = loading;
  return loading;
};

/**
 * Replace heic2any's module-global worker with a fresh one (LAC-5717).
 *
 * Its libheif asm.js heap can be corrupted by one decode and then fail
 * *later* ones. Reproduced in headless Chromium against the committed
 * `iphone-hevc-480x360.heic` fixture: decode it, decode a 64x64 HEIC (which
 * itself succeeds), and the next decode of the known-good fixture fails with
 * `ERR_LIBHEIF Heic doesn't contain valid images`. The corrupted state is
 * intermittent rather than permanently dead — later decodes alternate
 * between correct output and that error — so retrying on the same worker is
 * a coin flip. Rebuilding is deterministic: every decode after one came back
 * byte-identical to the clean-page baseline, repeatedly.
 *
 * Terminating without rebuilding would be strictly worse than doing nothing.
 * heic2any dereferences the global unguarded, so the next call would die on
 * `Cannot read properties of undefined (reading 'postMessage')` and HEIC
 * would be broken for the rest of the page.
 */
const rebuildHeic2AnyWorker = (): boolean => {
  if (!workerScriptUrl) return false;
  const scope = window as Window & { __heic2any__worker?: Worker };
  try {
    scope.__heic2any__worker?.terminate();
  } catch {
    // Already gone; the rebuild below is what matters.
  }
  try {
    scope.__heic2any__worker = new Worker(workerScriptUrl);
    return true;
  } catch {
    return false;
  }
};

interface DecodeAttempt {
  file: File | null;
  timedOut: boolean;
}

const decodeOnce = async (file: File): Promise<DecodeAttempt> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const heic2any = await loadHeic2Any();
    const converted = await Promise.race([
      heic2any({ blob: file, toType: "image/jpeg", quality: JPEG_QUALITY }),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), DECODE_TIMEOUT_MS);
      }),
    ]);
    if (converted === TIMED_OUT) return { file: null, timedOut: true };

    // heic2any returns an array only when asked for every image in a
    // multi-image container. We ask for one, but narrow defensively.
    const blob = Array.isArray(converted) ? converted[0] : converted;
    if (!blob || blob.size === 0) return { file: null, timedOut: false };

    return {
      file: new File([blob], jpegFilename(file.name), {
        type: "image/jpeg",
        lastModified: file.lastModified,
      }),
      timedOut: false,
    };
  } catch {
    return { file: null, timedOut: false };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Transcode a HEIC/HEIF file to JPEG in the browser.
 *
 * Returns `null` — never throws — when the file is not HEIC, when there is no
 * browser, when the input is already too large to upload, or when the decode
 * fails or hangs. Callers fall through to whatever they would have done
 * without a decoder; for `uploadPodPhoto` that is now a visible error.
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
 * cap that `requestPresignedUpload` checks against this post-transcode size.
 */
export const transcodeHeicToJpeg = async (file: File): Promise<File | null> => {
  if (typeof window === "undefined") return null;
  if (!isHeicFile(file)) return null;
  if (file.size <= 0 || file.size > MAX_HEIC_INPUT_BYTES) return null;

  const first = await decodeOnce(file);
  if (first.file) return first.file;

  // A timeout has already cost the user DECODE_TIMEOUT_MS, and doubling that
  // wait buys nothing: the heap corruption this retry exists for fails in
  // milliseconds, not minutes.
  if (first.timedOut) return null;
  if (!rebuildHeic2AnyWorker()) return null;

  return (await decodeOnce(file)).file;
};
