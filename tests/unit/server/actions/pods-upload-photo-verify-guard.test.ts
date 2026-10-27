import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Companion to pods-upload-photo-exif.test.ts.
 *
 * That suite runs the REAL stripper/verifier, which is the right default. But
 * two fail-closed branches in uploadPhoto are unreachable with real bytes: a
 * correct stripper never hands the verifier residue, and never produces output
 * the verifier cannot parse. Those branches are the LAC-2932 verification
 * guard, and without a test they can be deleted silently — confirmed by
 * mutation: removing the `!verified.clean` throw left the real-bytes suite
 * fully green.
 *
 * So this file — and only this file — fakes the metadata service, to drive the
 * guard branches directly.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(async () => ({ user: { id: "u-1", role: "user" } })),
  guardUpload: vi.fn(),
  put: vi.fn(),
  uploadFile: vi.fn(),
  transaction: vi.fn(),
  stripImageMetadata: vi.fn(),
  verifyImageMetadataStripped: vi.fn(),
}));

vi.mock("@/server/auth", () => ({ auth: mocks.auth }));
vi.mock("@/server/db", () => ({ db: { query: {}, transaction: mocks.transaction } }));
vi.mock("@/server/services/pod-policy", () => ({ guardUpload: mocks.guardUpload }));
vi.mock("@/server/services/pod-reactions", () => ({}));

// `applyMediaUrlPolicy` is kept real: uploadPhoto's return value runs through
// it (LAC-5696), and a fake would assert nothing.
vi.mock("@/server/services/pod-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/pod-storage")>();
  return {
    ...actual,
    isStorageConfigured: vi.fn(() => false),
    loadStorageConfig: vi.fn(() => ({})),
    buildStorageKey: vi.fn(),
    presign: vi.fn(),
    publicUrlForKey: vi.fn(),
  };
});

vi.mock("@/server/services/pod-storage-cleanup", () => ({
  collectMediaKeys: vi.fn(() => []),
  deleteObjectsWithRetry: vi.fn(),
}));

vi.mock("@/server/services/pod-media-metadata", () => ({
  stripImageMetadata: mocks.stripImageMetadata,
  verifyImageMetadataStripped: mocks.verifyImageMetadataStripped,
}));

vi.mock("@vercel/blob", () => ({ put: mocks.put }));
vi.mock("@/server/services/file", () => ({ uploadFile: mocks.uploadFile }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { uploadPhoto } from "@/server/actions/pods";

const STRIPPED = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);

const uploadAs = (userId: string) => {
  mocks.guardUpload.mockImplementation(async (_podId: string, viewer: Record<string, unknown>) => ({
    pod: { id: "p-1", visibility: "private", retainLocationExif: null },
    viewer: { ...viewer, userId },
    membership: { role: "owner" },
  }));
  const fd = new FormData();
  fd.append("file", new File([STRIPPED as BlobPart], "a.jpg", { type: "image/jpeg" }));
  return uploadPhoto("p-1", fd);
};

/** Nothing reached storage, by any route, and no row was written. */
const expectNothingStored = () => {
  expect(mocks.put).not.toHaveBeenCalled();
  expect(mocks.uploadFile).not.toHaveBeenCalled();
  expect(mocks.transaction).not.toHaveBeenCalled();
};

describe("uploadPhoto — LAC-2932 verification guard is load-bearing (LAC-3174)", () => {
  beforeEach(() => {
    mocks.put.mockReset();
    mocks.put.mockResolvedValue({ url: "https://blob.example/stored.jpg" });
    mocks.uploadFile.mockReset();
    mocks.uploadFile.mockResolvedValue({ url: "https://fallback.example/stored.jpg" });
    mocks.transaction.mockReset();
    mocks.transaction.mockImplementation(async () => [{ id: "m-1" }]);

    // Default: the stripper claims success.
    mocks.stripImageMetadata.mockReset();
    mocks.stripImageMetadata.mockReturnValue({
      ok: true,
      changed: true,
      data: STRIPPED,
      format: "jpeg",
    });
    mocks.verifyImageMetadataStripped.mockReset();
  });

  it("rejects when metadata survives the strip, even though the stripper reported success", async () => {
    // A stripper that misses a segment is the exact failure LAC-2932's
    // verification pass exists to catch. Storing here would mark the row
    // exif_verified_at while the bytes still carry GPS.
    mocks.verifyImageMetadataStripped.mockReturnValue({
      ok: true,
      clean: false,
      residue: "APP1/Exif",
      format: "jpeg",
    });

    await expect(uploadAs("vg-user-a")).rejects.toThrow(/metadata survived the strip/i);
    expectNothingStored();
  });

  it("rejects when the stripped bytes cannot be verified at all", async () => {
    // ok:false is not a pass — unparseable output cannot be proven GPS-free.
    mocks.verifyImageMetadataStripped.mockReturnValue({
      ok: false,
      reason: "unrecognized image format",
    });

    await expect(uploadAs("vg-user-b")).rejects.toThrow(
      /could not be verified metadata-free: unrecognized image format/i
    );
    expectNothingStored();
  });

  it("stores and stamps when the verifier reports clean", async () => {
    // Positive control: the two rejections above are the guard firing, not
    // this path being broken for every input.
    mocks.verifyImageMetadataStripped.mockReturnValue({ ok: true, clean: true, format: "jpeg" });

    await expect(uploadAs("vg-user-c")).resolves.toBeDefined();
    expect(mocks.put).toHaveBeenCalledTimes(1);
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });

  it("verifies the bytes it is about to store, not the bytes it was given", async () => {
    mocks.verifyImageMetadataStripped.mockReturnValue({ ok: true, clean: true, format: "jpeg" });
    const stripperOutput = Uint8Array.from([0xff, 0xd8, 0x11, 0x22, 0xff, 0xd9]);
    mocks.stripImageMetadata.mockReturnValue({
      ok: true,
      changed: true,
      data: stripperOutput,
      format: "jpeg",
    });

    await uploadAs("vg-user-d");

    // The verifier must be handed the stripper's OUTPUT. Verifying the input
    // would pass trivially and prove nothing about what gets stored.
    expect(mocks.verifyImageMetadataStripped).toHaveBeenCalledTimes(1);
    const verified = mocks.verifyImageMetadataStripped.mock.calls[0]![0] as Uint8Array;
    expect(Array.from(verified)).toEqual(Array.from(stripperOutput));
  });
});
