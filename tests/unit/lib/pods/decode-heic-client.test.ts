/**
 * HEIC transcode wiring (LAC-5712).
 *
 * heic2any is mocked here because it needs a real browser: it decodes through
 * libheif asm.js and re-encodes through a canvas, neither of which jsdom
 * provides. So this file pins the contract and the wiring — when the decoder
 * is reached, what it is handed, and what happens when it fails.
 *
 * It deliberately does **not** claim HEVC decodes. That property needs real
 * browser bytes and lives in `tests/browser/pods-heic-transcode.test.ts`,
 * which runs under `bun run test:browser`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ heic2any: vi.fn() }));
vi.mock("heic2any", () => ({ default: mocks.heic2any }));

import { jpegFilename, transcodeHeicToJpeg } from "@/lib/pods/decode-heic-client";

const file = (name: string, type: string, bytes = 32) =>
  new File([new Uint8Array(bytes)], name, { type });

describe("jpegFilename", () => {
  it("swaps a heic/heif extension for .jpg", () => {
    expect(jpegFilename("IMG_0001.heic")).toBe("IMG_0001.jpg");
    expect(jpegFilename("IMG_0001.HEIC")).toBe("IMG_0001.jpg");
    expect(jpegFilename("holiday.heif")).toBe("holiday.jpg");
  });

  it("appends .jpg when there is no extension to replace", () => {
    expect(jpegFilename("IMG_0001")).toBe("IMG_0001.jpg");
  });

  it("only replaces the final extension", () => {
    expect(jpegFilename("my.photo.heic")).toBe("my.photo.jpg");
  });
});

describe("transcodeHeicToJpeg (LAC-5712)", () => {
  beforeEach(() => {
    mocks.heic2any.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a JPEG File named .jpg for a HEIC input", async () => {
    mocks.heic2any.mockResolvedValue(new Blob([new Uint8Array(64)], { type: "image/jpeg" }));

    const out = await transcodeHeicToJpeg(file("IMG_0001.heic", "image/heic"));

    expect(out).not.toBeNull();
    expect(out?.name).toBe("IMG_0001.jpg");
    expect(out?.type).toBe("image/jpeg");
    expect(out?.size).toBe(64);
  });

  it("asks for a single JPEG at the archival quality", async () => {
    mocks.heic2any.mockResolvedValue(new Blob([new Uint8Array(8)], { type: "image/jpeg" }));
    const input = file("IMG_0002.heic", "image/heic");

    await transcodeHeicToJpeg(input);

    expect(mocks.heic2any).toHaveBeenCalledWith({
      blob: input,
      toType: "image/jpeg",
      quality: 0.92,
    });
  });

  it("reaches the decoder for a .heic the browser reported with no MIME type", async () => {
    mocks.heic2any.mockResolvedValue(new Blob([new Uint8Array(8)], { type: "image/jpeg" }));

    const out = await transcodeHeicToJpeg(file("IMG_0003.heic", ""));

    expect(out?.type).toBe("image/jpeg");
    expect(mocks.heic2any).toHaveBeenCalledOnce();
  });

  it("narrows an array result to its first image", async () => {
    mocks.heic2any.mockResolvedValue([
      new Blob([new Uint8Array(16)], { type: "image/jpeg" }),
      new Blob([new Uint8Array(99)], { type: "image/jpeg" }),
    ]);

    expect((await transcodeHeicToJpeg(file("burst.heic", "image/heic")))?.size).toBe(16);
  });

  it("preserves lastModified so the staged order is not disturbed", async () => {
    mocks.heic2any.mockResolvedValue(new Blob([new Uint8Array(8)], { type: "image/jpeg" }));
    const input = new File([new Uint8Array(8)], "a.heic", {
      type: "image/heic",
      lastModified: 1_700_000_000_000,
    });

    expect((await transcodeHeicToJpeg(input))?.lastModified).toBe(1_700_000_000_000);
  });

  /**
   * The point of the `isHeicFile` guard is cost, not just correctness: the
   * dynamic import pulls ~343 KB gzipped of libheif, and no visitor who
   * uploads a JPEG should ever pay for it.
   */
  it("never loads the decoder for a format the browser can already read", async () => {
    for (const f of [
      file("a.jpg", "image/jpeg"),
      file("a.png", "image/png"),
      file("a.webp", "image/webp"),
      file("notes.txt", "text/plain"),
      file("archive.zip", ""),
    ]) {
      expect(await transcodeHeicToJpeg(f)).toBeNull();
    }
    expect(mocks.heic2any).not.toHaveBeenCalled();
  });

  it("returns null rather than throwing when the decode fails", async () => {
    mocks.heic2any.mockRejectedValue(new Error("ERR_LIBHEIF format not supported"));

    expect(await transcodeHeicToJpeg(file("broken.heic", "image/heic"))).toBeNull();
  });

  it("returns null on an empty result instead of uploading a zero-byte photo", async () => {
    mocks.heic2any.mockResolvedValue(new Blob([], { type: "image/jpeg" }));

    expect(await transcodeHeicToJpeg(file("empty.heic", "image/heic"))).toBeNull();
  });

  it("does nothing on the server, where there is no decoder to reach", async () => {
    const realWindow = globalThis.window;
    // @ts-expect-error - simulating a non-browser runtime
    delete globalThis.window;
    try {
      expect(await transcodeHeicToJpeg(file("IMG_0004.heic", "image/heic"))).toBeNull();
      expect(mocks.heic2any).not.toHaveBeenCalled();
    } finally {
      globalThis.window = realWindow;
    }
  });
});
