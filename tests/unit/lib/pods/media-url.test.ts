import { describe, expect, it } from "vitest";

import { POD_MEDIA_ROUTE_PREFIX, isPodMediaRouteUrl } from "@/lib/pods/media-url";
import { mediaRouteUrl } from "@/server/services/pod-storage";

describe("isPodMediaRouteUrl", () => {
  it("recognises what mediaRouteUrl produces", () => {
    // The two must not drift: the server decides the path, the client decides
    // whether to bypass the image optimizer based on it (LAC-3173).
    expect(isPodMediaRouteUrl(mediaRouteUrl("m-1"))).toBe(true);
    expect(mediaRouteUrl("m-1")).toBe(`${POD_MEDIA_ROUTE_PREFIX}m-1`);
  });

  it("rejects direct object URLs", () => {
    expect(
      isPodMediaRouteUrl("https://store123.public.blob.vercel-storage.com/pods/p-1/a.jpg")
    ).toBe(false);
    expect(isPodMediaRouteUrl("https://cdn.photopods.app/pods/p-1/a.jpg")).toBe(false);
  });

  it("rejects empty values", () => {
    expect(isPodMediaRouteUrl(null)).toBe(false);
    expect(isPodMediaRouteUrl(undefined)).toBe(false);
    expect(isPodMediaRouteUrl("")).toBe(false);
  });

  it("does not match a lookalike absolute URL", () => {
    expect(isPodMediaRouteUrl("https://evil.example.com/api/pods/media/m-1")).toBe(false);
  });
});
