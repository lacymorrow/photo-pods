/**
 * @fileoverview Photopods upload limits (LAC-2854 spec, enforced per LAC-2913).
 *
 * Client-safe module — no server imports. The client uses these for UX-level
 * enforcement in `PhotoUpload`; the policy layer (`pod-policy.ts`) enforces
 * the pod cap server-side as defense-in-depth.
 */

/** Max items a user can stage in a single upload batch. */
export const MAX_UPLOAD_BATCH = 50;

/** Max media items a pod may hold, lifetime. */
export const MAX_MEDIA_PER_POD = 10_000;

export interface BatchAcceptResult<T> {
	accepted: T[];
	rejectedCount: number;
}

/**
 * Cap an incoming file selection against the batch limit, accounting for
 * items already staged. Pure so the drop/browse/camera paths share one rule.
 */
export function acceptUploadBatch<T>(
	existingCount: number,
	items: T[],
): BatchAcceptResult<T> {
	const room = Math.max(0, MAX_UPLOAD_BATCH - existingCount);
	return {
		accepted: items.slice(0, room),
		rejectedCount: Math.max(0, items.length - room),
	};
}
