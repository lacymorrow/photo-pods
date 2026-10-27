import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";

import { isResizeCandidateMime, resizeMediaImage } from "@/server/services/pod-media-resize";

/** Narrows the nullable resize result; a null here is itself the failure. */
const mustResize = async (
  input: ArrayBuffer,
  opts: { width: number; quality: number }
): Promise<{ body: Buffer; contentType: string }> => {
  const resized = await resizeMediaImage(input, opts);
  if (!resized) throw new Error("resizeMediaImage returned null");
  return resized;
};

/** `Buffer` -> the exact `ArrayBuffer` slice it views. */
const bytes = (buf: Buffer): ArrayBuffer =>
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

/**
 * The cost this guards (LAC-5698): PR #50 set `unoptimized` on every src that
 * points at the membership-checked media route, so a private pod's grid went
 * from resized WebP to full-size originals. The route resizes instead, which
 * only helps if the resize actually shrinks the payload.
 */
describe("resizeMediaImage", () => {
  let original: ArrayBuffer;

  beforeAll(async () => {
    // A noisy 4000x3000 JPEG — compressible noise rather than flat colour, so
    // the byte comparison below means something.
    const pixels = Buffer.alloc(4000 * 3000 * 3);
    for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 2654435761) % 256;
    const jpeg = await sharp(pixels, { raw: { width: 4000, height: 3000, channels: 3 } })
      .jpeg({ quality: 90 })
      .toBuffer();
    original = bytes(jpeg);
  });

  it("renders the requested width and comes back smaller than the original", async () => {
    const resized = await mustResize(original, { width: 640, quality: 75 });
    const meta = await sharp(resized.body).metadata();
    expect(meta.width).toBe(640);
    expect(meta.format).toBe("webp");
    expect(resized.contentType).toBe("image/webp");
    expect(resized.body.byteLength).toBeLessThan(original.byteLength);
  });

  it("does not upscale a source narrower than the requested width", async () => {
    const small = await sharp({
      create: { width: 120, height: 90, channels: 3, background: "#336699" },
    })
      .jpeg()
      .toBuffer();
    const resized = await mustResize(bytes(small), { width: 1920, quality: 75 });
    const meta = await sharp(resized.body).metadata();
    expect(meta.width).toBe(120);
  });

  /**
   * The route falls back to the original on null. Garbage must not 500.
   */
  it("returns null for bytes that are not an image", async () => {
    const junk = Buffer.from("not an image, not even close");
    const result = await resizeMediaImage(bytes(junk), { width: 640, quality: 75 });
    expect(result).toBeNull();
  });

  /**
   * The re-encode must not carry EXIF forward: LAC-3174 strips metadata at
   * upload and the derived bytes should not reintroduce a GPS tag.
   */
  it("writes no EXIF into the render even when the source has some", async () => {
    const withExif = await sharp({
      create: { width: 1200, height: 900, channels: 3, background: "#101010" },
    })
      .withExif({ IFD0: { Copyright: "photopods-test", Software: "photopods-test" } })
      .jpeg()
      .toBuffer();
    const resized = await mustResize(bytes(withExif), { width: 640, quality: 75 });
    const meta = await sharp(resized.body).metadata();
    expect(meta.exif).toBeUndefined();
  });
});

/**
 * A routing hint, not a gate. The gate is the byte sniff, covered above.
 */
describe("isResizeCandidateMime", () => {
  it("accepts exactly the uploadable photo types (PHOTO_MIMES, pods.ts:604)", () => {
    expect(isResizeCandidateMime("image/jpeg")).toBe(true);
    expect(isResizeCandidateMime("image/png")).toBe(true);
    expect(isResizeCandidateMime("image/webp")).toBe(true);
    expect(isResizeCandidateMime("image/heic")).toBe(true);
    expect(isResizeCandidateMime("image/heif")).toBe(true);
    expect(isResizeCandidateMime("IMAGE/JPEG")).toBe(true);
    expect(isResizeCandidateMime("image/jpeg; charset=binary")).toBe(true);
  });

  /**
   * `image/tiff` and `image/avif` were in the first version of this set and
   * are not uploadable, so they came back out (LAC-5705 F1).
   */
  it("refuses types no upload path can produce", () => {
    expect(isResizeCandidateMime("image/tiff")).toBe(false);
    expect(isResizeCandidateMime("image/avif")).toBe(false);
    expect(isResizeCandidateMime("image/gif")).toBe(false);
    expect(isResizeCandidateMime("image/svg+xml")).toBe(false);
    expect(isResizeCandidateMime("video/mp4")).toBe(false);
    expect(isResizeCandidateMime("application/pdf")).toBe(false);
    expect(isResizeCandidateMime(null)).toBe(false);
    expect(isResizeCandidateMime(undefined)).toBe(false);
  });
});

/**
 * LAC-5705 F1. The first version of this module gated on `media.mimeType`,
 * which is client-supplied on the presigned upload path and never verified
 * against the object. sharp picks its decoder by sniffing bytes, so that
 * allowlist restricted nothing: a label of `image/jpeg` on SVG, GIF or TIFF
 * bytes decoded fine.
 *
 * These feed real bytes of each excluded container. A test written from MIME
 * strings cannot catch this class of bug, which is why the one above is not
 * enough on its own.
 */
describe("resizeMediaImage decodes on sniffed format, not the declared label", () => {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">' +
      '<rect width="800" height="600" fill="red"/></svg>'
  );

  const asArrayBuffer = (buf: Buffer): ArrayBuffer =>
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

  it("refuses SVG bytes however they are labelled", async () => {
    // Sanity: sharp really would have decoded this.
    expect((await sharp(svg).metadata()).format).toBe("svg");

    expect(await resizeMediaImage(asArrayBuffer(svg), { width: 640, quality: 75 })).toBeNull();
  });

  it("refuses GIF and TIFF bytes, which the MIME check used to let through", async () => {
    for (const format of ["gif", "tiff"] as const) {
      const buf = await sharp({
        create: { width: 800, height: 600, channels: 3, background: "#777777" },
      })
        [format]()
        .toBuffer();
      expect((await sharp(buf).metadata()).format).toBe(format);

      expect(await resizeMediaImage(asArrayBuffer(buf), { width: 640, quality: 75 })).toBeNull();
    }
  });

  it("still resizes every container an upload can actually produce", async () => {
    for (const format of ["jpeg", "png", "webp"] as const) {
      const buf = await sharp({
        create: { width: 1600, height: 1200, channels: 3, background: "#2244aa" },
      })
        [format]()
        .toBuffer();

      const resized = await resizeMediaImage(asArrayBuffer(buf), { width: 640, quality: 75 });
      expect(resized, format).not.toBeNull();
      expect((await sharp(resized?.body ?? Buffer.alloc(0)).metadata()).width).toBe(640);
    }
  });

  /**
   * LAC-5705 F2: `failOn: "none"` is gone, so truncated input errors out and
   * the caller serves the original rather than a partial render.
   */
  it("refuses a truncated JPEG rather than returning a partial render", async () => {
    const whole = await sharp({
      create: { width: 1600, height: 1200, channels: 3, background: "#2244aa" },
    })
      .jpeg()
      .toBuffer();
    const truncated = whole.subarray(0, Math.floor(whole.byteLength / 2));

    expect(
      await resizeMediaImage(asArrayBuffer(truncated), { width: 640, quality: 75 })
    ).toBeNull();
  });
});
