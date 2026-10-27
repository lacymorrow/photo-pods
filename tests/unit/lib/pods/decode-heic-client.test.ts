/**
 * HEIC transcode wiring (LAC-5712, hardened in LAC-5717).
 *
 * heic2any is mocked here because it needs a real browser: it decodes through
 * libheif asm.js and re-encodes through a canvas, neither of which jsdom
 * provides. So this file pins the contract and the wiring — when the decoder
 * is reached, what it is handed, and what happens when it fails.
 *
 * It deliberately does **not** claim HEVC decodes. That property needs real
 * browser bytes and lives in `tests/e2e/pods-heic-transcode.spec.ts`, which
 * runs under Playwright via `bun run test:e2e`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const terminate = vi.fn();
  const constructed: string[] = [];
  class FakeWorker {
    terminate = terminate;
    postMessage = vi.fn();
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
    constructor(url: string | URL) {
      constructed.push(String(url));
    }
  }
  return { heic2any: vi.fn(), terminate, constructed, FakeWorker };
});

vi.mock("heic2any", () => {
  // Mirrors heic2any 0.0.4, which assigns `window.__heic2any__worker` once at
  // module top level and never re-creates it. That one-shot is the whole
  // reason the transcoder has to capture the worker URL on the way past.
  (globalThis as unknown as { __heic2any__worker?: unknown }).__heic2any__worker = new (
    globalThis as unknown as { Worker: new (u: string) => unknown }
  ).Worker("blob:heic2any-fake-worker");
  return { default: mocks.heic2any };
});

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
    mocks.terminate.mockReset();
    mocks.constructed.length = 0;
    // jsdom has no Worker, and the transcoder needs one to exist in order to
    // capture heic2any's worker URL and rebuild it later.
    vi.stubGlobal("Worker", mocks.FakeWorker);
  });
  afterEach(() => {
    vi.useRealTimers();
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

  /**
   * LAC-5717. heic2any's libheif asm.js heap can be corrupted by one decode
   * and then fail *later* ones. Reproduced in headless Chromium: decode the
   * committed `iphone-hevc-480x360.heic` fixture, decode a 64x64 HEIC (which
   * itself succeeds), and the next decode of the known-good fixture fails
   * with `ERR_LIBHEIF Heic doesn't contain valid images`. Rebuilding the
   * worker recovers it; terminating without rebuilding does not, because
   * heic2any dereferences the global unguarded.
   */
  it("rebuilds the poisoned worker and retries once", async () => {
    mocks.heic2any
      .mockRejectedValueOnce(new Error("ERR_LIBHEIF Heic doesn't contain valid images"))
      .mockResolvedValueOnce(new Blob([new Uint8Array(48)], { type: "image/jpeg" }));

    const out = await transcodeHeicToJpeg(file("IMG_0005.heic", "image/heic"));

    expect(out?.type).toBe("image/jpeg");
    expect(out?.size).toBe(48);
    expect(mocks.heic2any).toHaveBeenCalledTimes(2);
    expect(mocks.terminate).toHaveBeenCalledOnce();
    // Rebuilt from the URL captured when heic2any built its own worker, which
    // is the only handle on that script: a Worker does not expose it, and the
    // module-cached import will not re-run the line that created it.
    expect(mocks.constructed).toEqual(["blob:heic2any-fake-worker"]);
  });

  it("gives up after the single retry instead of looping on a file that cannot decode", async () => {
    mocks.heic2any.mockRejectedValue(new Error("abort(14)"));

    expect(await transcodeHeicToJpeg(file("hopeless.heic", "image/heic"))).toBeNull();
    expect(mocks.heic2any).toHaveBeenCalledTimes(2);
  });

  /**
   * LAC-5717 finding 2. Without the race, a decode that never settles leaves
   * `uploadPodPhoto` awaiting forever and the upload tray stuck with no error.
   */
  it("gives up on a decode that never settles", async () => {
    vi.useFakeTimers();
    mocks.heic2any.mockReturnValue(new Promise(() => {}));

    const pending = transcodeHeicToJpeg(file("hangs.heic", "image/heic"));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await pending).toBeNull();
    // A timeout is not evidence of a corrupted worker, and retrying would
    // cost the user another full minute.
    expect(mocks.heic2any).toHaveBeenCalledTimes(1);
    expect(mocks.terminate).not.toHaveBeenCalled();
  });

  it("stays pending while the decode is still inside the timeout", async () => {
    vi.useFakeTimers();
    let settle: (b: Blob) => void = () => {};
    mocks.heic2any.mockReturnValue(new Promise<Blob>((r) => (settle = r)));

    const pending = transcodeHeicToJpeg(file("slow.heic", "image/heic"));
    await vi.advanceTimersByTimeAsync(59_000);
    settle(new Blob([new Uint8Array(12)], { type: "image/jpeg" }));

    expect((await pending)?.size).toBe(12);
  });

  /**
   * LAC-5717 finding 2. `MAX_PHOTO_BYTES` was only checked after the
   * transcode, so an oversized input was fully decoded before anything
   * rejected it. Transcoding grows the file, so an input already over the cap
   * cannot produce an upload the server will take.
   */
  it("refuses to decode an input already past the server's size cap", async () => {
    const huge = file("huge.heic", "image/heic");
    Object.defineProperty(huge, "size", { value: 50 * 1024 * 1024 + 1 });

    expect(await transcodeHeicToJpeg(huge)).toBeNull();
    expect(mocks.heic2any).not.toHaveBeenCalled();
  });

  it("still decodes an input exactly at the cap", async () => {
    mocks.heic2any.mockResolvedValue(new Blob([new Uint8Array(8)], { type: "image/jpeg" }));
    const atCap = file("at-cap.heic", "image/heic");
    Object.defineProperty(atCap, "size", { value: 50 * 1024 * 1024 });

    expect(await transcodeHeicToJpeg(atCap)).not.toBeNull();
    expect(mocks.heic2any).toHaveBeenCalledOnce();
  });

  it("refuses an empty file rather than handing zero bytes to the decoder", async () => {
    expect(await transcodeHeicToJpeg(file("empty-input.heic", "image/heic", 0))).toBeNull();
    expect(mocks.heic2any).not.toHaveBeenCalled();
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
