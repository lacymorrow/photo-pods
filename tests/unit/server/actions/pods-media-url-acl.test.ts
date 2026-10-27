import { beforeEach, describe, expect, it, vi } from "vitest";

const BLOB_URL = "https://store123.public.blob.vercel-storage.com/pods/p-1/1700000000-a.jpg";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(async () => ({ user: { id: "u-1", role: "user" } })),
  findManyMedia: vi.fn(),
  findManyMembers: vi.fn(),
  loadPolicyContext: vi.fn(),
  canView: vi.fn(() => true),
  getReactionCounts: vi.fn(async () => ({})),
  getViewerReactions: vi.fn(async () => ({})),
}));

vi.mock("@/server/auth", () => ({ auth: mocks.auth }));

vi.mock("@/server/db", () => ({
  db: {
    query: {
      podMedia: { findMany: mocks.findManyMedia },
      podMembers: { findMany: mocks.findManyMembers },
    },
  },
}));

vi.mock("@/server/services/pod-policy", () => ({
  loadPolicyContext: mocks.loadPolicyContext,
  canView: mocks.canView,
}));

vi.mock("@/server/services/pod-reactions", () => ({
  getReactionCounts: mocks.getReactionCounts,
  getViewerReactions: mocks.getViewerReactions,
}));

vi.mock("@/server/services/pod-storage-cleanup", () => ({
  collectMediaKeys: vi.fn(() => []),
  deleteObjectsWithRetry: vi.fn(),
}));

vi.mock("@/server/services/pod-media-metadata", () => ({
  stripImageMetadata: vi.fn(),
  verifyImageMetadataStripped: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { getPodPhotos, getUserPods } from "@/server/actions/pods";

const mediaRow = (over: Record<string, unknown> = {}) => ({
  id: "m-1",
  podId: "p-1",
  status: "ready",
  url: BLOB_URL,
  thumbnailUrl: null,
  storageKey: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  uploadedBy: { id: "u-1", name: "U", image: null },
  ...over,
});

/**
 * LAC-3173: the legacy upload path writes photos to Vercel Blob with
 * `access: "public"`, so `podMedia.url` is a permanently public URL. Handing
 * it to a client for a private or group pod leaks media past the pod ACL —
 * the URL keeps working for anyone who ever sees it. Non-public pods must be
 * pointed at the membership-checked media route instead.
 */
describe("getPodPhotos — non-public pods never receive the raw storage URL (LAC-3173)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "u-1", role: "user" } });
    mocks.canView.mockReturnValue(true);
    mocks.getReactionCounts.mockResolvedValue({});
    mocks.getViewerReactions.mockResolvedValue({});
  });

  for (const visibility of ["private", "group"] as const) {
    it(`rewrites url to the membership-checked route for a ${visibility} pod`, async () => {
      mocks.loadPolicyContext.mockResolvedValue({ pod: { id: "p-1", visibility } });
      mocks.findManyMedia.mockResolvedValue([mediaRow()]);

      const { photos } = await getPodPhotos("p-1");

      expect(photos[0]?.url).toBe("/api/pods/media/m-1");
      expect(JSON.stringify(photos)).not.toContain("blob.vercel-storage.com");
    });

    it(`does not leak a populated thumbnailUrl for a ${visibility} pod`, async () => {
      mocks.loadPolicyContext.mockResolvedValue({ pod: { id: "p-1", visibility } });
      mocks.findManyMedia.mockResolvedValue([
        mediaRow({
          thumbnailUrl: "https://store123.public.blob.vercel-storage.com/pods/p-1/thumb.jpg",
        }),
      ]);

      const { photos } = await getPodPhotos("p-1");

      expect(photos[0]?.thumbnailUrl).toBeNull();
      expect(JSON.stringify(photos)).not.toContain("blob.vercel-storage.com");
    });
  }

  it("leaves the direct URL in place for a public pod so the CDN can serve it", async () => {
    mocks.loadPolicyContext.mockResolvedValue({ pod: { id: "p-1", visibility: "public" } });
    mocks.findManyMedia.mockResolvedValue([mediaRow()]);

    const { photos } = await getPodPhotos("p-1");

    expect(photos[0]?.url).toBe(BLOB_URL);
  });
});

describe("getUserPods — pod list previews respect the same rule (LAC-3173)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "u-1", role: "user" } });
  });

  it("rewrites the latest-photo preview url for a private pod", async () => {
    mocks.findManyMembers.mockResolvedValue([
      {
        role: "owner",
        pod: {
          id: "p-1",
          visibility: "private",
          memberCount: 1,
          mediaCount: 1,
          members: [],
          media: [mediaRow()],
        },
      },
    ]);

    const result = await getUserPods();

    expect(result[0]?.latestPhoto?.url).toBe("/api/pods/media/m-1");
    expect(JSON.stringify(result)).not.toContain("blob.vercel-storage.com");
  });

  it("leaves the latest-photo preview url alone for a public pod", async () => {
    mocks.findManyMembers.mockResolvedValue([
      {
        role: "owner",
        pod: {
          id: "p-1",
          visibility: "public",
          memberCount: 1,
          mediaCount: 1,
          members: [],
          media: [mediaRow()],
        },
      },
    ]);

    const result = await getUserPods();

    expect(result[0]?.latestPhoto?.url).toBe(BLOB_URL);
  });

  it("handles a pod with no media", async () => {
    mocks.findManyMembers.mockResolvedValue([
      {
        role: "member",
        pod: {
          id: "p-2",
          visibility: "group",
          memberCount: 2,
          mediaCount: 0,
          members: [],
          media: [],
        },
      },
    ]);

    const result = await getUserPods();

    expect(result[0]?.latestPhoto).toBeNull();
  });
});
