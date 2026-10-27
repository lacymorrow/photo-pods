import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock refs so vi.mock() factories can share them with test bodies.
const mocks = vi.hoisted(() => ({
  requestPresignedUpload: vi.fn(),
  finalizeUpload: vi.fn(async () => ({})),
  uploadPhoto: vi.fn(async () => ({})),
}));

vi.mock("@/server/actions/pods", () => ({
  requestPresignedUpload: mocks.requestPresignedUpload,
  finalizeUpload: mocks.finalizeUpload,
  uploadPhoto: mocks.uploadPhoto,
}));

// The client strip (LAC-2917 H1) is unit-tested separately; under jsdom its
// <img> fallback never fires onload/onerror, so it hangs this suite whenever
// createImageBitmap is made to reject (LAC-3169). Identity-mock it so this
// file only exercises the upload orchestration.
vi.mock("@/lib/pods/strip-exif-client", () => ({
  stripExifClientSide: vi.fn(async (file: File) => file),
}));

import { stripExifClientSide } from "@/lib/pods/strip-exif-client";
import { uploadPodPhoto } from "@/lib/pods/upload-media-client";

const stripMock = vi.mocked(stripExifClientSide);

const makeFile = (name: string, type: string, bytes = 16) =>
  new File([new Uint8Array(bytes)], name, { type });

const presignedResponse = (overrides: Record<string, unknown> = {}) => ({
  mediaId: "media-1",
  uploadUrl: "https://r2.example/bucket/key?sig=abc",
  method: "PUT" as const,
  headers: {
    "Content-Type": "image/jpeg",
    "Content-Length": "16",
  },
  storageKey: "pods/p-1/media-1.jpg",
  expiresInSeconds: 900,
  ...overrides,
});

describe("uploadPodPhoto (LAC-2912)", () => {
  const fetchMock = vi.fn();
  const createImageBitmapMock = vi.fn();

  beforeEach(() => {
    mocks.requestPresignedUpload.mockReset();
    mocks.finalizeUpload.mockReset();
    mocks.finalizeUpload.mockResolvedValue({});
    mocks.uploadPhoto.mockReset();
    mocks.uploadPhoto.mockResolvedValue({});
    fetchMock.mockReset();
    createImageBitmapMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("createImageBitmap", createImageBitmapMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("presigns with the file's metadata, PUTs it, then finalizes with dimensions", async () => {
    const file = makeFile("beach.jpg", "image/jpeg", 16);
    mocks.requestPresignedUpload.mockResolvedValue(presignedResponse());
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    createImageBitmapMock.mockResolvedValue({
      width: 640,
      height: 480,
      close: vi.fn(),
    });

    await uploadPodPhoto("p-1", file);

    expect(mocks.requestPresignedUpload).toHaveBeenCalledWith({
      podId: "p-1",
      filename: "beach.jpg",
      contentType: "image/jpeg",
      size: 16,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://r2.example/bucket/key?sig=abc");
    expect(init.method).toBe("PUT");
    expect(init.body).toBe(file);
    expect(init.headers["Content-Type"]).toBe("image/jpeg");
    // Content-Length is a forbidden request header in browsers; the
    // runtime sets it from the body, so we must not pass it explicitly.
    expect(init.headers["Content-Length"]).toBeUndefined();

    expect(mocks.finalizeUpload).toHaveBeenCalledWith({
      mediaId: "media-1",
      width: 640,
      height: 480,
    });
    expect(mocks.uploadPhoto).not.toHaveBeenCalled();
  });

  it("still finalizes when the dimension probe fails", async () => {
    const file = makeFile("a.jpg", "image/jpeg");
    mocks.requestPresignedUpload.mockResolvedValue(presignedResponse());
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    createImageBitmapMock.mockRejectedValue(new Error("unsupported"));

    await uploadPodPhoto("p-1", file);

    expect(mocks.finalizeUpload).toHaveBeenCalledWith({ mediaId: "media-1" });
  });

  it("falls back to the legacy action when storage is not configured", async () => {
    const file = makeFile("a.jpg", "image/jpeg");
    mocks.requestPresignedUpload.mockResolvedValue(
      presignedResponse({
        uploadUrl: "",
        headers: {},
        expiresInSeconds: 0,
        fallback: {
          reason: "storage_not_configured",
          message: "Object storage is not configured yet.",
        },
      })
    );

    await uploadPodPhoto("p-1", file);

    expect(mocks.uploadPhoto).toHaveBeenCalledTimes(1);
    const [podId, formData] = mocks.uploadPhoto.mock.calls[0];
    expect(podId).toBe("p-1");
    expect(formData).toBeInstanceOf(FormData);
    expect(formData.get("file")).toBe(file);
    // The legacy action inserts the media row itself; finalizing would
    // double-count. And nothing was PUT to storage.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.finalizeUpload).not.toHaveBeenCalled();
  });

  it("throws and does not finalize when the storage PUT fails", async () => {
    const file = makeFile("a.jpg", "image/jpeg");
    mocks.requestPresignedUpload.mockResolvedValue(presignedResponse());
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }));

    await expect(uploadPodPhoto("p-1", file)).rejects.toThrow(/403/);
    expect(mocks.finalizeUpload).not.toHaveBeenCalled();
  });
});

/**
 * A HEIC that survives the strip step means the browser transcode (LAC-5712)
 * failed. Before LAC-5717 the raw HEIC went to storage, `PHOTO_MIMES` still
 * took it, and the user saw a successful upload with a permanently broken
 * tile — the exact bug the transcode exists to fix, now with no error
 * anywhere. The strip is identity-mocked in this file, so any HEIC handed to
 * `uploadPodPhoto` here arrives at that check still HEIC.
 */
describe("uploadPodPhoto — failed HEIC transcode (LAC-5717)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    mocks.requestPresignedUpload.mockReset();
    mocks.finalizeUpload.mockReset();
    mocks.uploadPhoto.mockReset();
    fetchMock.mockReset();
    stripMock.mockReset();
    stripMock.mockImplementation(async (file: File) => file);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("createImageBitmap", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["a declared HEIC", "IMG_0001.heic", "image/heic"],
    ["a declared HEIF", "IMG_0002.heif", "image/heif"],
    ["a .heic the browser gave no mime type", "IMG_0003.heic", ""],
  ])("throws for %s instead of uploading undisplayable bytes", async (_label, name, type) => {
    await expect(uploadPodPhoto("p-1", makeFile(name, type))).rejects.toThrow(/HEIC/);

    // Nothing reached the server on either path, so no row and no bytes.
    expect(mocks.requestPresignedUpload).not.toHaveBeenCalled();
    expect(mocks.uploadPhoto).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.finalizeUpload).not.toHaveBeenCalled();
  });

  it("uploads normally when the transcode did produce a JPEG", async () => {
    stripMock.mockResolvedValue(makeFile("IMG_0001.jpg", "image/jpeg"));
    mocks.requestPresignedUpload.mockResolvedValue(presignedResponse());
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    mocks.finalizeUpload.mockResolvedValue({});

    await uploadPodPhoto("p-1", makeFile("IMG_0001.heic", "image/heic"));

    expect(mocks.requestPresignedUpload).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: "image/jpeg", filename: "IMG_0001.jpg" })
    );
    expect(mocks.finalizeUpload).toHaveBeenCalledOnce();
  });
});
