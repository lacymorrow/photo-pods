import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock refs so vi.mock() factories can share them with test bodies.
const mocks = vi.hoisted(() => ({
  auth: vi.fn(async () => ({ user: { id: "u-1", role: "user" } })),
  guardUpload: vi.fn(),
  isStorageConfigured: vi.fn(() => false),
  put: vi.fn(),
  uploadFile: vi.fn(),
  insertedValues: [] as Array<Record<string, unknown>>,
  transaction: vi.fn(),
}));

vi.mock("@/server/auth", () => ({ auth: mocks.auth }));

vi.mock("@/server/db", () => ({
  db: {
    query: {},
    transaction: mocks.transaction,
  },
}));

vi.mock("@/server/services/pod-policy", () => ({ guardUpload: mocks.guardUpload }));
vi.mock("@/server/services/pod-reactions", () => ({}));

// isStorageConfigured() must be false or uploadPhoto refuses outright — this is
// the prod configuration today (no R2), which is why this path is the live one.
// `applyMediaUrlPolicy` is kept real: uploadPhoto's return value runs through
// it (LAC-5696), and a fake would assert nothing.
vi.mock("@/server/services/pod-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/pod-storage")>();
  return {
    ...actual,
    isStorageConfigured: mocks.isStorageConfigured,
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

vi.mock("@vercel/blob", () => ({ put: mocks.put }));

// uploadPhoto wraps put() in a try/catch that silently falls back to this.
// Every test asserts it was NOT reached, so a broken @vercel/blob mock can
// never make an assertion about "stored bytes" pass vacuously.
vi.mock("@/server/services/file", () => ({ uploadFile: mocks.uploadFile }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// NOTE: @/server/services/pod-media-metadata is deliberately NOT mocked. The
// real stripImageMetadata/verifyImageMetadataStripped run here — this suite is
// about the wiring between them and the blob write, so faking them would make
// the test assert nothing about production behavior.
import { uploadPhoto } from "@/server/actions/pods";

// A real 64x64 JPEG carrying a genuine GPS IFD, committed for the e2e suite.
// Using the real file rather than a synthetic one keeps this honest: it is the
// same artifact the QA pass uses (tests/e2e/README-photopods-qa.md).
// Resolved from the vitest project root. import.meta.url is not usable here:
// the jsdom environment gives it an http:// base, not file://.
const GPS_FIXTURE_PATH = path.join(process.cwd(), "tests/e2e/fixtures/gps-tagged.jpg");
const gpsJpeg = () => new Uint8Array(readFileSync(GPS_FIXTURE_PATH));

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

// Exif GPS IFD pointer tag 0x8825, little-endian, as it appears in the fixture.
const GPS_TAG_LE = [0x25, 0x88, 0x04, 0x00];
const APP1_MARKER = [0xff, 0xe1];
const EXIF_HEADER = ascii("Exif\0\0");

const hasBytes = (haystack: Uint8Array, needle: number[]): boolean => {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
};

/** Bytes actually handed to @vercel/blob put(), read back off the File. */
const storedBytes = async (): Promise<Uint8Array> => {
  expect(mocks.put).toHaveBeenCalledTimes(1);
  const body = mocks.put.mock.calls[0]![1] as File;
  return new Uint8Array(await body.arrayBuffer());
};

const formDataWith = (bytes: Uint8Array, type = "image/jpeg", name = "gps-tagged.jpg") => {
  const fd = new FormData();
  fd.append("file", new File([bytes as BlobPart], name, { type }));
  return fd;
};

// The sliding-window rate limiter is module-level state shared across tests, so
// every test uploads as its own user id to get a fresh window.
const uploadAs = (userId: string, fd: FormData) => {
  mocks.guardUpload.mockImplementation(async (_podId: string, viewer: Record<string, unknown>) => ({
    pod: { id: "p-1", visibility: "private", retainLocationExif: null },
    viewer: { ...viewer, userId },
    membership: { role: "owner" },
  }));
  return uploadPhoto("p-1", fd);
};

describe("uploadPhoto — server-side EXIF enforcement on the vercel-blob path (LAC-3174)", () => {
  beforeEach(() => {
    mocks.insertedValues.length = 0;
    mocks.put.mockReset();
    mocks.put.mockResolvedValue({ url: "https://blob.example/stored.jpg" });
    mocks.uploadFile.mockReset();
    mocks.uploadFile.mockResolvedValue({ url: "https://fallback.example/stored.jpg" });
    mocks.isStorageConfigured.mockReturnValue(false);

    const tx = {
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          mocks.insertedValues.push(values);
          return { returning: async () => [{ ...values }] };
        },
      }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    };
    mocks.transaction.mockReset();
    mocks.transaction.mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
  });

  it("uses a fixture that really does carry GPS EXIF", () => {
    // Negative control: if this ever stops holding, every assertion below
    // about GPS being absent from the stored bytes becomes meaningless.
    const original = gpsJpeg();
    expect(hasBytes(original, APP1_MARKER)).toBe(true);
    expect(hasBytes(original, EXIF_HEADER)).toBe(true);
    expect(hasBytes(original, GPS_TAG_LE)).toBe(true);
  });

  it("stores the STRIPPED bytes, not the original file", async () => {
    const original = gpsJpeg();

    await uploadAs("up-user-a", formDataWith(original));

    const stored = await storedBytes();
    // The fallback path was not taken, so these really are put()'s bytes.
    expect(mocks.uploadFile).not.toHaveBeenCalled();

    expect(hasBytes(stored, GPS_TAG_LE)).toBe(false);
    expect(hasBytes(stored, EXIF_HEADER)).toBe(false);
    expect(hasBytes(stored, APP1_MARKER)).toBe(false);
    // Not merely "different" — strictly smaller, i.e. a segment was removed.
    expect(stored.byteLength).toBeLessThan(original.byteLength);
    // Still a JPEG: SOI preserved, EOI intact.
    expect(Array.from(stored.slice(0, 2))).toEqual([0xff, 0xd8]);
    expect(Array.from(stored.slice(-2))).toEqual([0xff, 0xd9]);
  });

  it("records the size of the stripped bytes and stamps both EXIF timestamps", async () => {
    await uploadAs("up-user-b", formDataWith(gpsJpeg()));

    const stored = await storedBytes();
    expect(mocks.insertedValues).toHaveLength(1);
    const row = mocks.insertedValues[0]!;

    expect(row.status).toBe("ready");
    expect(row.size).toBe(stored.byteLength);
    // Strip and verification are stamped separately (LAC-2932). PR #38 only
    // covered these on the dead finalizeUpload path; this is the live one.
    expect(row.exifStripped).toBeInstanceOf(Date);
    expect(row.exifVerified).toBeInstanceOf(Date);
  });

  it("fails closed on an unparseable image — nothing is stored, nothing is inserted", async () => {
    const notAnImage = Uint8Array.from(ascii("GIF89a not an accepted format"));

    await expect(uploadAs("up-user-c", formDataWith(notAnImage))).rejects.toThrow(/rejected/i);

    // Fail-closed means the bytes never reach storage by ANY route, and no
    // row is written — not that the error is merely reported after the fact.
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.insertedValues).toHaveLength(0);
  });

  it("refuses to run at all once object storage is configured", async () => {
    mocks.isStorageConfigured.mockReturnValue(true);

    await expect(uploadAs("up-user-d", formDataWith(gpsJpeg()))).rejects.toThrow(
      /legacy upload path is disabled/i
    );
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });
});
