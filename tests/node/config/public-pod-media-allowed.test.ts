/**
 * @fileoverview The derived public-media hosts have to reach the real
 * `images.remotePatterns`, not just exist in a module nobody imports.
 *
 * `src/config/pod-media-hosts.ts` is unit-tested on its own; this test is the
 * wiring. Before LAC-5778 `next.config.ts` listed no object-store host, so
 * every public-pod photo 400'd at `/_next/image`. Deleting the spread in
 * `next.config.ts` brings that back, and this is what notices.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";

import { podMediaRemotePatterns } from "@/config/pod-media-hosts";

const BLOB_TOKEN = "vercel_blob_rw_aBcD1234eFgH5678_notarealsecretvalue";
const CDN_URL = "https://media.example.com/pods";

interface RemotePatternLike {
  protocol?: string;
  hostname: string;
  port?: string;
}

let remotePatterns: RemotePatternLike[];

beforeAll(async () => {
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", BLOB_TOKEN);
  vi.stubEnv("PHOTOPODS_R2_PUBLIC_URL", CDN_URL);

  // Imported after the env is stubbed: next.config.ts builds its images config
  // at module scope.
  const config = (await import("../../../next.config")).default as {
    images?: { remotePatterns?: RemotePatternLike[] };
  };
  remotePatterns = config.images?.remotePatterns ?? [];
});

describe("next.config images.remotePatterns", () => {
  it("includes every host public pod media is served from", () => {
    const derived = podMediaRemotePatterns({
      BLOB_READ_WRITE_TOKEN: BLOB_TOKEN,
      PHOTOPODS_R2_PUBLIC_URL: CDN_URL,
    } as NodeJS.ProcessEnv);

    expect(derived.length).toBe(2);
    for (const pattern of derived) {
      expect(remotePatterns).toContainEqual(expect.objectContaining(pattern));
    }
  });

  it("does not allow an arbitrary third-party blob store", () => {
    for (const pattern of remotePatterns) {
      if (!pattern.hostname.endsWith("blob.vercel-storage.com")) continue;
      expect(pattern.hostname).not.toContain("*");
    }
  });
});
