/**
 * @fileoverview Shared shape of the membership-checked pod media route.
 * @module lib/pods/media-url
 */

export const POD_MEDIA_ROUTE_PREFIX = "/api/pods/media/";

/**
 * Is this src the membership-checked media route rather than a direct object
 * URL?
 *
 * Callers need this to pick the right `next/image` loader. Next's own image
 * optimizer fetches a local src through an internal mocked request that
 * forwards no headers (`fetchInternalImage` → `createRequestResponseMocks`),
 * so it arrives at the route with no session cookie and the pod ACL rejects
 * it. These srcs have to be fetched by the browser, which does carry the
 * cookie — see `podMediaLoader`. (LAC-3173, LAC-5698.)
 */
export const isPodMediaRouteUrl = (url: string | null | undefined): boolean =>
  typeof url === "string" && url.startsWith(POD_MEDIA_ROUTE_PREFIX);

/**
 * Widths the media route is willing to render.
 *
 * Mirrors the union of `images.imageSizes` and `images.deviceSizes` from
 * `next.config.ts`, which is the set `next/image` draws a srcset from. Keeping
 * it a fixed ladder also bounds how many distinct renders one object can be
 * asked for, so an authenticated member cannot turn `?w=` into an unbounded
 * resize treadmill.
 */
export const POD_MEDIA_WIDTHS = [
  16, 32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840,
] as const;

/** Top of `POD_MEDIA_WIDTHS`; the widest render the route will produce. */
export const POD_MEDIA_MAX_WIDTH = 3840;

export const POD_MEDIA_DEFAULT_QUALITY = 75;

/**
 * Snap a requested width up to the next rung of the ladder, so a request for
 * 401px is served the 640px render rather than refused.
 */
export const snapPodMediaWidth = (width: number): number => {
  if (!Number.isFinite(width) || width <= 0) return POD_MEDIA_MAX_WIDTH;
  return POD_MEDIA_WIDTHS.find((candidate) => candidate >= width) ?? POD_MEDIA_MAX_WIDTH;
};

/**
 * `next/image` loader for media behind the pod ACL.
 *
 * The route resizes the bytes itself (`?w=`), which is the only place the
 * resize can happen for a non-public pod: the session cookie exists in the
 * browser's request to this route and nowhere else. Passing this as the
 * `loader` prop — rather than setting `unoptimized` — is what keeps the
 * responsive srcset that `width`/`sizes` are supposed to produce.
 */
export const podMediaLoader = ({
  src,
  width,
  quality,
}: {
  src: string;
  width: number;
  quality?: number;
}): string => {
  if (!isPodMediaRouteUrl(src)) return src;
  const params = new URLSearchParams({ w: String(snapPodMediaWidth(width)) });
  const q = quality ?? POD_MEDIA_DEFAULT_QUALITY;
  if (q !== POD_MEDIA_DEFAULT_QUALITY) params.set("q", String(q));
  return `${src}?${params.toString()}`;
};

/**
 * Parse the `?w=` the loader produced back into a ladder width.
 *
 * Returns `null` when no resize was asked for, which the route serves as the
 * untouched original.
 */
export const parsePodMediaWidth = (raw: string | null): number | null => {
  if (raw === null || raw.trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return snapPodMediaWidth(parsed);
};

/** Parse `?q=`, clamped to a sane encoder range. */
export const parsePodMediaQuality = (raw: string | null): number => {
  if (raw === null || raw.trim() === "") return POD_MEDIA_DEFAULT_QUALITY;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return POD_MEDIA_DEFAULT_QUALITY;
  return Math.min(100, Math.max(1, Math.round(parsed)));
};
