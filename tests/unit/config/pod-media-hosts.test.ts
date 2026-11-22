/**
 * @fileoverview Public pod media has to be reachable through `next/image`.
 *
 * A public pod serves its photos from the raw object URL so the CDN can cache
 * them (`applyMediaUrlPolicy`). That src goes through `/_next/image`, which
 * validates the hostname against `images.remotePatterns` and answers **400**
 * for a host it does not recognise. Before LAC-5778 no object-store host was
 * listed at all, so every public-pod photo 400'd.
 *
 * These tests pin both halves: the host the app emits, and the host the image
 * optimizer will accept. A future storage change that moves one without the
 * other fails here instead of in the browser.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { podMediaRemotePatterns } from "@/config/pod-media-hosts";
import { loadStorageConfig, publicUrlForKey } from "@/server/services/pod-storage";

/**
 * Shape of a Vercel Blob read/write token: `vercel_blob_rw_<storeId>_<secret>`.
 * Store id and secret here are invented; only the shape matters.
 */
const BLOB_TOKEN = "vercel_blob_rw_aBcD1234eFgH5678_notarealsecretvalue";
const BLOB_HOST = "abcd1234efgh5678.public.blob.vercel-storage.com";

const hostnames = (env: NodeJS.ProcessEnv) =>
  podMediaRemotePatterns(env).map((pattern) => pattern.hostname);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("podMediaRemotePatterns", () => {
  it("allows the Vercel Blob store the fallback upload path writes to", () => {
    // Measured against the live store on 2026-11-22: the public host is the
    // token's store id, lowercased, under `.public.blob.vercel-storage.com`.
    expect(hostnames({ BLOB_READ_WRITE_TOKEN: BLOB_TOKEN } as NodeJS.ProcessEnv)).toEqual([
      BLOB_HOST,
    ]);
  });

  it("reads the blob token under either of the names this app accepts", () => {
    expect(hostnames({ VERCEL_BLOB_READ_WRITE_TOKEN: BLOB_TOKEN } as NodeJS.ProcessEnv)).toEqual([
      BLOB_HOST,
    ]);
  });

  it("allows the configured media CDN host", () => {
    expect(
      hostnames({ PHOTOPODS_R2_PUBLIC_URL: "https://media.example.com/pods" } as NodeJS.ProcessEnv)
    ).toEqual(["media.example.com"]);
    expect(
      hostnames({ PHOTOPODS_MEDIA_CDN_URL: "https://cdn.example.com" } as NodeJS.ProcessEnv)
    ).toEqual(["cdn.example.com"]);
  });

  it("keeps the protocol of the configured CDN URL, so an http dev stub works", () => {
    expect(
      podMediaRemotePatterns({
        PHOTOPODS_MEDIA_CDN_URL: "http://127.0.0.1:4566/pods",
      } as NodeJS.ProcessEnv)
    ).toEqual([{ protocol: "http", hostname: "127.0.0.1", port: "4566" }]);
  });

  it("lists both hosts while the blob fallback is still reachable", () => {
    expect(
      hostnames({
        PHOTOPODS_R2_PUBLIC_URL: "https://media.example.com",
        BLOB_READ_WRITE_TOKEN: BLOB_TOKEN,
      } as NodeJS.ProcessEnv)
    ).toEqual(["media.example.com", BLOB_HOST]);
  });

  it("adds nothing when no object store is configured", () => {
    expect(podMediaRemotePatterns({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("ignores a malformed CDN URL or blob token rather than guessing a host", () => {
    expect(
      podMediaRemotePatterns({
        PHOTOPODS_R2_PUBLIC_URL: "not a url",
        BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_",
      } as NodeJS.ProcessEnv)
    ).toEqual([]);
  });

  it("never widens to a wildcard, which would make us an open image proxy", () => {
    const patterns = podMediaRemotePatterns({
      PHOTOPODS_R2_PUBLIC_URL: "https://media.example.com",
      BLOB_READ_WRITE_TOKEN: BLOB_TOKEN,
    } as NodeJS.ProcessEnv);

    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) {
      expect(pattern.hostname).not.toContain("*");
    }
  });
});

describe("the host the app emits is the host next/image accepts", () => {
  it("matches publicUrlForKey's output when a CDN is configured", () => {
    vi.stubEnv("PHOTOPODS_R2_PUBLIC_URL", "https://media.example.com/pods");
    vi.stubEnv("PHOTOPODS_R2_BUCKET", "photopods");
    vi.stubEnv("PHOTOPODS_R2_ACCESS_KEY_ID", "key");
    vi.stubEnv("PHOTOPODS_R2_SECRET_ACCESS_KEY", "secret");

    const url = publicUrlForKey(loadStorageConfig(), "pods/p-1/photos/m-1.jpg");
    expect(url).not.toBeNull();

    const emitted = new URL(url as string);
    expect(podMediaRemotePatterns(process.env)).toContainEqual(
      expect.objectContaining({ protocol: "https", hostname: emitted.hostname })
    );
  });
});
