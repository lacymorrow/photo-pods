import { beforeEach, describe, expect, it, vi } from "vitest";
import { podMedia, pods } from "@/server/db/pods-schema";

// LAC-7037: updatePod stores coverPhotoUrl unchecked, so deletePod and
// deleteAccount must erase a cover only when it is provably the pod's own.

const mocks = vi.hoisted(() => ({
  auth: vi.fn(async () => ({ user: { id: "u-1", role: "user" } })),
  deleteObjectsWithRetry: vi.fn(async (_k: string[]) => ({ deleted: [], queued: [] })),
  // One FIFO of select results per table, in call order.
  results: new Map<unknown, unknown[][]>(),
}));

const next = (table: unknown) => (mocks.results.get(table) ?? []).shift() ?? [];

vi.mock("@/server/auth", () => ({ auth: mocks.auth }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/services/pod-reactions", () => ({}));
vi.mock("@/server/services/pod-policy", () => ({
  guardPod: vi.fn(async () => ({})),
  isOwner: vi.fn(() => true),
}));
vi.mock("@/server/services/pod-storage", () => ({
  isStorageConfigured: vi.fn(() => true),
  loadStorageConfig: vi.fn(() => ({})),
  buildStorageKey: vi.fn(),
  presign: vi.fn(),
  publicUrlForKey: vi.fn(),
}));
vi.mock("@/server/services/pod-storage-cleanup", async (orig) => ({
  ...(await orig<typeof import("@/server/services/pod-storage-cleanup")>()),
  deleteObjectsWithRetry: mocks.deleteObjectsWithRetry,
}));
vi.mock("@/server/db", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({ where: async () => next(table) }),
    }),
    delete: () => ({ where: async () => undefined }),
  },
}));

import { deleteAccount } from "@/server/actions/settings";
import { deletePod } from "@/server/actions/pods";

const POD = "11111111-1111-1111-1111-111111111111";
const OWN = `https://abc.public.blob.vercel-storage.com/pods/${POD}/1700-cover.jpg`;
const FOREIGN = "https://abc.public.blob.vercel-storage.com/pods/other-pod/9-secret.jpg";
const S3_COVER = "https://my-bucket.s3.us-east-1.amazonaws.com/victim.jpg";

const erased = () => (mocks.deleteObjectsWithRetry.mock.calls[0]?.[0] ?? []) as string[];

describe("deletePod cover erasure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.results.clear();
  });

  // Order per table: deletePod's own select, then the reference check.
  const run = async (
    cover: string | null,
    media: unknown[] = [],
    mediaRefs: unknown[] = [],
    coverRefs: unknown[] = []
  ) => {
    mocks.results.set(podMedia, [media, mediaRefs]);
    mocks.results.set(pods, [[{ coverPhotoUrl: cover }], coverRefs]);
    await deletePod(POD);
  };

  it("erases a Blob cover under pods/<podId>/", async () => {
    await run(OWN);
    expect(erased()).toEqual([OWN]);
  });

  it("erases a cover equal to one of the pod's own media urls", async () => {
    const shared = "https://abc.public.blob.vercel-storage.com/legacy/own.jpg";
    await run(shared, [{ storageKey: null, variants: null, url: shared, thumbnailUrl: null }]);
    expect(erased()).toEqual([shared]);
  });

  it("does not erase another user's object set as the cover", async () => {
    await run(FOREIGN);
    expect(mocks.deleteObjectsWithRetry).not.toHaveBeenCalled();
  });

  it("does not erase a cover-only S3 url", async () => {
    await run(S3_COVER);
    expect(mocks.deleteObjectsWithRetry).not.toHaveBeenCalled();
  });

  it("keeps an own-looking cover that another pod still references", async () => {
    await run(OWN, [], [], [{ url: OWN }]);
    expect(mocks.deleteObjectsWithRetry).not.toHaveBeenCalled();
  });
});

describe("deleteAccount cover erasure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.results.clear();
  });

  const run = async (cover: string | null) => {
    mocks.results.set(pods, [[{ id: POD, coverPhotoUrl: cover }], []]);
    mocks.results.set(podMedia, [[], []]);
    return deleteAccount();
  };

  it("erases an owned pod's own cover", async () => {
    expect((await run(OWN)).success).toBe(true);
    expect(erased()).toEqual([OWN]);
  });

  it("does not erase a foreign object set as an owned pod's cover", async () => {
    expect((await run(FOREIGN)).success).toBe(true);
    expect(mocks.deleteObjectsWithRetry).not.toHaveBeenCalled();
  });
});
