import { describe, expect, it } from "vitest";

import {
  POD_MEDIA_DEFAULT_QUALITY,
  POD_MEDIA_MAX_WIDTH,
  POD_MEDIA_ROUTE_PREFIX,
  POD_MEDIA_WIDTHS,
  isPodMediaRouteUrl,
  parsePodMediaQuality,
  parsePodMediaWidth,
  podMediaLoader,
  snapPodMediaWidth,
} from "@/lib/pods/media-url";
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

describe("podMediaLoader — resized URLs stay inside the ACL'd route (LAC-5698)", () => {
  it("asks the media route for a ladder width rather than the original", () => {
    expect(podMediaLoader({ src: mediaRouteUrl("m-1"), width: 400 })).toBe(
      "/api/pods/media/m-1?w=640"
    );
  });

  it("snaps an off-ladder width up so the request is never refused", () => {
    expect(snapPodMediaWidth(1)).toBe(16);
    expect(snapPodMediaWidth(129)).toBe(256);
    expect(snapPodMediaWidth(640)).toBe(640);
    expect(snapPodMediaWidth(99999)).toBe(3840);
  });

  it("only emits q when it differs from the default", () => {
    const src = mediaRouteUrl("m-1");
    expect(podMediaLoader({ src, width: 640, quality: POD_MEDIA_DEFAULT_QUALITY })).toBe(
      "/api/pods/media/m-1?w=640"
    );
    expect(podMediaLoader({ src, width: 640, quality: 50 })).toBe("/api/pods/media/m-1?w=640&q=50");
  });

  /**
   * The loader must not become a way to point `next/image` at something else.
   * It is only ever installed for route-shaped srcs, but keep it inert if that
   * ever slips.
   */
  it("passes a non-route src through untouched", () => {
    const direct = "https://cdn.photopods.app/pods/p-1/a.jpg";
    expect(podMediaLoader({ src: direct, width: 640 })).toBe(direct);
  });

  /**
   * The route's parse has to accept exactly what the loader produces, or the
   * grid silently falls back to serving originals again — the regression this
   * ticket exists to fix.
   */
  it("round-trips every ladder width through the route's parser", () => {
    for (const width of POD_MEDIA_WIDTHS) {
      const url = new URL(podMediaLoader({ src: mediaRouteUrl("m-1"), width }), "https://x.test");
      expect(parsePodMediaWidth(url.searchParams.get("w"))).toBe(width);
    }
  });

  it("treats a missing or junk width as no resize requested", () => {
    expect(parsePodMediaWidth(null)).toBeNull();
    expect(parsePodMediaWidth("")).toBeNull();
    expect(parsePodMediaWidth("abc")).toBeNull();
    expect(parsePodMediaWidth("-5")).toBeNull();
    expect(parsePodMediaWidth("0")).toBeNull();
  });

  it("clamps quality into an encoder range", () => {
    expect(parsePodMediaQuality(null)).toBe(POD_MEDIA_DEFAULT_QUALITY);
    expect(parsePodMediaQuality("abc")).toBe(POD_MEDIA_DEFAULT_QUALITY);
    expect(parsePodMediaQuality("0")).toBe(1);
    expect(parsePodMediaQuality("5000")).toBe(100);
    expect(parsePodMediaQuality("60")).toBe(60);
  });
});

describe("POD_MEDIA_WIDTHS", () => {
  it("is sorted ascending and tops out at POD_MEDIA_MAX_WIDTH", () => {
    expect([...POD_MEDIA_WIDTHS]).toEqual([...POD_MEDIA_WIDTHS].sort((a, b) => a - b));
    expect(POD_MEDIA_WIDTHS.at(-1)).toBe(POD_MEDIA_MAX_WIDTH);
  });
});
