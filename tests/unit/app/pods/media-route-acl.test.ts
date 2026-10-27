import type { NextRequest } from "next/server";
import sharp from "sharp";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
// The route reads only `url` off the request, so a minimal stand-in is enough
// and avoids `NextRequest`, which needs a Next request context to build.
const call = (query = "") =>
  GET({ url: `https://pods.test/api/pods/media/m-1${query}` } as unknown as NextRequest, {
    params,
  });

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

/**
 * LAC-5698. PR #50 closed the LAC-3173 leak by setting `unoptimized` on every
 * src pointing here, which meant a private pod's grid downloaded originals.
 * The route resizes instead, so the ACL stays the only gate and the grid still
 * gets small bytes. These pin both halves of that.
 */
describe("GET /api/pods/media/[mediaId] — in-route resize (LAC-5698)", () => {
  let jpeg: Buffer;

  beforeAll(async () => {
    jpeg = await sharp({
      create: { width: 2400, height: 1800, channels: 3, background: "#4a7fb5" },
    })
      .jpeg({ quality: 92 })
      .toBuffer();
  });

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
          new Response(new Uint8Array(jpeg), {
            status: 200,
            headers: { "content-type": "image/jpeg", etag: '"abc"' },
          })
      )
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serves a smaller WebP render for a private pod at the requested width", async () => {
    const res = (await call("?w=640")) as Response;

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("location")).toBeNull();
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.byteLength).toBeLessThan(jpeg.byteLength);
    expect((await sharp(body).metadata()).width).toBe(640);
  });

  it("still serves the untouched original when no width is asked for", async () => {
    const res = (await call()) as Response;

    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await res.arrayBuffer()).byteLength).toBe(jpeg.byteLength);
  });

  it("runs the ACL before doing any resize work", async () => {
    mocks.canView.mockReturnValue(false);

    const res = (await call("?w=640")) as { body: unknown; init: { status: number } };

    expect(res.init.status).toBe(403);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  /**
   * A presigned R2 URL is normally handed to the browser as a redirect. A
   * resize has to happen on this side of the membership check, so the route
   * proxies instead — and the presigned URL still never reaches the client.
   */
  it("proxies rather than redirects when a presigned private pod asks for a width", async () => {
    mocks.loadStorageConfig.mockReturnValue({
      provider: "r2" as const,
      bucket: "photopods",
      publicBaseUrl: "https://cdn.photopods.app",
      accessKeyId: "ak",
      secretAccessKey: "sk",
      endpoint: "https://acct.r2.cloudflarestorage.com",
      region: "auto",
    });
    mocks.findFirstMedia.mockResolvedValue(
      readyMedia({ storageKey: "pods/p-1/photos/m-1.jpg", url: null })
    );

    const res = (await call("?w=640")) as Response;

    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-type")).toBe("image/webp");
  });

  /**
   * A public pod's src is its CDN URL and `next/image` optimizes it normally,
   * so honouring `?w=` here would only donate unauthenticated CPU.
   */
  it("ignores a width on a public pod and keeps redirecting", async () => {
    mocks.loadPolicyContext.mockResolvedValue({ pod: { id: "p-1", visibility: "public" } });

    const res = (await call("?w=640")) as { url: string };

    expect(res.url).toBe(BLOB_URL);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("ignores a width for media it will not decode", async () => {
    for (const mimeType of ["video/mp4", "image/gif", "image/svg+xml"]) {
      mocks.findFirstMedia.mockResolvedValue(readyMedia({ mimeType }));

      const res = (await call("?w=640")) as Response;

      expect(res.headers.get("content-type")).toBe("image/jpeg");
      expect(Buffer.from(await res.arrayBuffer()).byteLength).toBe(jpeg.byteLength);
    }
  });

  it("falls back to the original instead of 500 when the bytes will not decode", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(PHOTO_BYTES, { status: 200, headers: { "content-type": "image/jpeg" } })
      )
    );

    const res = (await call("?w=640")) as Response;

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PHOTO_BYTES);
  });

  /**
   * A render is a different entity than the stored object, so reusing the
   * upstream ETag would let a cache answer a 640px request with 1200px bytes.
   */
  it("gives each render its own ETag", async () => {
    const small = (await call("?w=640")) as Response;
    const large = (await call("?w=1200")) as Response;
    const plain = (await call()) as Response;

    expect(small.headers.get("etag")).not.toBe(large.headers.get("etag"));
    expect(small.headers.get("etag")).not.toBe(plain.headers.get("etag"));
    expect(plain.headers.get("etag")).toBe('"abc"');
  });

  it("keeps a render out of any shared cache", async () => {
    const res = (await call("?w=640")) as Response;

    expect(res.headers.get("cache-control")).toContain("private");
    expect(res.headers.get("cache-control")).not.toContain("public");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
