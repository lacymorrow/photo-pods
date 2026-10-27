import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";

import { isResizableImageMime, resizeMediaImage } from "@/server/services/pod-media-resize";

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

describe("isResizableImageMime", () => {
  it("accepts the raster formats a phone uploads", () => {
    expect(isResizableImageMime("image/jpeg")).toBe(true);
    expect(isResizableImageMime("image/png")).toBe(true);
    expect(isResizableImageMime("image/heic")).toBe(true);
    expect(isResizableImageMime("IMAGE/JPEG")).toBe(true);
    expect(isResizableImageMime("image/jpeg; charset=binary")).toBe(true);
  });

  /**
   * GIF would lose its animation and SVG would pull in a rasterizer for
   * untrusted markup; both are served as the original instead.
   */
  it("refuses gif, svg, video and anything unknown", () => {
    expect(isResizableImageMime("image/gif")).toBe(false);
    expect(isResizableImageMime("image/svg+xml")).toBe(false);
    expect(isResizableImageMime("video/mp4")).toBe(false);
    expect(isResizableImageMime("application/pdf")).toBe(false);
    expect(isResizableImageMime(null)).toBe(false);
    expect(isResizableImageMime(undefined)).toBe(false);
  });
});
