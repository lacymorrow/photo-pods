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

/**
 * Canonical UUID shape, case-insensitive on the hex digits.
 *
 * Every `podMedia.id` is a `crypto.randomUUID()` written into a Postgres
 * `uuid` column, so this is the only form the route ever has to match. It is
 * narrower than what Postgres itself accepts (braces, hyphen-less) and that is
 * deliberate: we only need to recognise ids we could have minted.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Could this path segment be a media id?
 *
 * Without this, `eq(podMedia.id, mediaId)` hands a non-UUID straight to
 * Postgres, which raises `invalid input syntax for type uuid` and the route
 * answers 500 with an empty body instead of 404. Checking the shape in front
 * of the query keeps a genuine database failure loud — a `catch` around the
 * lookup would turn an outage into a quiet "not found". (LAC-5696.)
 */
export const isPodMediaId = (value: string): boolean => UUID_RE.test(value);
