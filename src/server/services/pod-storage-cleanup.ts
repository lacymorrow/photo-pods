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

import { db } from "@/server/db";
import { type PodMedia, podStorageDeleteQueue } from "@/server/db/pods-schema";
import {
	deleteObject,
	loadStorageConfig,
	publicUrlForKey,
} from "@/server/services/pod-storage";

/**
 * Collect every storage key associated with a media row: the original plus
 * any precomputed thumbnail variants.
 */
export const collectMediaKeys = (
	media: Pick<PodMedia, "storageKey" | "variants">,
): string[] => {
	const keys: string[] = [];
	if (media.storageKey) keys.push(media.storageKey);
	const variants = media.variants ?? null;
	if (variants) {
		for (const value of Object.values(variants)) {
			if (typeof value === "string" && value.length > 0) keys.push(value);
		}
	}
	return keys;
};

const enqueueRetries = async (keys: string[]): Promise<void> => {
	if (!db || keys.length === 0) return;
	try {
		await db
			.insert(podStorageDeleteQueue)
			.values(keys.map((storageKey) => ({ storageKey })));
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
	keys: readonly string[],
): Promise<{ deleted: string[]; queued: string[] }> => {
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
				JSON.stringify({ key, status: result.status, error: result.error }),
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
