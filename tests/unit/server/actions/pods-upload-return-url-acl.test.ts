import { beforeEach, describe, expect, it, vi } from "vitest";

const BLOB_URL = "https://store123.public.blob.vercel-storage.com/pods/p-1/1700000000-a.jpg";
const MEDIA_ID = "7b9d6f2a-5c31-4e18-9a04-2f6b8c1d3e55";
const ROUTE_URL = `/api/pods/media/${MEDIA_ID}`;

const mocks = vi.hoisted(() => ({
  auth: vi.fn(async () => ({ user: { id: "u-1", role: "user" } })),
  findFirstMedia: vi.fn(),
  findFirstPod: vi.fn(),
  dbUpdate: vi.fn(),
  transaction: vi.fn(),
  guardUpload: vi.fn(),
  isStorageConfigured: vi.fn(() => false),
  put: vi.fn(),
  uploadFile: vi.fn(),
}));

vi.mock("@/server/auth", () => ({ auth: mocks.auth }));

vi.mock("@/server/db", () => ({
  db: {
    query: {
      podMedia: { findFirst: mocks.findFirstMedia },
      pods: { findFirst: mocks.findFirstPod },
    },
    update: mocks.dbUpdate,
    transaction: mocks.transaction,
  },
}));

vi.mock("@/server/services/pod-policy", () => ({ guardUpload: mocks.guardUpload }));
vi.mock("@/server/services/pod-reactions", () => ({}));

// `applyMediaUrlPolicy` stays real — it is the rule under test. Only the
// storage probes are faked, and `provider: vercel-blob` keeps finalizeUpload
// off the presign/EXIF branch so these tests stay about the return value.
vi.mock("@/server/services/pod-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/pod-storage")>();
  return {
    ...actual,
    isStorageConfigured: mocks.isStorageConfigured,
    loadStorageConfig: vi.fn(() => ({ provider: "vercel-blob" })),
    buildStorageKey: vi.fn(),
    presign: vi.fn(),
    publicUrlForKey: vi.fn(() => null),
  };
});

vi.mock("@/server/services/pod-storage-cleanup", () => ({
  collectMediaKeys: vi.fn(() => []),
  deleteObjectsWithRetry: vi.fn(),
}));

vi.mock("@vercel/blob", () => ({ put: mocks.put }));
vi.mock("@/server/services/file", () => ({ uploadFile: mocks.uploadFile }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { finalizeUpload, uploadPhoto } from "@/server/actions/pods";

const storedRow = (over: Record<string, unknown> = {}) => ({
  id: MEDIA_ID,
  podId: "p-1",
  uploadedById: "u-1",
  type: "photo",
  status: "ready",
  storageKey: null,
  mimeType: "image/jpeg",
  size: 100,
  width: null,
  height: null,
  durationSeconds: null,
  caption: null,
  url: BLOB_URL,
  thumbnailUrl: null,
  readyAt: null,
  exifStripped: null,
  exifVerified: null,
  ...over,
});

/**
 * LAC-5696 (follow-up to LAC-3173). Both upload actions `.returning()` the
 * whole `podMedia` row, `url` included. `lib/pods/upload-media-client.ts`
 * throws both return values away today, so nothing renders the leaked URL —
 * but the server action response still carries a permanent public storage URL
 * back to the uploader's browser, and the next caller that reads the return
 * value inherits the leak for free. Self-only, so the impact is small; the
 * point is that "no read path emits the long-lived URL" should hold without
 * an asterisk.
 */
describe("finalizeUpload — the returned row respects pod visibility (LAC-5696)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "u-1", role: "user" } });
    mocks.findFirstMedia.mockResolvedValue(storedRow({ status: "processing" }));
    mocks.dbUpdate.mockImplementation(() => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          const result = Promise.resolve(undefined) as Promise<unknown> & {
            returning: () => Promise<unknown[]>;
          };
          result.returning = async () => [storedRow(values)];
          return result;
        },
      }),
    }));
  });

  for (const visibility of ["private", "group"] as const) {
    it(`returns the membership-checked route for a ${visibility} pod`, async () => {
      mocks.findFirstPod.mockResolvedValue({ visibility });

      const result = await finalizeUpload({ mediaId: MEDIA_ID });

      expect(result.url).toBe(ROUTE_URL);
      expect(JSON.stringify(result)).not.toContain("blob.vercel-storage.com");
    });
  }

  it("returns the direct URL for a public pod", async () => {
    mocks.findFirstPod.mockResolvedValue({ visibility: "public" });

    const result = await finalizeUpload({ mediaId: MEDIA_ID });

    expect(result.url).toBe(BLOB_URL);
  });

  it("fails closed when the pod cannot be resolved", async () => {
    // A pod row that is missing should never be the reason a public URL
    // escapes, so the unresolved case is treated as non-public.
    mocks.findFirstPod.mockResolvedValue(undefined);

    const result = await finalizeUpload({ mediaId: MEDIA_ID });

    expect(result.url).toBe(ROUTE_URL);
  });

  it("still persists the real storage URL to the database", async () => {
    // The rewrite is a response-shaping rule, not a storage change: the row
    // has to keep the URL the media route needs to fetch the bytes.
    mocks.findFirstPod.mockResolvedValue({ visibility: "private" });
    const setValues: Array<Record<string, unknown>> = [];
    mocks.dbUpdate.mockImplementation(() => ({
      set: (values: Record<string, unknown>) => {
        setValues.push(values);
        return {
          where: () => {
            const result = Promise.resolve(undefined) as Promise<unknown> & {
              returning: () => Promise<unknown[]>;
            };
            result.returning = async () => [storedRow(values)];
            return result;
          },
        };
      },
    }));

    await finalizeUpload({ mediaId: MEDIA_ID });

    expect(setValues[0]?.url).toBe(BLOB_URL);
  });
});

describe("uploadPhoto — the returned row respects pod visibility (LAC-5696)", () => {
  const uploadAs = (visibility: string) => {
    mocks.guardUpload.mockResolvedValue({
      pod: { id: "p-1", visibility, retainLocationExif: null },
      viewer: { userId: `u-${visibility}` },
      membership: { role: "owner" },
    });
    const fd = new FormData();
    // A minimal valid JPEG: SOI, SOS, EOI. The real metadata stripper runs on
    // these bytes, so it has to be something it can parse.
    const jpeg = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xda, 0x00, 0x04, 0x01, 0x00, 0x12, 0x34, 0xff, 0xd9,
    ]);
    fd.append("file", new File([jpeg as BlobPart], "a.jpg", { type: "image/jpeg" }));
    return uploadPhoto("p-1", fd);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isStorageConfigured.mockReturnValue(false);
    mocks.put.mockResolvedValue({ url: BLOB_URL });
    const tx = {
      insert: () => ({
        values: (values: Record<string, unknown>) => ({
          returning: async () => [storedRow({ ...values, url: BLOB_URL })],
        }),
      }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    };
    mocks.transaction.mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
  });

  for (const visibility of ["private", "group"] as const) {
    it(`returns the membership-checked route for a ${visibility} pod`, async () => {
      const result = await uploadAs(visibility);

      // uploadPhoto mints the media id itself, so match the route it built.
      expect(result.url).toBe(`/api/pods/media/${result.id}`);
      expect(JSON.stringify(result)).not.toContain("blob.vercel-storage.com");
      // Negative control: the blob write really did happen, so the assertion
      // above is about a rewrite rather than a path that never stored a URL.
      expect(mocks.put).toHaveBeenCalledTimes(1);
    });
  }

  it("returns the direct URL for a public pod", async () => {
    const result = await uploadAs("public");

    expect(result.url).toBe(BLOB_URL);
  });

  it("writes the real storage URL to the database either way", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const tx = {
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          inserted.push(values);
          return { returning: async () => [storedRow({ ...values, url: BLOB_URL })] };
        },
      }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    };
    mocks.transaction.mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));

    await uploadAs("private");

    expect(inserted[0]?.url).toBe(BLOB_URL);
  });
});
