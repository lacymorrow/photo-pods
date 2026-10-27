import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BLOB_URL = "https://store123.public.blob.vercel-storage.com/pods/p-1/1700000000-a.jpg";
const PHOTO_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  findFirstMedia: vi.fn(),
  loadPolicyContext: vi.fn(),
  canView: vi.fn(() => true),
  loadStorageConfig: vi.fn(),
}));

vi.mock("@/server/auth", () => ({ auth: mocks.auth }));

vi.mock("@/server/db", () => ({
  db: { query: { podMedia: { findFirst: mocks.findFirstMedia } } },
}));

vi.mock("@/server/services/pod-policy", () => ({
  loadPolicyContext: mocks.loadPolicyContext,
  canView: mocks.canView,
}));

// Keep the real `planMediaServe` — it is the policy under test — but control
// what storage the app thinks it has.
vi.mock("@/server/services/pod-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/pod-storage")>();
  return { ...actual, loadStorageConfig: mocks.loadStorageConfig };
});

import { GET } from "@/app/(app)/api/pods/media/[mediaId]/route";

const BLOB_CONFIG = {
  provider: "vercel-blob" as const,
  bucket: null,
  publicBaseUrl: null,
  accessKeyId: null,
  secretAccessKey: null,
  endpoint: null,
  region: "auto",
};

const params = Promise.resolve({ mediaId: "m-1" });
// biome-ignore lint/suspicious/noExplicitAny: the route only reads `params`.
const call = () => GET({} as any, { params });

const readyMedia = (over: Record<string, unknown> = {}) => ({
  id: "m-1",
  podId: "p-1",
  status: "ready",
  storageKey: null,
  url: BLOB_URL,
  mimeType: "image/jpeg",
  hiddenAt: null,
  ...over,
});

describe("GET /api/pods/media/[mediaId] — pod ACL (LAC-3173)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "u-1", role: "user" } });
    mocks.canView.mockReturnValue(true);
    mocks.loadStorageConfig.mockReturnValue(BLOB_CONFIG);
    mocks.findFirstMedia.mockResolvedValue(readyMedia());
    mocks.loadPolicyContext.mockResolvedValue({ pod: { id: "p-1", visibility: "private" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(PHOTO_BYTES, {
            status: 200,
            headers: { "content-type": "image/jpeg", "content-length": "6", etag: '"abc"' },
          })
      )
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("proxies the bytes for a private pod without disclosing the storage URL", async () => {
    const res = (await call()) as Response;

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    // The whole point: no redirect to the permanently public blob URL.
    expect(res.headers.get("location")).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PHOTO_BYTES);
    expect(globalThis.fetch).toHaveBeenCalledWith(BLOB_URL);
  });

  it("marks proxied media private so no shared cache serves it onward", async () => {
    const res = (await call()) as Response;

    expect(res.headers.get("cache-control")).toContain("private");
    expect(res.headers.get("cache-control")).not.toContain("public");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("refuses a signed-in non-member with 403 and no bytes", async () => {
    mocks.canView.mockReturnValue(false);

    const res = (await call()) as { body: unknown; init: { status: number } };

    expect(res.init.status).toBe(403);
    expect(res.body).toEqual({ error: "forbidden" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("refuses an anonymous viewer with 401 and no bytes", async () => {
    mocks.auth.mockResolvedValue(null);
    mocks.canView.mockReturnValue(false);

    const res = (await call()) as { body: unknown; init: { status: number } };

    expect(res.init.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("does not serve media that moderation has hidden", async () => {
    mocks.findFirstMedia.mockResolvedValue(readyMedia({ hiddenAt: new Date() }));

    const res = (await call()) as { body: unknown; init: { status: number } };

    expect(res.init.status).toBe(404);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("redirects a public pod straight to the object URL", async () => {
    mocks.loadPolicyContext.mockResolvedValue({ pod: { id: "p-1", visibility: "public" } });

    const res = (await call()) as { url: string };

    expect(res.url).toBe(BLOB_URL);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("reports 502 rather than an empty image when the object store fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 500 }))
    );

    const res = (await call()) as { body: unknown; init: { status: number } };

    expect(res.init.status).toBe(502);
    expect(res.body).toEqual({ error: "media_fetch_failed" });
  });

  it("maps a missing object to 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 }))
    );

    const res = (await call()) as { body: unknown; init: { status: number } };

    expect(res.init.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });

  it("falls back to the stored mime type when the store omits content-type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(PHOTO_BYTES, { status: 200 }))
    );
    mocks.findFirstMedia.mockResolvedValue(readyMedia({ mimeType: "image/webp" }));

    const res = (await call()) as Response;

    expect(res.headers.get("content-type")).toBe("image/webp");
  });
});
