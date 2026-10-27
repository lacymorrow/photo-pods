/**
 * @fileoverview Shared shape of the membership-checked pod media route.
 * @module lib/pods/media-url
 */

export const POD_MEDIA_ROUTE_PREFIX = "/api/pods/media/";

/**
 * Is this src the membership-checked media route rather than a direct object
 * URL?
 *
 * Callers need this to set `unoptimized` on `next/image`. Next's image
 * optimizer fetches a local src through an internal mocked request that
 * forwards no headers (`fetchInternalImage` → `createRequestResponseMocks`),
 * so it arrives at the route with no session cookie and the pod ACL rejects
 * it. The browser must fetch these itself. (LAC-3173.)
 */
export const isPodMediaRouteUrl = (url: string | null | undefined): boolean =>
  typeof url === "string" && url.startsWith(POD_MEDIA_ROUTE_PREFIX);
