import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock refs so vi.mock() factories can share them with test bodies.
const mocks = vi.hoisted(() => ({
  auth: vi.fn(async () => ({ user: { id: "u-1", role: "user" } })),
  guardUpload: vi.fn(),
  dbInsert: vi.fn(),
  isStorageConfigured: vi.fn(() => false),
  presign: vi.fn(() => "https://r2.example/signed"),
}));

vi.mock("@/server/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/server/db", () => ({
  db: {
    insert: mocks.dbInsert,
    query: {},
  },
}));

vi.mock("@/server/services/pod-policy", () => ({
  guardUpload: mocks.guardUpload,
}));

vi.mock("@/server/services/pod-reactions", () => ({}));

vi.mock("@/server/services/pod-storage", () => ({
  isStorageConfigured: mocks.isStorageConfigured,
  loadStorageConfig: vi.fn(() => ({})),
  buildStorageKey: vi.fn(() => "pods/p-1/media/m.jpg"),
  presign: mocks.presign,
  publicUrlForKey: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requestPresignedUpload } from "@/server/actions/pods";

describe("requestPresignedUpload — storage-not-configured fallback (LAC-2912)", () => {
  beforeEach(() => {
    mocks.dbInsert.mockReset();
    mocks.dbInsert.mockReturnValue({ values: vi.fn(async () => undefined) });
    mocks.isStorageConfigured.mockReset();
    mocks.guardUpload.mockReset();
    mocks.guardUpload.mockImplementation(async (_podId: string, viewer: any) => ({
      pod: { id: "p-1", retainLocationExif: false },
      viewer: { ...viewer, userId: "u-1" },
      membership: { role: "owner" },
    }));
  });

  it("does not insert an orphan podMedia row when storage is unconfigured", async () => {
    mocks.isStorageConfigured.mockReturnValue(false);

    const res = await requestPresignedUpload({
      podId: "p-1",
      filename: "a.jpg",
      contentType: "image/jpeg",
      size: 1024,
    });

    // The client is told to use the legacy path, which inserts its own row.
    // Inserting here too would leave a permanently-`processing` orphan.
    expect(res.fallback?.reason).toBe("storage_not_configured");
    expect(mocks.dbInsert).not.toHaveBeenCalled();
  });

  it("inserts the pending media row when storage is configured", async () => {
    mocks.isStorageConfigured.mockReturnValue(true);

    const res = await requestPresignedUpload({
      podId: "p-1",
      filename: "a.jpg",
      contentType: "image/jpeg",
      size: 1024,
    });

    expect(res.fallback).toBeUndefined();
    expect(res.uploadUrl).toBe("https://r2.example/signed");
    expect(mocks.dbInsert).toHaveBeenCalledTimes(1);
  });
});

/**
 * The photo mime gate (LAC-5717).
 *
 * HEIC left `PHOTO_MIMES` once the browser started transcoding it to JPEG
 * (LAC-5712). The gate is the only thing standing between a failed transcode
 * and a stored tile that nothing in this app can render — not a Chromium
 * `<img>`, not this build's sharp — so it is worth pinning directly rather
 * than inferring from the client wiring.
 */
describe("requestPresignedUpload — photo mime gate (LAC-5717)", () => {
  beforeEach(() => {
    mocks.dbInsert.mockReset();
    mocks.dbInsert.mockReturnValue({ values: vi.fn(async () => undefined) });
    mocks.isStorageConfigured.mockReset();
    mocks.isStorageConfigured.mockReturnValue(true);
    mocks.guardUpload.mockReset();
    mocks.guardUpload.mockImplementation(async (_podId: string, viewer: any) => ({
      pod: { id: "p-1", retainLocationExif: false },
      viewer: { ...viewer, userId: "u-1" },
      membership: { role: "owner" },
    }));
  });

  const request = (contentType: string, filename = "a.bin", size = 1024) =>
    requestPresignedUpload({ podId: "p-1", filename, contentType, size });

  it.each(["image/jpeg", "image/png", "image/webp"])("accepts %s", async (mime) => {
    await expect(request(mime)).resolves.toMatchObject({ uploadUrl: "https://r2.example/signed" });
  });

  it.each(["image/heic", "image/heif", "image/HEIC"])(
    "rejects %s, because a HEIC reaching the server means the transcode failed",
    async (mime) => {
      await expect(request(mime, "IMG_0001.heic")).rejects.toThrow(/Unsupported content type/);
      expect(mocks.dbInsert).not.toHaveBeenCalled();
    }
  );

  /**
   * This is the property the widened `isHeicFile` gate rests on. A .heic can
   * arrive from Windows with an empty `type`, so the client stages and
   * transcodes it on the filename alone. Nothing stops a caller naming an
   * arbitrary non-image `.heic`, and the only thing that rejects it is this
   * gate refusing the empty content type it arrives with.
   */
  it("rejects an empty content type, whatever the file is named", async () => {
    await expect(request("", "totally-not-an-image.heic")).rejects.toThrow(
      /Unsupported content type/
    );
    expect(mocks.dbInsert).not.toHaveBeenCalled();
  });

  it("still accepts the video mimes, which this change does not touch", async () => {
    await expect(request("video/mp4", "clip.mp4")).resolves.toMatchObject({
      uploadUrl: "https://r2.example/signed",
    });
  });
});
