/**
 * @fileoverview GDPR-driven cleanup of storage objects owned by deleted media /
 * pods / users (LAC-2917 H2).
 *
 * The DB delete is authoritative: rows are removed inside a transaction, then
 * we issue best-effort DELETEs against object storage. Anything that fails is
 * pushed onto `pod_storage_delete_queue` for a background worker to retry
 * (LAC-2855 §3). Public keys are additionally purged from the CDN so a stale
 * edge cache can't keep the object visible after erasure.
 *
 * Two storage backends can hold user uploads:
 *   1. R2 (current) — addressed by `storageKey` + variant keys.
 *   2. Vercel Blob (legacy) — addressed by full `url`. Deleted through the
 *      `@vercel/blob` SDK. Prod has no legacy rows today, but the code path
 *      exists so any surviving row erases cleanly (LAC-2930).
 *
 * @module server/services/pod-storage-cleanup
 */

import { db } from "@/server/db";
import { type PodMedia, podStorageDeleteQueue } from "@/server/db/pods-schema";
import {
	deleteObject,
	loadStorageConfig,
	publicUrlForKey,
} from "@/server/services/pod-storage";

/**
 * A single cleanup destination for a media row. Split by kind so callers can
 * route each to the correct delete backend (R2 vs Vercel Blob).
 */
export type MediaCleanupTarget =
	| { kind: "storage-key"; value: string }
	| { kind: "blob-url"; value: string };

const BLOB_URL_QUEUE_REASON = "blob-url";

/**
 * Collect every storage destination associated with a media row: the R2
 * original + variants, plus any legacy Vercel Blob `url` (LAC-2930). Without
 * the `url` branch, GDPR erasure would leave legacy blob objects behind.
 */
export const collectMediaKeys = (
	media: Pick<PodMedia, "storageKey" | "variants" | "url">,
): MediaCleanupTarget[] => {
	const targets: MediaCleanupTarget[] = [];
	if (media.storageKey) {
		targets.push({ kind: "storage-key", value: media.storageKey });
	}
	const variants = media.variants ?? null;
	if (variants) {
		for (const value of Object.values(variants)) {
			if (typeof value === "string" && value.length > 0) {
				targets.push({ kind: "storage-key", value });
			}
		}
	}
	if (media.url && looksLikeBlobUrl(media.url)) {
		targets.push({ kind: "blob-url", value: media.url });
	}
	return targets;
};

/**
 * Only enqueue delete for URLs that plausibly point at Vercel Blob storage.
 * Anything else (e.g. an unrelated CDN URL that happened to be stored in
 * `url`) would just throw inside `@vercel/blob` `del` and clutter the queue.
 */
const looksLikeBlobUrl = (url: string): boolean => {
	try {
		const { hostname, protocol } = new URL(url);
		if (protocol !== "https:" && protocol !== "http:") return false;
		return (
			hostname.endsWith(".public.blob.vercel-storage.com") ||
			hostname.endsWith(".blob.vercel-storage.com")
		);
	} catch {
		return false;
	}
};

const enqueueRetries = async (
	entries: Array<{ storageKey: string; reason: string }>,
): Promise<void> => {
	if (!db || entries.length === 0) return;
	try {
		await db.insert(podStorageDeleteQueue).values(entries);
	} catch (err) {
		console.error("[pod-storage-cleanup] failed to enqueue retry", err);
	}
};

/**
 * Fire-and-forget delete of a batch of cleanup targets. Anything that doesn't
 * succeed is queued for retry. Never throws — GDPR delete must not be blocked
 * by a transient storage error.
 */
export const deleteObjectsWithRetry = async (
	targets: readonly MediaCleanupTarget[],
): Promise<{ deleted: string[]; queued: string[] }> => {
	if (targets.length === 0) return { deleted: [], queued: [] };

	const storageKeys: string[] = [];
	const blobUrls: string[] = [];
	for (const target of targets) {
		if (target.kind === "storage-key") storageKeys.push(target.value);
		else blobUrls.push(target.value);
	}

	const [r2Result, blobResult] = await Promise.all([
		deleteStorageKeys(storageKeys),
		deleteBlobUrls(blobUrls),
	]);

	return {
		deleted: [...r2Result.deleted, ...blobResult.deleted],
		queued: [...r2Result.queued, ...blobResult.queued],
	};
};

const deleteStorageKeys = async (
	keys: string[],
): Promise<{ deleted: string[]; queued: string[] }> => {
	if (keys.length === 0) return { deleted: [], queued: [] };

	const config = loadStorageConfig();
	// No S3-compatible storage configured yet — everything goes to the queue
	// so the worker can drain once R2 is provisioned.
	if (config.provider === "vercel-blob" || !config.bucket) {
		await enqueueRetries(
			keys.map((storageKey) => ({ storageKey, reason: "delete" })),
		);
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
				JSON.stringify({ key, status: result.status, error: result.error }),
			);
		}
	}

	if (failed.length > 0) {
		await enqueueRetries(
			failed.map((storageKey) => ({ storageKey, reason: "delete" })),
		);
	}
	if (publicKeys.length > 0) await purgeCdnCache(publicKeys);

	return { deleted, queued: failed };
};

/**
 * Delete legacy Vercel Blob uploads via the `@vercel/blob` SDK. `del` accepts
 * an array of URLs and treats an unknown blob as success, so we don't need
 * per-URL retry sequencing. On failure we queue the URLs with the
 * `blob-url` reason so the worker can distinguish them from R2 keys.
 */
const deleteBlobUrls = async (
	urls: string[],
): Promise<{ deleted: string[]; queued: string[] }> => {
	if (urls.length === 0) return { deleted: [], queued: [] };

	try {
		const { del } = await import("@vercel/blob");
		await del(urls);
		return { deleted: [...urls], queued: [] };
	} catch (err) {
		console.warn(
			"[pod-storage-cleanup] vercel blob delete failed",
			JSON.stringify({ count: urls.length, error: String(err) }),
		);
		await enqueueRetries(
			urls.map((storageKey) => ({
				storageKey,
				reason: BLOB_URL_QUEUE_REASON,
			})),
		);
		return { deleted: [], queued: [...urls] };
	}
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
			const res = await fetch(
				`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${apiToken}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ files: chunk }),
				},
			);
			if (!res.ok) {
				console.warn(
					"[pod-storage-cleanup] cdn purge failed",
					res.status,
					await res.text().catch(() => ""),
				);
			}
		}
	} catch (err) {
		console.warn("[pod-storage-cleanup] cdn purge threw", err);
	}
};
