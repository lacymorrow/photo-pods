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
  canModerate: vi.fn(() => false),
  loadStorageConfig: vi.fn(),
}));

vi.mock("@/server/auth", () => ({ auth: mocks.auth }));

vi.mock("@/server/db", () => ({
  db: { query: { podMedia: { findFirst: mocks.findFirstMedia } } },
}));

vi.mock("@/server/services/pod-policy", () => ({
  loadPolicyContext: mocks.loadPolicyContext,
  canView: mocks.canView,
  canModerate: mocks.canModerate,
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

// A real UUID: the route validates the shape before it queries, because
// `podMedia.id` is a Postgres `uuid` column (LAC-5696).
const MEDIA_ID = "7b9d6f2a-5c31-4e18-9a04-2f6b8c1d3e55";
const params = Promise.resolve({ mediaId: MEDIA_ID });
// The route reads only `url` off the request, so a minimal stand-in is enough
// and avoids `NextRequest`, which needs a Next request context to build.
const call = (query = "") =>
  GET({ url: `https://pods.test/api/pods/media/${MEDIA_ID}${query}` } as unknown as NextRequest, {
    params,
  });
const callWith = (mediaId: string) =>
  GET({ url: `https://pods.test/api/pods/media/${mediaId}` } as unknown as NextRequest, {
    params: Promise.resolve({ mediaId }),
  });

const readyMedia = (over: Record<string, unknown> = {}) => ({
  id: MEDIA_ID,
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
    mocks.canModerate.mockReturnValue(false);
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
 * LAC-5696: `podMedia.id` is a Postgres `uuid`, so `eq(podMedia.id, mediaId)`
 * on a non-UUID segment raised `invalid input syntax for type uuid` and the
 * route answered 500 with an empty body. PR #50 put every non-public pod's
 * image traffic through this handler, which moved malformed ids onto a hot
 * path. Observed against the deployment before the fix:
 *
 *   GET /api/pods/media/not-a-uuid -> 500 (empty body)
 *   GET /api/pods/media/abc        -> 500
 *
 * The shape check has to sit in front of the query rather than in a catch
 * around it: a catch would answer 404 for a database outage too, and hide it.
 */
describe("GET /api/pods/media/[mediaId] — malformed media id (LAC-5696)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "u-1", role: "user" } });
    mocks.canView.mockReturnValue(true);
    mocks.canModerate.mockReturnValue(false);
    mocks.loadStorageConfig.mockReturnValue(BLOB_CONFIG);
    mocks.findFirstMedia.mockResolvedValue(readyMedia());
    mocks.loadPolicyContext.mockResolvedValue({ pod: { id: "p-1", visibility: "private" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(PHOTO_BYTES, { status: 200 }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  for (const bad of [
    "not-a-uuid",
    "abc",
    "' OR 1=1--",
    "7b9d6f2a5c314e189a042f6b8c1d3e55", // right digits, no hyphens
    "7b9d6f2a-5c31-4e18-9a04-2f6b8c1d3e5", // one digit short
    "7b9d6f2a-5c31-4e18-9a04-2f6b8c1d3e5g", // non-hex digit
    "{7b9d6f2a-5c31-4e18-9a04-2f6b8c1d3e55}",
  ]) {
    it(`answers 404 for ${JSON.stringify(bad)} and never reaches the database`, async () => {
      const res = (await callWith(bad)) as { body: unknown; init: { status: number } };

      expect(res.init.status).toBe(404);
      expect(res.body).toEqual({ error: "not_found" });
      expect(mocks.findFirstMedia).not.toHaveBeenCalled();
    });
  }

  it("accepts an uppercase UUID, which Postgres would have matched anyway", async () => {
    const res = (await callWith(MEDIA_ID.toUpperCase())) as Response;

    expect(mocks.findFirstMedia).toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("still answers 404 for a well-formed id with no row", async () => {
    mocks.findFirstMedia.mockResolvedValue(undefined);

    const res = (await call()) as { body: unknown; init: { status: number } };

    expect(res.init.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });

  it("lets a genuine database failure surface instead of flattening it to 404", async () => {
    // The regression this guards: "just wrap the lookup in try/catch" turns an
    // outage into a quiet not-found. The route must still throw, so Next
    // answers 5xx and the error reaches the logs.
    mocks.findFirstMedia.mockRejectedValue(new Error("connection terminated unexpectedly"));

    await expect(call()).rejects.toThrow(/connection terminated/);
  });
});

/**
 * LAC-5696: the admin moderation queue used to hand reviewers the permanent
 * public storage URL. It now hands them this route, so the route has to serve
 * them — and the media they are reviewing is the hardest case it has.
 *
 * `canView` is not enough. For a private pod it returns true only for the
 * owner, admin or not, and reports are raised against pods the reviewer was
 * never a member of. Auto-hidden media is refused outright before policy runs,
 * and auto-hidden is exactly what lands in the queue.
 */
describe("GET /api/pods/media/[mediaId] — moderator reads (LAC-5696)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "admin" } });
    // A private pod the admin does not own: the real `canView` says no here.
    mocks.canView.mockReturnValue(false);
    mocks.canModerate.mockReturnValue(true);
    mocks.loadStorageConfig.mockReturnValue(BLOB_CONFIG);
    mocks.findFirstMedia.mockResolvedValue(readyMedia());
    mocks.loadPolicyContext.mockResolvedValue({ pod: { id: "p-1", visibility: "private" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(PHOTO_BYTES, {
            status: 200,
            headers: { "content-type": "image/jpeg" },
          })
      )
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serves a private pod's media to a moderator who is not a member", async () => {
    const res = (await call()) as Response;

    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PHOTO_BYTES);
    // Proxied, not redirected: a moderator gets no reusable storage URL either.
    expect(res.headers.get("location")).toBeNull();
  });

  it("serves auto-hidden media to a moderator — that is what the queue is for", async () => {
    mocks.findFirstMedia.mockResolvedValue(readyMedia({ hiddenAt: new Date() }));

    const res = (await call()) as Response;

    expect(res.status).toBe(200);
  });

  it("keeps hidden media hidden from an ordinary member", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "u-1", role: "user" } });
    mocks.canView.mockReturnValue(true);
    mocks.canModerate.mockReturnValue(false);
    mocks.findFirstMedia.mockResolvedValue(readyMedia({ hiddenAt: new Date() }));

    const res = (await call()) as { body: unknown; init: { status: number } };

    expect(res.init.status).toBe(404);
    expect(res.body).toEqual({ error: "not_available" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("does not let a non-admin who fails canView through the moderator branch", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "u-2", role: "user" } });
    mocks.canView.mockReturnValue(false);
    mocks.canModerate.mockReturnValue(false);

    const res = (await call()) as { body: unknown; init: { status: number } };

    expect(res.init.status).toBe(403);
    expect(globalThis.fetch).not.toHaveBeenCalled();
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
    // Set explicitly: `clearAllMocks` keeps return values, so a moderator test
    // above would otherwise leak `true` into every test here.
    mocks.canModerate.mockReturnValue(false);
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
    // Both rungs closed: with only `canView` false, a leaked `canModerate`
    // would let the request through and the test would still look meaningful.
    mocks.canView.mockReturnValue(false);
    mocks.canModerate.mockReturnValue(false);

    const res = (await call("?w=640")) as { body: unknown; init: { status: number } };

    expect(res.init.status).toBe(403);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("resizes for a moderator who passes the gate only via canModerate", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "u-admin", role: "admin" } });
    mocks.canView.mockReturnValue(false);
    mocks.canModerate.mockReturnValue(true);

    const res = (await call("?w=640")) as Response;

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("location")).toBeNull();
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.byteLength).toBeLessThan(jpeg.byteLength);
    expect((await sharp(body).metadata()).width).toBe(640);
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

/**
 * LAC-5705 F1 at the route. `media.mimeType` is client-supplied on the
 * presigned upload path, so a declared `image/jpeg` gets past the candidate
 * check. The byte sniff inside `resizeMediaImage` is what has to stop it, and
 * the route then serves the stored original rather than a rasterized SVG.
 */
describe("GET /api/pods/media/[mediaId] — a lying mimeType cannot pick the decoder (LAC-5705)", () => {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">' +
      '<rect width="800" height="600" fill="red"/></svg>'
  );

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "u-1", role: "user" } });
    mocks.canView.mockReturnValue(true);
    mocks.loadStorageConfig.mockReturnValue(BLOB_CONFIG);
    // The row claims JPEG; the object is SVG.
    mocks.findFirstMedia.mockResolvedValue(readyMedia({ mimeType: "image/jpeg" }));
    mocks.loadPolicyContext.mockResolvedValue({ pod: { id: "p-1", visibility: "private" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array(svg), {
            status: 200,
            headers: { "content-type": "image/jpeg" },
          })
      )
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serves the stored original instead of rasterizing the SVG", async () => {
    const res = (await call("?w=640")) as Response;

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("content-type")).not.toBe("image/webp");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(svg));
    // Still never sniffable into something executable.
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
