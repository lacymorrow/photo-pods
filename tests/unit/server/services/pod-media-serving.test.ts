import { describe, expect, it, vi } from "vitest";

import { type StorageConfig, planMediaServe } from "@/server/services/pod-storage";

const BLOB_CONFIG: StorageConfig = {
  provider: "vercel-blob",
  bucket: null,
  publicBaseUrl: null,
  accessKeyId: null,
  secretAccessKey: null,
  endpoint: null,
  region: "auto",
};

const R2_CONFIG: StorageConfig = {
  provider: "r2",
  bucket: "photopods",
  publicBaseUrl: "https://cdn.photopods.app",
  accessKeyId: "ak",
  secretAccessKey: "sk",
  endpoint: "https://acct.r2.cloudflarestorage.com",
  region: "auto",
};

const R2_NO_CDN: StorageConfig = { ...R2_CONFIG, publicBaseUrl: null };

const BLOB_URL = "https://store123.public.blob.vercel-storage.com/pods/p-1/1700000000-a.jpg";

/**
 * The hole this guards (LAC-3173): the legacy `uploadPhoto` path stores every
 * photo at a long-lived public blob URL. Redirecting a private/group pod's
 * viewer to that URL makes the membership check decorative — the URL keeps
 * working for anyone who ever sees it, with no pod ACL in front of it.
 *
 * So: a non-public pod must never be handed a long-lived storage URL. Either
 * the bytes are proxied through the membership-checked route, or the viewer
 * gets a short-lived presigned URL.
 */
describe("planMediaServe — non-public pods never get a long-lived storage URL (LAC-3173)", () => {
  const presignGet = vi.fn(
    (key: string) => `https://acct.r2.cloudflarestorage.com/${key}?X-Amz-Signature=deadbeef`
  );

  for (const visibility of ["private", "group"] as const) {
    it(`proxies legacy blob-url media for a ${visibility} pod instead of redirecting`, () => {
      const plan = planMediaServe({
        visibility,
        storageKey: null,
        url: BLOB_URL,
        config: BLOB_CONFIG,
        presignGet: () => null,
      });

      expect(plan).toEqual({ kind: "stream", url: BLOB_URL });
    });

    it(`never emits the raw storage URL for a ${visibility} pod even when a storageKey exists`, () => {
      const plan = planMediaServe({
        visibility,
        storageKey: "pods/p-1/photos/m-1.jpg",
        url: BLOB_URL,
        config: R2_CONFIG,
        presignGet,
      });

      // A presigned URL is acceptable (short-lived, expires); the bare CDN
      // URL is not, even though R2_CONFIG has a publicBaseUrl.
      expect(plan.kind).toBe("redirect");
      if (plan.kind !== "redirect") throw new Error("unreachable");
      expect(plan.url).toContain("X-Amz-Signature=");
      expect(plan.url).not.toBe(`${R2_CONFIG.publicBaseUrl}/pods/p-1/photos/m-1.jpg`);
    });

    it(`proxies rather than leaking the blob URL when presigning is unavailable for a ${visibility} pod`, () => {
      const plan = planMediaServe({
        visibility,
        storageKey: "pods/p-1/photos/m-1.jpg",
        url: BLOB_URL,
        config: R2_NO_CDN,
        // Presigning can fail (misconfigured endpoint) — must not fall back
        // to the public URL.
        presignGet: () => null,
      });

      expect(plan).toEqual({ kind: "stream", url: BLOB_URL });
    });

    it(`reports not_found for a ${visibility} pod with no url and no key`, () => {
      expect(
        planMediaServe({
          visibility,
          storageKey: null,
          url: null,
          config: BLOB_CONFIG,
          presignGet: () => null,
        })
      ).toEqual({ kind: "not_found" });
    });
  }
});

/**
 * The media route fetches `stream` URLs server-side, so the planner must not
 * hand it an arbitrary host. Nothing user-supplied reaches `podMedia.url`
 * today; this keeps the proxy from depending on that silently.
 */
describe("planMediaServe — only our own storage is proxied", () => {
  const cases: Array<[string, string]> = [
    ["an attacker-controlled host", "https://evil.example.com/pods/p-1/a.jpg"],
    ["link-local metadata", "https://169.254.169.254/latest/meta-data/"],
    ["plain http", "http://store123.public.blob.vercel-storage.com/pods/p-1/a.jpg"],
    ["a non-http scheme", "file:///etc/passwd"],
    ["a lookalike suffix", "https://blob.vercel-storage.com.evil.example.com/a.jpg"],
    ["garbage", "not-a-url"],
  ];

  for (const [label, url] of cases) {
    it(`refuses to proxy ${label}`, () => {
      expect(
        planMediaServe({
          visibility: "private",
          storageKey: null,
          url,
          config: BLOB_CONFIG,
          presignGet: () => null,
        })
      ).toEqual({ kind: "not_found" });
    });
  }

  it("proxies the configured R2 endpoint host", () => {
    expect(
      planMediaServe({
        visibility: "private",
        storageKey: null,
        url: "https://acct.r2.cloudflarestorage.com/photopods/pods/p-1/a.jpg",
        config: R2_CONFIG,
        presignGet: () => null,
      })
    ).toEqual({
      kind: "stream",
      url: "https://acct.r2.cloudflarestorage.com/photopods/pods/p-1/a.jpg",
    });
  });

  it("proxies the configured CDN host", () => {
    expect(
      planMediaServe({
        visibility: "private",
        storageKey: null,
        url: "https://cdn.photopods.app/pods/p-1/a.jpg",
        config: R2_CONFIG,
        presignGet: () => null,
      }).kind
    ).toBe("stream");
  });

  it("proxies a private-access blob host", () => {
    expect(
      planMediaServe({
        visibility: "private",
        storageKey: null,
        url: "https://store123.private.blob.vercel-storage.com/pods/p-1/a.jpg",
        config: BLOB_CONFIG,
        presignGet: () => null,
      }).kind
    ).toBe("stream");
  });
});

describe("planMediaServe — public pods still redirect so the CDN can cache", () => {
  it("redirects to the CDN URL when the bucket is public", () => {
    const plan = planMediaServe({
      visibility: "public",
      storageKey: "pods/p-1/photos/m-1.jpg",
      url: null,
      config: R2_CONFIG,
      presignGet: () => null,
    });

    expect(plan).toEqual({
      kind: "redirect",
      url: "https://cdn.photopods.app/pods/p-1/photos/m-1.jpg",
    });
  });

  it("redirects to the legacy blob url for a public pod on the blob fallback", () => {
    const plan = planMediaServe({
      visibility: "public",
      storageKey: null,
      url: BLOB_URL,
      config: BLOB_CONFIG,
      presignGet: () => null,
    });

    expect(plan).toEqual({ kind: "redirect", url: BLOB_URL });
  });

  it("falls back to a presigned URL for a public pod on a bucket with no CDN", () => {
    const plan = planMediaServe({
      visibility: "public",
      storageKey: "pods/p-1/photos/m-1.jpg",
      url: null,
      config: R2_NO_CDN,
      presignGet: (key) => `https://acct.r2.cloudflarestorage.com/${key}?X-Amz-Signature=abc`,
    });

    expect(plan.kind).toBe("redirect");
  });

  it("reports not_found for a public pod with nothing to serve", () => {
    expect(
      planMediaServe({
        visibility: "public",
        storageKey: null,
        url: null,
        config: BLOB_CONFIG,
        presignGet: () => null,
      })
    ).toEqual({ kind: "not_found" });
  });
});
