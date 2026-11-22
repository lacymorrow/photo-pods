/**
 * @fileoverview Object-storage hosts that public pod media is served from,
 * shaped for `images.remotePatterns` in `next.config.ts` (LAC-5778).
 *
 * A public pod keeps its direct object URL so the browser and the CDN can
 * cache the bytes (`applyMediaUrlPolicy` in `server/services/pod-storage`).
 * Private and group pods go through `/api/pods/media/<id>` instead and never
 * reach the image optimizer's allow-list, so this file is only about the
 * public case.
 *
 * `/_next/image` answers **400** for any hostname missing from
 * `remotePatterns`, so an unlisted store host is not a degraded image. It is
 * no image at all.
 *
 * Every entry here is an exact hostname derived from our own configuration.
 * A suffix wildcard such as `*.public.blob.vercel-storage.com` would also fix
 * the 400, but it would let anyone with a Vercel Blob store use this
 * deployment as an image proxy, so it is deliberately not used.
 *
 * @module config/pod-media-hosts
 */

/**
 * Subset of `images.remotePatterns` we emit. Structurally a Next
 * `RemotePattern`; declared locally so `next.config.ts` does not have to
 * import a type out of Next's internals.
 */
export interface PodMediaRemotePattern {
  protocol: "http" | "https";
  hostname: string;
  port?: string;
}

/**
 * Public hostname of a Vercel Blob store, derived from its read/write token.
 *
 * Tokens are `vercel_blob_rw_<storeId>_<secret>` and the store serves public
 * objects from `<storeId lowercased>.public.blob.vercel-storage.com`.
 * Verified against the live production store on 2026-11-22 by comparing its
 * token's store id with the host of an object URL `vercel blob list` returned:
 * identical apart from case.
 *
 * Returns `null` for anything that is not a token of that shape, so a
 * truncated or placeholder value cannot widen the allow-list.
 */
const vercelBlobPublicHost = (token: string | undefined): string | null => {
  if (!token) return null;
  const storeId = /^vercel_blob_rw_([A-Za-z0-9]+)_[A-Za-z0-9]+$/.exec(token.trim())?.[1];
  if (!storeId) return null;
  return `${storeId.toLowerCase()}.public.blob.vercel-storage.com`;
};

/**
 * Pattern for a configured media base URL (R2 bucket CDN, S3 website, or a
 * local object-store stub in development).
 *
 * The protocol comes from the URL rather than being forced to `https` so a
 * `http://127.0.0.1:<port>` dev stub works; production values are https.
 */
const patternForBaseUrl = (value: string | undefined): PodMediaRemotePattern | null => {
  if (!value?.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    // Misconfigured env value. Ignore it rather than allow-listing a guess.
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const pattern: PodMediaRemotePattern = {
    protocol: parsed.protocol === "https:" ? "https" : "http",
    hostname: parsed.hostname,
  };
  if (parsed.port) pattern.port = parsed.port;
  return pattern;
};

/**
 * Hosts `next/image` must accept for public pod media to render.
 *
 * Sources mirror `loadStorageConfig()`: the R2/CDN base URL when object
 * storage is provisioned, plus the Vercel Blob store that the fallback upload
 * path writes to. Both are listed when both are configured, because media
 * uploaded before a cutover keeps its original host.
 *
 * Empty when nothing is configured: there is no public media to serve, and
 * an empty list is the one answer that cannot widen the allow-list by
 * accident.
 */
export const podMediaRemotePatterns = (
  env: NodeJS.ProcessEnv = process.env
): PodMediaRemotePattern[] => {
  const patterns: PodMediaRemotePattern[] = [];

  const cdn = patternForBaseUrl(env.PHOTOPODS_R2_PUBLIC_URL ?? env.PHOTOPODS_MEDIA_CDN_URL);
  if (cdn) patterns.push(cdn);

  const blobHost = vercelBlobPublicHost(
    env.BLOB_READ_WRITE_TOKEN ?? env.VERCEL_BLOB_READ_WRITE_TOKEN
  );
  if (blobHost) patterns.push({ protocol: "https", hostname: blobHost });

  return patterns.filter(
    (pattern, index) =>
      patterns.findIndex(
        (other) => other.hostname === pattern.hostname && other.port === pattern.port
      ) === index
  );
};
