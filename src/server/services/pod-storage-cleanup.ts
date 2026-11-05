/**
 * @fileoverview GDPR-driven cleanup of R2 objects owned by deleted media / pods
 * / users (LAC-2917 H2).
 *
 * The DB delete is authoritative: rows are removed inside a transaction, then
 * we issue best-effort DELETEs against object storage. Anything that fails is
 * pushed onto `pod_storage_delete_queue` for a background worker to retry
 * (LAC-2855 §3). Public keys are additionally purged from the CDN so a stale
 * edge cache can't keep the object visible after erasure.
 *
 * @module server/services/pod-storage-cleanup
 */

import { and, inArray, notInArray, or } from "drizzle-orm";
import { env } from "@/env";
import { db } from "@/server/db";
import { type PodMedia, podMedia, podStorageDeleteQueue, pods } from "@/server/db/pods-schema";
import { deleteObject, loadStorageConfig, publicUrlForKey } from "@/server/services/pod-storage";

/**
 * Collect every storage target associated with a media row: the original key
 * plus any precomputed variants, and any legacy Vercel Blob URL (LAC-6923).
 *
 * The legacy `url` / `thumbnailUrl` columns are written by the pre-R2 upload
 * path, which still runs whenever R2 is not configured, so this is live and not
 * only old rows. A blob URL is returned as-is among the keys; R2 keys never
 * start with `https://`, and `deleteObjectsWithRetry` routes on that. The
 * `uploadFile` fallback (LAC-6927) writes an S3 URL for the `AWS_BUCKET_NAME`
 * bucket instead, which is kept too and deleted through the S3 client. Hosts
 * that are neither are skipped: nothing here can delete them.
 */
export const collectMediaKeys = (
  media: Pick<PodMedia, "storageKey" | "variants"> & Partial<Pick<PodMedia, "url" | "thumbnailUrl">>
): string[] => {
  const keys: string[] = [];
  for (const legacy of new Set([media.url, media.thumbnailUrl])) {
    if (legacy && (isVercelBlobUrl(legacy) || legacyS3KeyFromUrl(legacy) !== null)) {
      keys.push(legacy);
    }
  }
  if (media.storageKey) keys.push(media.storageKey);
  const variants = media.variants ?? null;
  if (variants) {
    for (const value of Object.values(variants)) {
      if (typeof value === "string" && value.length > 0) keys.push(value);
    }
  }
  return keys;
};

/**
 * True when a Blob URL's path sits under `pods/<podId>/`, the prefix
 * `uploadPhoto` writes. Decoded and segment-checked so `..` cannot walk out.
 */
const isUnderPodPrefix = (value: string, podId: string): boolean => {
  try {
    const path = decodeURIComponent(new URL(value).pathname).slice(1).split("/");
    return path[0] === "pods" && path[1] === podId && path.length > 2 && !path.includes("..");
  } catch {
    return false;
  }
};

/**
 * Cover URLs that are safe to erase with their pod (LAC-6927, LAC-7037 H1).
 *
 * `updatePod` stores `coverPhotoUrl` as the caller typed it, so the column can
 * point at any object, including one that belongs to another user. A cover is
 * erased only when it is provably this pod's own: a Vercel Blob URL under
 * `pods/<podId>/`, or equal to a url/thumbnailUrl of this pod's media rows
 * (`ownMediaUrls`). It is then dropped if any pod or media row outside
 * `deletedPodIds` still references it. S3 covers are never added here: a cover
 * that is also a media url is already collected from the media row, and a
 * cover-only S3 url has no proof of ownership. Returns Blob URLs only.
 */
export const collectOwnCoverTargets = async (
  ownedPods: ReadonlyArray<{ id: string; coverPhotoUrl: string | null }>,
  ownMediaUrls: Iterable<string | null | undefined>
): Promise<string[]> => {
  const own = new Set<string>();
  for (const u of ownMediaUrls) if (u) own.add(u);
  const candidates = new Set<string>();
  for (const p of ownedPods) {
    const cover = p.coverPhotoUrl;
    if (!cover || !isVercelBlobUrl(cover)) continue;
    if (own.has(cover) || isUnderPodPrefix(cover, p.id)) candidates.add(cover);
  }
  if (candidates.size === 0 || !db) return [];

  const list = [...candidates];
  const deletedPodIds = ownedPods.map((p) => p.id);
  // Fail closed: if the reference lookup throws, erase nothing extra.
  try {
    const [coverRefs, mediaRefs] = await Promise.all([
      db
        .select({ url: pods.coverPhotoUrl })
        .from(pods)
        .where(
          // notInArray is only safe with a non-empty list; ownedPods is non-empty here.
          and(inArray(pods.coverPhotoUrl, list), notInArray(pods.id, deletedPodIds))
        ),
      db
        .select({ url: podMedia.url, thumbnailUrl: podMedia.thumbnailUrl })
        .from(podMedia)
        .where(
          and(
            or(inArray(podMedia.url, list), inArray(podMedia.thumbnailUrl, list)),
            notInArray(podMedia.podId, deletedPodIds)
          )
        ),
    ]);
    const shared = new Set<string>();
    for (const r of coverRefs) if (r.url) shared.add(r.url);
    for (const r of mediaRefs) {
      if (r.url) shared.add(r.url);
      if (r.thumbnailUrl) shared.add(r.thumbnailUrl);
    }
    return list.filter((u) => !shared.has(u));
  } catch (err) {
    console.error("[pod-storage-cleanup] cover reference check failed", err);
    return [];
  }
};

/** Queue `reason` for a legacy Vercel Blob URL (vs the default R2 key delete). */
export const BLOB_URL_QUEUE_REASON = "blob-url";

/** Queue `reason` for a legacy `uploadFile` S3 URL. */
export const S3_URL_QUEUE_REASON = "s3-url";

/**
 * Map an `uploadFile` S3 URL back to its object key, or null when the URL is
 * not in the configured `AWS_BUCKET_NAME` bucket. `uploadFile` stores the
 * presigned URL minus its query string, so the key is the decoded path
 * (virtual-hosted style) or the path after the bucket segment (path style).
 */
export const legacyS3KeyFromUrl = (value: string): string | null => {
  const bucket = env.AWS_BUCKET_NAME;
  if (!bucket) return null;
  try {
    const { hostname, protocol, pathname } = new URL(value);
    if (protocol !== "https:") return null;
    const isAws = hostname.endsWith(".amazonaws.com");
    if (!isAws) return null;
    let path: string;
    if (hostname.startsWith(`${bucket}.s3.`) || hostname.startsWith(`${bucket}.s3-`)) {
      path = pathname.slice(1);
    } else if (/^s3[.-]/.test(hostname) && pathname.startsWith(`/${bucket}/`)) {
      path = pathname.slice(bucket.length + 2);
    } else {
      return null;
    }
    const key = decodeURIComponent(path);
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
};

const isVercelBlobUrl = (value: string): boolean => {
  try {
    const { hostname, protocol } = new URL(value);
    return protocol === "https:" && hostname.endsWith(".blob.vercel-storage.com");
  } catch {
    return false;
  }
};

const enqueueRetries = async (keys: string[], reason?: string): Promise<void> => {
  if (!db || keys.length === 0) return;
  try {
    await db
      .insert(podStorageDeleteQueue)
      .values(keys.map((storageKey) => (reason ? { storageKey, reason } : { storageKey })));
  } catch (err) {
    console.error("[pod-storage-cleanup] failed to enqueue retry", err);
  }
};

/**
 * Fire-and-forget delete of a batch of object keys. Anything that doesn't
 * succeed is queued for retry. Never throws — GDPR delete must not be blocked
 * by a transient storage error.
 */
export const deleteObjectsWithRetry = async (
  targets: readonly string[]
): Promise<{ deleted: string[]; queued: string[] }> => {
  const blobUrls = targets.filter(isVercelBlobUrl);
  const s3Urls = targets.filter((t) => !isVercelBlobUrl(t) && legacyS3KeyFromUrl(t) !== null);
  const keys = targets.filter((t) => !isVercelBlobUrl(t) && !s3Urls.includes(t));
  const blob = await deleteBlobUrls(blobUrls);
  const s3 = await deleteS3Urls(s3Urls);
  const r2 = await deleteKeys(keys);
  return {
    deleted: [...r2.deleted, ...blob.deleted, ...s3.deleted],
    queued: [...r2.queued, ...blob.queued, ...s3.queued],
  };
};

/** Legacy Vercel Blob objects, by URL. `del` needs BLOB_READ_WRITE_TOKEN and throws without it. */
const deleteBlobUrls = async (urls: string[]): Promise<{ deleted: string[]; queued: string[] }> => {
  if (urls.length === 0) return { deleted: [], queued: [] };
  try {
    const { del } = await import("@vercel/blob");
    await del(urls);
    return { deleted: urls, queued: [] };
  } catch (err) {
    console.warn(
      "[pod-storage-cleanup] vercel blob delete failed",
      JSON.stringify({ count: urls.length, error: String(err) })
    );
    await enqueueRetries(urls, BLOB_URL_QUEUE_REASON);
    return { deleted: [], queued: urls };
  }
};

/** Legacy `uploadFile` objects. `deleteFromS3` throws when S3 is disabled or the delete fails. */
const deleteS3Urls = async (urls: string[]): Promise<{ deleted: string[]; queued: string[] }> => {
  if (urls.length === 0) return { deleted: [], queued: [] };
  const { deleteFromS3 } = await import("@/server/services/s3");
  const deleted: string[] = [];
  const failed: string[] = [];
  for (const url of urls) {
    const key = legacyS3KeyFromUrl(url);
    try {
      if (!key) throw new Error("no key");
      await deleteFromS3(key);
      deleted.push(url);
    } catch (err) {
      console.warn(
        "[pod-storage-cleanup] s3 delete failed",
        JSON.stringify({ url, error: String(err) })
      );
      failed.push(url);
    }
  }
  if (failed.length > 0) await enqueueRetries(failed, S3_URL_QUEUE_REASON);
  return { deleted, queued: failed };
};

const deleteKeys = async (keys: string[]): Promise<{ deleted: string[]; queued: string[] }> => {
  if (keys.length === 0) return { deleted: [], queued: [] };
  const config = loadStorageConfig();
  // No S3-compatible storage configured yet — everything goes to the queue
  // so the worker can drain once R2 is provisioned.
  if (config.provider === "vercel-blob" || !config.bucket) {
    if (keys.length > 0) await enqueueRetries([...keys]);
    return { deleted: [], queued: [...keys] };
  }

  const deleted: string[] = [];
  const failed: string[] = [];
  const publicKeys: string[] = [];

  // Serial to avoid opening dozens of sockets per pod delete. R2 caps
  // concurrent DELETEs; this stays well under.
  for (const key of keys) {
    const result = await deleteObject(config, key);
    if (result.ok) {
      deleted.push(key);
      if (publicUrlForKey(config, key)) publicKeys.push(key);
    } else {
      failed.push(key);
      console.warn(
        "[pod-storage-cleanup] delete failed",
        JSON.stringify({ key, status: result.status, error: result.error })
      );
    }
  }

  if (failed.length > 0) await enqueueRetries(failed);
  if (publicKeys.length > 0) await purgeCdnCache(publicKeys);

  return { deleted, queued: failed };
};

// --- CDN purge (Cloudflare) ---

/**
 * Cloudflare cache purge — best effort. Only runs when
 * `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_API_TOKEN` are set and the media had
 * a resolvable public URL. Public objects served through the R2 custom
 * domain / Cloudflare are cached at the edge; without a purge, a deleted
 * photo can remain retrievable for hours.
 */
const purgeCdnCache = async (keys: string[]): Promise<void> => {
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!zoneId || !apiToken || keys.length === 0) return;

  const config = loadStorageConfig();
  const files = keys
    .map((key) => publicUrlForKey(config, key))
    .filter((url): url is string => Boolean(url));
  if (files.length === 0) return;

  try {
    // Cloudflare purge-by-URL: max 30 URLs per call for free plans;
    // chunk defensively.
    for (let i = 0; i < files.length; i += 30) {
      const chunk = files.slice(i, i + 30);
      const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ files: chunk }),
      });
      if (!res.ok) {
        console.warn(
          "[pod-storage-cleanup] cdn purge failed",
          res.status,
          await res.text().catch(() => "")
        );
      }
    }
  } catch (err) {
    console.warn("[pod-storage-cleanup] cdn purge threw", err);
  }
};
