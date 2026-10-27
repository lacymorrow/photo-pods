/**
 * The HEIC rung inside `stripExifClientSide` (LAC-5712).
 *
 * `stripExifClientSide` already intended to turn HEIC into JPEG — its
 * `canvasCompatibleMime` falls HEIC through to `image/jpeg` — but it could
 * only get there if the browser decoded the file first, which Chromium and
 * Firefox do not. It returned the original HEIC instead, and those bytes are
 * what the grid then failed to render. This pins the added fallback.
 *
 * Both browser decode paths are stubbed to fail here. The `<img>` path needs
 * an explicit stub rather than jsdom's: jsdom fires neither `onload` nor
 * `onerror` on an assigned `src`, which is what hung an earlier version of
 * this suite (LAC-3169).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ transcodeHeicToJpeg: vi.fn() }));
vi.mock("@/lib/pods/decode-heic-client", () => ({
  transcodeHeicToJpeg: mocks.transcodeHeicToJpeg,
}));

import { stripExifClientSide } from "@/lib/pods/strip-exif-client";

/** An `<img>` that reports failure, which jsdom's own never does. */
class FailingImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) {
    setTimeout(() => this.onerror?.(), 0);
  }
}

const heicFile = (name = "IMG_0001.heic", type = "image/heic") =>
  new File([new Uint8Array(32)], name, { type });

describe("stripExifClientSide falls back to the HEIC decoder (LAC-5712)", () => {
  beforeEach(() => {
    mocks.transcodeHeicToJpeg.mockReset();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        throw new Error("The source image could not be decoded.");
      })
    );
    vi.stubGlobal("Image", FailingImage);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:stub"),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the transcoded JPEG when the browser cannot decode the HEIC", async () => {
    const transcoded = new File([new Uint8Array(64)], "IMG_0001.jpg", { type: "image/jpeg" });
    mocks.transcodeHeicToJpeg.mockResolvedValue(transcoded);

    const out = await stripExifClientSide(heicFile());

    expect(out).toBe(transcoded);
    expect(out.type).toBe("image/jpeg");
  });

  it("reaches the decoder for a .heic the browser typed as empty", async () => {
    // Windows reports no MIME type for .heic. `photo-upload.tsx` stages those
    // files, so the strip has to accept them too — before this they skipped
    // the whole function and reached the presign step with contentType "",
    // which `PHOTO_MIMES` rejects outright.
    mocks.transcodeHeicToJpeg.mockResolvedValue(
      new File([new Uint8Array(8)], "IMG_0002.jpg", { type: "image/jpeg" })
    );

    const out = await stripExifClientSide(heicFile("IMG_0002.heic", ""));

    expect(out.type).toBe("image/jpeg");
    expect(mocks.transcodeHeicToJpeg).toHaveBeenCalledOnce();
  });

  it("keeps the original file when the transcode also fails", async () => {
    mocks.transcodeHeicToJpeg.mockResolvedValue(null);
    const input = heicFile();

    expect(await stripExifClientSide(input)).toBe(input);
  });

  it("still returns the original for an undecodable non-HEIC image", async () => {
    // The decoder self-guards on `isHeicFile`, so a corrupt PNG gets a null
    // back and no 343 KB download. Behaviour here is unchanged from before.
    mocks.transcodeHeicToJpeg.mockResolvedValue(null);
    const input = new File([new Uint8Array(4)], "corrupt.png", { type: "image/png" });

    expect(await stripExifClientSide(input)).toBe(input);
  });

  it("does not touch a video", async () => {
    const input = new File([new Uint8Array(4)], "clip.mp4", { type: "video/mp4" });

    expect(await stripExifClientSide(input)).toBe(input);
    expect(mocks.transcodeHeicToJpeg).not.toHaveBeenCalled();
  });
});
