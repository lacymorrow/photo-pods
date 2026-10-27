import { beforeEach, describe, expect, it, vi } from "vitest";

const BLOB_URL = "https://store123.public.blob.vercel-storage.com/pods/p-1/1700000000-a.jpg";
const CDN_URL = "https://cdn.photopods.app/pods/p-1/photos/m-1.jpg";
const MEDIA_ID = "7b9d6f2a-5c31-4e18-9a04-2f6b8c1d3e55";

const mocks = vi.hoisted(() => ({
  rows: [] as unknown[],
}));

// The queue query is one long builder chain ending in `.limit()`. Only the
// tail has to resolve; everything before it just has to chain.
vi.mock("@/server/db", () => {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "from", "innerJoin", "where", "orderBy"]) {
    chain[method] = () => chain;
  }
  chain.limit = async () => mocks.rows;
  return { db: chain };
});

import { getPendingMediaReports } from "@/server/services/pod-moderation";

const report = (over: { visibility: string; media?: Record<string, unknown> }) => ({
  id: "r-1",
  reason: "nudity_sexual",
  details: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  reporterName: "Reporter",
  media: {
    id: MEDIA_ID,
    type: "photo",
    url: BLOB_URL,
    thumbnailUrl: null,
    caption: null,
    hiddenAt: null,
    reportCount: 1,
    ...over.media,
  },
  pod: { id: "p-1", name: "Pod", visibility: over.visibility },
});

/**
 * LAC-5696 (follow-up to LAC-3173). The moderation queue is admin-gated, so
 * nothing unauthorized reads it. The defect is what it hands the admin: for a
 * private or group pod `podMedia.url` is the permanent public storage URL,
 * and that URL keeps working forever for anyone it is forwarded to, with no
 * pod ACL in front of it. Every other read path stopped emitting it in PR #50;
 * this one was out of that PR's scope.
 */
describe("getPendingMediaReports — the queue emits no storage URL (LAC-5696)", () => {
  beforeEach(() => {
    mocks.rows = [];
  });

  for (const visibility of ["private", "group"] as const) {
    it(`points a ${visibility} pod's report at the membership-checked route`, async () => {
      mocks.rows = [report({ visibility })];

      const [row] = await getPendingMediaReports();

      expect(row?.media.url).toBe(`/api/pods/media/${MEDIA_ID}`);
      expect(JSON.stringify(row)).not.toContain("blob.vercel-storage.com");
    });

    it(`drops a populated thumbnailUrl for a ${visibility} pod`, async () => {
      mocks.rows = [
        report({
          visibility,
          media: { thumbnailUrl: "https://store123.public.blob.vercel-storage.com/thumb.jpg" },
        }),
      ];

      const [row] = await getPendingMediaReports();

      // The admin page renders `thumbnailUrl ?? url`, so a surviving
      // thumbnail would quietly win and reopen the leak.
      expect(row?.media.thumbnailUrl).toBeNull();
      expect(JSON.stringify(row)).not.toContain("blob.vercel-storage.com");
    });

    it(`rewrites a CDN-backed url for a ${visibility} pod too`, async () => {
      // The shape prod gets once R2 is provisioned (LAC-5674): a world-
      // readable CDN URL rather than a blob URL, same leak.
      mocks.rows = [report({ visibility, media: { url: CDN_URL } })];

      const [row] = await getPendingMediaReports();

      expect(row?.media.url).toBe(`/api/pods/media/${MEDIA_ID}`);
      expect(JSON.stringify(row)).not.toContain("cdn.photopods.app");
    });
  }

  it("leaves a public pod's url alone so the CDN can still serve it", async () => {
    mocks.rows = [report({ visibility: "public" })];

    const [row] = await getPendingMediaReports();

    expect(row?.media.url).toBe(BLOB_URL);
  });

  it("still gives the reviewer something to render for hidden media", async () => {
    // Auto-hidden media is the common case in this queue; the route serves it
    // to a moderator, so the queue must still hand over a URL for it.
    mocks.rows = [report({ visibility: "private", media: { hiddenAt: new Date() } })];

    const [row] = await getPendingMediaReports();

    expect(row?.media.url).toBe(`/api/pods/media/${MEDIA_ID}`);
    expect(row?.media.hiddenAt).toBeInstanceOf(Date);
  });

  it("keeps the rest of the report row intact", async () => {
    mocks.rows = [report({ visibility: "private" })];

    const [row] = await getPendingMediaReports();

    expect(row?.id).toBe("r-1");
    expect(row?.reason).toBe("nudity_sexual");
    expect(row?.reporterName).toBe("Reporter");
    expect(row?.pod.visibility).toBe("private");
    expect(row?.media.reportCount).toBe(1);
  });
});
