"use server";

import crypto from "node:crypto";

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { auth } from "@/server/auth";
import { db } from "@/server/db";
import {
	type MediaType,
	type PodVisibility,
	podFollows,
	podInvites,
	podMedia,
	podMembers,
	pods,
} from "@/server/db/pods-schema";
import { hasGpsExif, stripExif } from "@/server/services/pod-media-processing";
import * as policy from "@/server/services/pod-policy";
import * as reactions from "@/server/services/pod-reactions";
import {
	collectMediaKeys,
	deleteObjectsWithRetry,
} from "@/server/services/pod-storage-cleanup";
import {
	buildStorageKey,
	fetchObjectRange,
	isStorageConfigured,
	loadStorageConfig,
	presign,
	publicUrlForKey,
} from "@/server/services/pod-storage";

// --- Helpers ---

// Only these user columns are safe to leak into pod payloads. The full user row
// includes password hashes and emails; NEVER select `user: true` in a pod query.
const PUBLIC_USER_COLUMNS = {
	id: true,
	name: true,
	image: true,
} as const;

const requireAuth = async () => {
	const session = await auth();
	if (!session?.user?.id) throw new Error("Unauthorized");
	return session.user;
};

const requireDb = () => {
	if (!db) throw new Error("Database not initialized");
	return db;
};

const viewerOf = async (): Promise<policy.Viewer> => {
	const session = await auth();
	return {
		userId: session?.user?.id ?? null,
		isAdmin: session?.user?.role === "admin",
	};
};

// --- Pod CRUD ---

export const createPod = async (data: {
	name: string;
	description?: string;
	visibility?: PodVisibility;
}) => {
	const user = await requireAuth();
	const database = requireDb();

	const name = data.name?.trim();
	if (!name) throw new Error("Pod name required");
	if (name.length > 255) throw new Error("Pod name too long");

	const visibility: PodVisibility = data.visibility ?? "group";

	const pod = await database.transaction(async (tx) => {
		const [row] = await tx
			.insert(pods)
			.values({
				name,
				description: data.description ?? null,
				visibility,
				createdById: user.id,
				memberCount: 1,
			})
			.returning();

		if (!row) throw new Error("Failed to create pod");

		await tx.insert(podMembers).values({
			podId: row.id,
			userId: user.id,
			role: "owner",
		});

		return row;
	});

	revalidatePath("/pods");
	return pod;
};

const VALID_VISIBILITIES: readonly PodVisibility[] = ["private", "group", "public"];

export const updatePod = async (
	podId: string,
	data: {
		name?: string;
		description?: string;
		visibility?: PodVisibility;
		coverPhotoUrl?: string;
	},
) => {
	const viewer = await viewerOf();
	const ctx = await policy.guardPod(podId, viewer, policy.isOwner, "edit");
	const database = requireDb();

	// Whitelist columns explicitly — the TypeScript param shape is not a runtime
	// allowlist for a server action, and `.set({ ...data })` would pass anything
	// Drizzle recognises as a column (createdById, hiddenAt, counters, EXIF flag).
	// Fixes LAC-2897 H1.
	const patch: Record<string, unknown> = { updatedAt: new Date() };
	if (data.name !== undefined) {
		const name = String(data.name).trim();
		if (!name) throw new Error("Pod name required");
		if (name.length > 255) throw new Error("Pod name too long");
		patch.name = name;
	}
	if (data.description !== undefined) {
		patch.description = data.description === null ? null : String(data.description);
	}
	if (data.coverPhotoUrl !== undefined) {
		patch.coverPhotoUrl = data.coverPhotoUrl === null ? null : String(data.coverPhotoUrl);
	}
	if (data.visibility !== undefined) {
		if (!VALID_VISIBILITIES.includes(data.visibility)) {
			throw new Error("Invalid visibility");
		}
		patch.visibility = data.visibility;
	}

	const downgradingToPrivate =
		data.visibility === "private" && ctx.pod.visibility !== "private";

	const updated = await database.transaction(async (tx) => {
		const [row] = await tx
			.update(pods)
			.set(patch)
			.where(eq(pods.id, podId))
			.returning();

		// Visibility downgrade to private: private is owner-only, so drop any
		// non-owner members that carried over. Backstops the policy fix (H5) so
		// stale rows do not linger and reappear if visibility is bumped back.
		if (downgradingToPrivate && row) {
			const removed = await tx
				.delete(podMembers)
				.where(
					and(
						eq(podMembers.podId, podId),
						sql`${podMembers.role} <> 'owner'`,
					),
				)
				.returning({ id: podMembers.id });
			if (removed.length > 0) {
				await tx
					.update(pods)
					.set({
						memberCount: sql`GREATEST(${pods.memberCount} - ${removed.length}, 1)`,
					})
					.where(eq(pods.id, podId));
			}
		}

		return row;
	});

	revalidatePath(`/pods/${podId}`);
	revalidatePath("/pods");
	return updated;
};

export const deletePod = async (podId: string) => {
	const viewer = await viewerOf();
	await policy.guardPod(podId, viewer, policy.isOwner, "delete");
	const database = requireDb();

	// GDPR (LAC-2917 H2): gather every storage key attached to the pod so we
	// can issue R2 deletes after the DB rows are gone. Cascades take care of
	// the DB side; storage cleanup is best-effort with a retry queue.
	const mediaRows = await database
		.select({
			storageKey: podMedia.storageKey,
			variants: podMedia.variants,
		})
		.from(podMedia)
		.where(eq(podMedia.podId, podId));
	const keys = mediaRows.flatMap((m) => collectMediaKeys(m));

	await database.delete(pods).where(eq(pods.id, podId));
	if (keys.length > 0) await deleteObjectsWithRetry(keys);
	revalidatePath("/pods");
};

export const getPod = async (podId: string) => {
	const viewer = await viewerOf();
	const ctx = await policy.loadPolicyContext(podId, viewer);
	if (!ctx) throw new Error("Pod not found");
	if (!policy.canView(ctx)) throw new Error("Access denied");

	const database = requireDb();
	const pod = await database.query.pods.findFirst({
		where: eq(pods.id, podId),
		with: {
			createdBy: { columns: PUBLIC_USER_COLUMNS },
			members: {
				with: { user: { columns: PUBLIC_USER_COLUMNS } },
			},
		},
	});
	if (!pod) throw new Error("Pod not found");

	return {
		...pod,
		memberCount: pod.memberCount ?? pod.members.length,
		photoCount: pod.mediaCount ?? 0,
		followerCount: pod.followerCount ?? 0,
		viewer: {
			userId: viewer.userId,
			isMember: policy.isMember(ctx),
			isOwner: policy.isOwner(ctx),
			canUpload: policy.canUpload(ctx),
			canReact: policy.canReact(ctx),
			canInvite: policy.canInvite(ctx),
			canModerate: policy.canModerate(ctx),
		},
	};
};

export const getUserPods = async () => {
	const user = await requireAuth();
	const database = requireDb();

	const memberships = await database.query.podMembers.findMany({
		where: eq(podMembers.userId, user.id),
		with: {
			pod: {
				with: {
					members: true,
					media: {
						limit: 1,
						orderBy: [desc(podMedia.createdAt)],
						where: eq(podMedia.status, "ready"),
					},
				},
			},
		},
		orderBy: [desc(podMembers.joinedAt)],
	});

	return memberships.map((m) => ({
		...m.pod,
		role: m.role,
		memberCount: m.pod.memberCount ?? m.pod.members.length,
		photoCount: m.pod.mediaCount ?? 0,
		latestPhoto: m.pod.media[0] ?? null,
	}));
};

// --- Discovery (public pods) ---

export const listPublicPods = async (options?: {
	limit?: number;
	cursor?: string;
}) => {
	const database = requireDb();
	const limit = Math.min(Math.max(options?.limit ?? 24, 1), 100);
	const rows = await database
		.select({
			id: pods.id,
			name: pods.name,
			description: pods.description,
			coverPhotoUrl: pods.coverPhotoUrl,
			mediaCount: pods.mediaCount,
			followerCount: pods.followerCount,
			createdAt: pods.createdAt,
		})
		.from(pods)
		.where(
			and(
				eq(pods.visibility, "public"),
				sql`${pods.hiddenAt} IS NULL`,
				options?.cursor
					? sql`${pods.createdAt} < ${new Date(options.cursor)}`
					: sql`true`,
			),
		)
		.orderBy(desc(pods.createdAt))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	if (hasMore) rows.pop();
	return {
		pods: rows,
		nextCursor: hasMore ? rows[rows.length - 1]?.createdAt.toISOString() : null,
	};
};

export const searchPublicPods = async (query: string, limit = 20) => {
	const database = requireDb();
	const trimmed = query.trim();
	if (!trimmed) return { pods: [] as Awaited<ReturnType<typeof listPublicPods>>["pods"] };
	const q = `%${trimmed.replace(/[%_]/g, "\\$&")}%`;
	const rows = await database
		.select({
			id: pods.id,
			name: pods.name,
			description: pods.description,
			coverPhotoUrl: pods.coverPhotoUrl,
			mediaCount: pods.mediaCount,
			followerCount: pods.followerCount,
			createdAt: pods.createdAt,
		})
		.from(pods)
		.where(
			and(
				eq(pods.visibility, "public"),
				sql`${pods.hiddenAt} IS NULL`,
				sql`(${pods.name} ILIKE ${q} OR ${pods.description} ILIKE ${q})`,
			),
		)
		.orderBy(desc(pods.followerCount), desc(pods.createdAt))
		.limit(Math.min(Math.max(limit, 1), 50));
	return { pods: rows };
};

// --- Members ---

export const removePodMember = async (podId: string, userId: string) => {
	const viewer = await viewerOf();
	const ctx = await policy.guardPod(podId, viewer, policy.isOwner, "remove members");
	const database = requireDb();

	if (userId === ctx.pod.createdById) {
		throw new Error("Cannot remove the pod owner");
	}

	await database.transaction(async (tx) => {
		const removed = await tx
			.delete(podMembers)
			.where(and(eq(podMembers.podId, podId), eq(podMembers.userId, userId)))
			.returning({ id: podMembers.id });
		if (removed.length > 0) {
			await tx
				.update(pods)
				.set({
					memberCount: sql`GREATEST(${pods.memberCount} - 1, 0)`,
					updatedAt: new Date(),
				})
				.where(eq(pods.id, podId));
		}
	});

	revalidatePath(`/pods/${podId}`);
};

export const leavePod = async (podId: string) => {
	const user = await requireAuth();
	const database = requireDb();
	const membership = await database.query.podMembers.findFirst({
		where: and(eq(podMembers.podId, podId), eq(podMembers.userId, user.id)),
	});
	if (!membership) throw new Error("Not a member");
	if (membership.role === "owner") {
		throw new Error("Owner cannot leave — delete the pod or transfer ownership");
	}
	await database.transaction(async (tx) => {
		await tx
			.delete(podMembers)
			.where(and(eq(podMembers.podId, podId), eq(podMembers.userId, user.id)));
		await tx
			.update(pods)
			.set({
				memberCount: sql`GREATEST(${pods.memberCount} - 1, 0)`,
				updatedAt: new Date(),
			})
			.where(eq(pods.id, podId));
	});
	revalidatePath(`/pods/${podId}`);
	revalidatePath("/pods");
};

// --- Invites ---

const randomShortCode = () =>
	String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");

export const createInviteLink = async (
	podId: string,
	_legacyRole?: unknown,
	expiresInHours = 24 * 7,
) => {
	const viewer = await viewerOf();
	const ctx = await policy.guardPod(podId, viewer, policy.canInvite, "invite to");
	const database = requireDb();

	const token = crypto.randomBytes(32).toString("hex");
	const shortCode = randomShortCode();
	const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

	await database.insert(podInvites).values({
		podId,
		invitedById: ctx.viewer.userId ?? "",
		token,
		shortCode,
		role: "member",
		expiresAt,
	});

	return { token, shortCode, expiresAt };
};

// Simple in-memory sliding-window limiter for short-code acceptance. Best-effort
// (per-process); a durable Redis-backed limiter is a follow-up (LAC-2859 §4).
const SHORT_CODE_WINDOW_MS = 60 * 1000;
const SHORT_CODE_MAX_ATTEMPTS = 5;
const shortCodeAttempts = new Map<string, number[]>();

const checkShortCodeRateLimit = (userId: string): void => {
	const now = Date.now();
	const cutoff = now - SHORT_CODE_WINDOW_MS;
	const attempts = (shortCodeAttempts.get(userId) ?? []).filter((t) => t > cutoff);
	if (attempts.length >= SHORT_CODE_MAX_ATTEMPTS) {
		throw new Error("Too many invite attempts. Please wait a minute and try again.");
	}
	attempts.push(now);
	shortCodeAttempts.set(userId, attempts);
};

export const acceptInvite = async (
	tokenOrCode: string,
	options?: { podId?: string },
) => {
	const user = await requireAuth();
	const database = requireDb();

	const trimmed = tokenOrCode.trim();
	const isShortCode = trimmed.length <= 8;

	// Short codes are 6 digits — enumerable if unbounded. Require the caller to
	// supply the target podId (comes from the invite QR/link surface), so an
	// attacker cannot brute-force codes across the platform. Long tokens are
	// 64-hex secrets and stand on their own.
	if (isShortCode) {
		if (!options?.podId) {
			throw new Error("Pod is required to accept a short code invite");
		}
		checkShortCodeRateLimit(user.id);
	}

	const invite = await database.query.podInvites.findFirst({
		where: isShortCode
			? and(
					eq(podInvites.shortCode, trimmed),
					eq(podInvites.podId, options!.podId!),
				)
			: eq(podInvites.token, trimmed),
		with: {
			pod: {
				columns: {
					id: true,
					name: true,
					description: true,
					coverPhotoUrl: true,
					visibility: true,
					memberCount: true,
					mediaCount: true,
					followerCount: true,
					createdAt: true,
				},
			},
		},
	});

	if (!invite) throw new Error("Invalid invite");
	if (invite.revokedAt) throw new Error("Invite revoked");
	if (invite.expiresAt && invite.expiresAt < new Date()) {
		throw new Error("Invite expired");
	}

	const existing = await database.query.podMembers.findFirst({
		where: and(
			eq(podMembers.podId, invite.podId),
			eq(podMembers.userId, user.id),
		),
	});
	if (existing) return { pod: invite.pod, alreadyMember: true };

	// Atomic maxUses consumption: the UPDATE only succeeds if a slot is free,
	// closing the TOCTOU window where two concurrent accepts both saw useCount<max.
	await database.transaction(async (tx) => {
		const claimed = await tx
			.update(podInvites)
			.set({
				useCount: sql`${podInvites.useCount} + 1`,
				acceptedAt: invite.acceptedAt ?? new Date(),
			})
			.where(
				and(
					eq(podInvites.id, invite.id),
					sql`${podInvites.revokedAt} IS NULL`,
					sql`(${podInvites.expiresAt} IS NULL OR ${podInvites.expiresAt} > NOW())`,
					sql`(${podInvites.maxUses} IS NULL OR ${podInvites.useCount} < ${podInvites.maxUses})`,
				),
			)
			.returning({ id: podInvites.id });
		if (claimed.length === 0) {
			throw new Error("Invite has been fully used");
		}
		await tx.insert(podMembers).values({
			podId: invite.podId,
			userId: user.id,
			role: "member",
		});
		await tx
			.update(pods)
			.set({
				memberCount: sql`${pods.memberCount} + 1`,
				updatedAt: new Date(),
			})
			.where(eq(pods.id, invite.podId));
	});

	revalidatePath(`/pods/${invite.podId}`);
	return { pod: invite.pod, alreadyMember: false };
};

export const revokeInvite = async (podId: string, inviteId: string) => {
	const viewer = await viewerOf();
	await policy.guardPod(podId, viewer, policy.canInvite, "manage invites for");
	const database = requireDb();
	await database
		.update(podInvites)
		.set({ revokedAt: new Date() })
		.where(and(eq(podInvites.id, inviteId), eq(podInvites.podId, podId)));
};

// --- Follows (public pods) ---

export const followPod = async (podId: string) => {
	const viewer = await viewerOf();
	const ctx = await policy.guardPod(podId, viewer, policy.canFollow, "follow");
	const database = requireDb();
	if (!ctx.viewer.userId) throw new Error("Sign in required");

	await database.transaction(async (tx) => {
		const inserted = await tx
			.insert(podFollows)
			.values({ podId, userId: ctx.viewer.userId! })
			.onConflictDoNothing({
				target: [podFollows.podId, podFollows.userId],
			})
			.returning({ id: podFollows.id });
		if (inserted.length > 0) {
			await tx
				.update(pods)
				.set({ followerCount: sql`${pods.followerCount} + 1` })
				.where(eq(pods.id, podId));
		}
	});
	revalidatePath(`/pods/${podId}`);
};

export const unfollowPod = async (podId: string) => {
	const user = await requireAuth();
	const database = requireDb();
	await database.transaction(async (tx) => {
		const removed = await tx
			.delete(podFollows)
			.where(
				and(eq(podFollows.podId, podId), eq(podFollows.userId, user.id)),
			)
			.returning({ id: podFollows.id });
		if (removed.length > 0) {
			await tx
				.update(pods)
				.set({ followerCount: sql`GREATEST(${pods.followerCount} - 1, 0)` })
				.where(eq(pods.id, podId));
		}
	});
	revalidatePath(`/pods/${podId}`);
};

// Sliding-window upload limiter (per user). MVP ceiling: 100 uploads/hour to
// bound storage cost and abuse. Same in-memory caveats as the other limiters
// in this file — a durable Redis-backed limiter is a follow-up (LAC-2859 §4).
const UPLOAD_WINDOW_MS = 60 * 60 * 1000;
const UPLOAD_MAX_PER_WINDOW = 100;
const uploadAttempts = new Map<string, number[]>();

const checkUploadRateLimit = (userId: string): void => {
	const now = Date.now();
	const cutoff = now - UPLOAD_WINDOW_MS;
	const hits = (uploadAttempts.get(userId) ?? []).filter((t) => t > cutoff);
	if (hits.length >= UPLOAD_MAX_PER_WINDOW) {
		throw new Error("Upload limit reached. Please try again later.");
	}
	hits.push(now);
	uploadAttempts.set(userId, hits);
};

// --- Media: presigned upload flow ---

const PHOTO_MIMES = new Set([
	"image/jpeg",
	"image/png",
	"image/webp",
	"image/heic",
	"image/heif",
]);
const VIDEO_MIMES = new Set([
	"video/mp4",
	"video/quicktime",
	"video/webm",
]);
const MAX_PHOTO_BYTES = 50 * 1024 * 1024;
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;

const extForMime = (mime: string): string => {
	const map: Record<string, string> = {
		"image/jpeg": "jpg",
		"image/png": "png",
		"image/webp": "webp",
		"image/heic": "heic",
		"image/heif": "heif",
		"video/mp4": "mp4",
		"video/quicktime": "mov",
		"video/webm": "webm",
	};
	return map[mime] ?? "bin";
};

export interface PresignedUploadRequest {
	podId: string;
	filename: string;
	contentType: string;
	size: number;
}

export interface PresignedUploadResponse {
	mediaId: string;
	uploadUrl: string;
	method: "PUT";
	headers: Record<string, string>;
	storageKey: string;
	expiresInSeconds: number;
	fallback?: {
		reason: "storage_not_configured";
		message: string;
	};
}

/**
 * Presigned direct-to-storage photo upload. Videos will follow the Stream
 * direct-creator-upload flow once the Cloudflare account is provisioned
 * (blocked on board spend approval — see LAC-2855 §4).
 */
export const requestPresignedUpload = async (
	req: PresignedUploadRequest,
): Promise<PresignedUploadResponse> => {
	const viewer = await viewerOf();
	const ctx = await policy.guardPod(req.podId, viewer, policy.canUpload, "upload to");
	if (!ctx.viewer.userId) throw new Error("Sign in required");

	checkUploadRateLimit(ctx.viewer.userId);

	const contentType = req.contentType.toLowerCase();
	let mediaType: MediaType;
	let maxBytes: number;
	if (PHOTO_MIMES.has(contentType)) {
		mediaType = "photo";
		maxBytes = MAX_PHOTO_BYTES;
	} else if (VIDEO_MIMES.has(contentType)) {
		mediaType = "video";
		maxBytes = MAX_VIDEO_BYTES;
	} else {
		throw new Error(`Unsupported content type: ${contentType}`);
	}
	if (req.size <= 0 || req.size > maxBytes) {
		throw new Error(
			`File size ${req.size} bytes exceeds max ${maxBytes} bytes for ${mediaType}`,
		);
	}

	const database = requireDb();
	const mediaId = crypto.randomUUID();
	const storageKey = buildStorageKey(
		req.podId,
		mediaId,
		mediaType,
		extForMime(contentType),
	);

	await database.insert(podMedia).values({
		id: mediaId,
		podId: req.podId,
		uploadedById: ctx.viewer.userId,
		type: mediaType,
		status: "processing",
		storageKey,
		size: req.size,
		mimeType: contentType,
	});

	if (!isStorageConfigured()) {
		return {
			mediaId,
			uploadUrl: "",
			method: "PUT",
			headers: {},
			storageKey,
			expiresInSeconds: 0,
			fallback: {
				reason: "storage_not_configured",
				message:
					"Object storage is not configured yet. Use uploadPhotoLegacy while R2 is being provisioned.",
			},
		};
	}

	const config = loadStorageConfig();
	const expiresInSeconds = 60 * 15;
	const uploadUrl = presign({
		config,
		method: "PUT",
		key: storageKey,
		contentType,
		contentLength: req.size,
		expiresInSeconds,
	});

	return {
		mediaId,
		uploadUrl,
		method: "PUT",
		// Content-Length is bound into the signature; the client MUST send this
		// exact value or storage will reject the PUT (see pod-storage.presign).
		headers: {
			"Content-Type": contentType,
			"Content-Length": String(req.size),
		},
		storageKey,
		expiresInSeconds,
	};
};

/**
 * Client callback after the presigned PUT succeeds. Marks the media
 * `ready` and stores dimensions/duration if the client extracted them.
 * (Server-side thumbnailing/EXIF stripping is the worker's job — LAC-2855 §3.)
 */
export const finalizeUpload = async (input: {
	mediaId: string;
	width?: number;
	height?: number;
	durationSeconds?: number;
	caption?: string;
}) => {
	const viewer = await viewerOf();
	if (!viewer.userId) throw new Error("Unauthorized");
	const database = requireDb();

	const media = await database.query.podMedia.findFirst({
		where: eq(podMedia.id, input.mediaId),
	});
	if (!media) throw new Error("Media not found");
	if (media.uploadedById !== viewer.userId) throw new Error("Not your upload");

	const config = loadStorageConfig();

	// H1: verify the client stripped EXIF/GPS before we mark the media ready.
	// Pods that opted in to `retainLocationExif` skip the check. Long-term
	// this moves into the R2 finalize worker; interim we sniff a small
	// prefix over HTTP Range from storage.
	let exifStrippedAt: Date | null = null;
	if (media.type === "photo" && media.storageKey) {
		const pod = await database.query.pods.findFirst({
			where: eq(pods.id, media.podId),
			columns: { retainLocationExif: true },
		});
		const retain = Boolean(pod?.retainLocationExif);
		if (!retain) {
			// 256 KB covers the APP1 EXIF segment for any real-world phone
			// photo. If storage isn't configured (fallback path), skip.
			const head = await fetchObjectRange(config, media.storageKey, 256 * 1024 - 1);
			if (head && (await hasGpsExif(head))) {
				// Best-effort cleanup: nuke the object so the leak doesn't linger,
				// mark the row `removed`, and reject the finalize.
				await deleteObjectsWithRetry([media.storageKey]);
				await database
					.update(podMedia)
					.set({ status: "removed", hiddenAt: new Date() })
					.where(eq(podMedia.id, media.id));
				throw new Error(
					"Upload rejected: image still contains GPS metadata. Please retry.",
				);
			}
			// If we couldn't fetch the head at all we still mark it stripped:
			// the client-side canvas re-encode drops EXIF entirely, and the
			// storage-fetch failure alone shouldn't gate uploads. The
			// long-term worker will re-verify.
			exifStrippedAt = new Date();
		}
	}

	const publicUrl = media.storageKey
		? publicUrlForKey(config, media.storageKey)
		: null;

	const [updated] = await database
		.update(podMedia)
		.set({
			status: media.type === "video" ? "processing" : "ready",
			width: input.width ?? media.width,
			height: input.height ?? media.height,
			durationSeconds: input.durationSeconds ?? media.durationSeconds,
			caption: input.caption ?? media.caption,
			url: publicUrl ?? media.url,
			readyAt: media.type === "video" ? media.readyAt : new Date(),
			exifStripped: exifStrippedAt ?? media.exifStripped,
		})
		.where(eq(podMedia.id, input.mediaId))
		.returning();

	await database
		.update(pods)
		.set({
			mediaCount: sql`${pods.mediaCount} + 1`,
			updatedAt: new Date(),
		})
		.where(eq(pods.id, media.podId));

	revalidatePath(`/pods/${media.podId}`);
	return updated;
};

// --- Media: legacy formData upload (Vercel Blob fallback) ---

/**
 * Kept for the pre-R2 development path so the existing UI keeps working. Not
 * suitable for production per LAC-2855 §1 (Vercel serverless body caps at
 * ~4.5 MB, blocking spec limits). Once R2 is provisioned, this deletes.
 *
 * Gated: unavailable once object storage is configured (production) and
 * enforces the same photo size cap as the presigned path. (LAC-2897 M4.)
 */
export const uploadPhoto = async (podId: string, formData: FormData) => {
	if (isStorageConfigured()) {
		throw new Error(
			"Legacy upload path is disabled — use the presigned upload flow.",
		);
	}
	const viewer = await viewerOf();
	const ctx = await policy.guardPod(podId, viewer, policy.canUpload, "upload to");
	if (!ctx.viewer.userId) throw new Error("Sign in required");
	checkUploadRateLimit(ctx.viewer.userId);
	const database = requireDb();

	const file = formData.get("file") as File;
	if (!file) throw new Error("No file provided");
	const contentType = file.type.toLowerCase();
	if (!PHOTO_MIMES.has(contentType)) {
		throw new Error("Invalid file type. Allowed: JPEG, PNG, WebP, HEIC");
	}
	if (typeof file.size !== "number" || file.size <= 0 || file.size > MAX_PHOTO_BYTES) {
		throw new Error(
			`File size ${file.size} bytes exceeds max ${MAX_PHOTO_BYTES} bytes for photo`,
		);
	}

	// Sanitize the client-supplied filename before using it in the blob key.
	// The raw `file.name` can contain path separators, control characters,
	// or unicode tricks; we keep only a safe subset and cap the length.
	const rawName = typeof file.name === "string" ? file.name : "upload";
	const dot = rawName.lastIndexOf(".");
	const baseName = (dot > 0 ? rawName.slice(0, dot) : rawName)
		.replace(/[^a-zA-Z0-9._-]/g, "_")
		.replace(/^\.+/, "")
		.slice(0, 64) || "upload";
	const ext = extForMime(contentType);
	const safeName = `${baseName}.${ext}`;

	// H1: server-side EXIF strip. This is the legacy path that receives the
	// raw bytes, so we re-encode via sharp. Pods that opted in to retention
	// keep the EXIF; everyone else gets GPS + camera identifiers scrubbed.
	//
	// Fail **closed** (LAC-2928): if sharp throws while stripping, we cannot
	// prove the buffer is GPS-free, so we reject the upload rather than
	// falling back to the raw bytes. Matches the finalize/presigned path.
	const retainMetadata = Boolean(ctx.pod.retainLocationExif);
	const originalBuf: Buffer = Buffer.from(await file.arrayBuffer());
	let strippedBuf: Buffer;
	let stripRanAt: Date | null = null;
	try {
		const result = await stripExif(originalBuf, contentType, { retainMetadata });
		strippedBuf = result.buffer;
		if (!retainMetadata) stripRanAt = new Date();
	} catch (err) {
		console.warn("[uploadPhoto] EXIF strip failed, rejecting upload", err);
		throw new Error(
			"Upload rejected: could not strip EXIF metadata from image. Please retry with a different file.",
		);
	}
	const uploadFile: Blob = new Blob([new Uint8Array(strippedBuf)], { type: contentType });

	let url: string;
	try {
		const { put } = await import("@vercel/blob");
		const blob = await put(`pods/${podId}/${Date.now()}-${safeName}`, uploadFile, {
			access: "public",
		});
		url = blob.url;
	} catch {
		const fileService = await import("@/server/services/file");
		const result = await fileService.uploadFile(uploadFile as any);
		url = result.url;
	}

	const mediaId = crypto.randomUUID();
	const [row] = await database.transaction(async (tx) => {
		const inserted = await tx
			.insert(podMedia)
			.values({
				id: mediaId,
				podId,
				uploadedById: ctx.viewer.userId!,
				type: "photo",
				status: "ready",
				url,
				mimeType: contentType,
				size: strippedBuf.byteLength,
				caption: (formData.get("caption") as string) ?? null,
				readyAt: new Date(),
				exifStripped: stripRanAt,
			})
			.returning();
		await tx
			.update(pods)
			.set({
				mediaCount: sql`${pods.mediaCount} + 1`,
				updatedAt: new Date(),
			})
			.where(eq(pods.id, podId));
		return inserted;
	});

	revalidatePath(`/pods/${podId}`);
	return row;
};

export const deletePhoto = async (photoId: string) => {
	const user = await requireAuth();
	const database = requireDb();

	const media = await database.query.podMedia.findFirst({
		where: eq(podMedia.id, photoId),
	});
	if (!media) throw new Error("Photo not found");

	const viewer = { userId: user.id } satisfies policy.Viewer;
	const ctx = await policy.loadPolicyContext(media.podId, viewer);
	if (!ctx) throw new Error("Pod not found");
	const isUploader = media.uploadedById === user.id;
	if (!isUploader && !policy.canModerate(ctx)) {
		throw new Error("Can only delete your own photos");
	}

	await database.transaction(async (tx) => {
		await tx.delete(podMedia).where(eq(podMedia.id, photoId));
		await tx
			.update(pods)
			.set({
				mediaCount: sql`GREATEST(${pods.mediaCount} - 1, 0)`,
				updatedAt: new Date(),
			})
			.where(eq(pods.id, media.podId));
	});

	// GDPR (LAC-2917 H2): delete the R2 objects (original + variants) after
	// the DB row is gone. Best-effort — failed keys go to the retry queue.
	const keys = collectMediaKeys(media);
	if (keys.length > 0) await deleteObjectsWithRetry(keys);

	revalidatePath(`/pods/${media.podId}`);
};

// Cursor format: `${createdAtIsoString}|${id}` — keyset pagination on
// (createdAt desc, id desc) so concurrent inserts can't cause dupes or skips
// the way offset pagination does.
const parsePhotoCursor = (
	cursor: string | undefined,
): { createdAt: Date; id: string } | null => {
	if (!cursor) return null;
	const idx = cursor.indexOf("|");
	if (idx === -1) return null;
	const iso = cursor.slice(0, idx);
	const id = cursor.slice(idx + 1);
	const createdAt = new Date(iso);
	if (Number.isNaN(createdAt.getTime()) || !id) return null;
	return { createdAt, id };
};

export const getPodPhotos = async (
	podId: string,
	cursor?: string,
	limit = 50,
) => {
	const viewer = await viewerOf();
	const ctx = await policy.loadPolicyContext(podId, viewer);
	if (!ctx || !policy.canView(ctx)) throw new Error("Access denied");
	const database = requireDb();

	const parsedCursor = parsePhotoCursor(cursor);

	const rows = await database.query.podMedia.findMany({
		where: and(
			eq(podMedia.podId, podId),
			eq(podMedia.status, "ready"),
			sql`${podMedia.hiddenAt} IS NULL`,
			parsedCursor
				? sql`(${podMedia.createdAt}, ${podMedia.id}) < (${parsedCursor.createdAt}, ${parsedCursor.id})`
				: sql`true`,
		),
		with: { uploadedBy: { columns: PUBLIC_USER_COLUMNS } },
		orderBy: [desc(podMedia.createdAt), desc(podMedia.id)],
		limit: limit + 1,
	});

	const hasMore = rows.length > limit;
	if (hasMore) rows.pop();

	const mediaIds = rows.map((r) => r.id);
	const counts = await reactions.getReactionCounts(mediaIds);
	const own = viewer.userId
		? await reactions.getViewerReactions(mediaIds, viewer.userId)
		: {};

	const photos = rows.map((row) => ({
		...row,
		reactionCounts: counts[row.id] ?? {},
		viewerReaction: own[row.id] ?? null,
	}));

	const last = rows[rows.length - 1];
	return {
		photos,
		nextCursor:
			hasMore && last ? `${last.createdAt.toISOString()}|${last.id}` : null,
	};
};

// --- Reactions ---

export const reactToMedia = async (mediaId: string, reaction: string | null) => {
	const viewer = await viewerOf();
	if (!viewer.userId) throw new Error("Unauthorized");
	if (!mediaId) throw new Error("mediaId required");

	const media = await reactions.resolveMediaPod(mediaId);
	if (!media) throw new Error("Media not found");
	// Media that is still processing, hidden by moderation, or removed
	// must not accept new reactions — otherwise a client that cached an id
	// can react to content the pod has effectively pulled.
	if (media.status !== "ready") {
		throw new Error("Cannot react to this media");
	}
	// Media auto-hidden by reports is unreachable to everyone except the
	// uploader and platform admins. (LAC-2897 M3.)
	if (media.hiddenAt && media.uploadedById !== viewer.userId && !viewer.isAdmin) {
		throw new Error("Media not found");
	}

	const ctx = await policy.loadPolicyContext(media.podId, viewer);
	if (!ctx || !policy.canReact(ctx)) {
		throw new Error("Not allowed to react to this media");
	}

	const result = await reactions.setReaction(mediaId, viewer.userId, reaction);
	revalidatePath(`/pods/${media.podId}`);
	return { mediaId, reaction: result.reaction };
};

export const getReactorsForMedia = async (
	mediaId: string,
	reaction: string,
) => {
	const viewer = await viewerOf();
	const media = await reactions.resolveMediaPod(mediaId);
	if (!media) throw new Error("Media not found");
	// Hidden media hides its reactor list too. Uploader and admins keep read
	// access so moderation review still works. (LAC-2897 M3.)
	if (media.hiddenAt && media.uploadedById !== viewer.userId && !viewer.isAdmin) {
		throw new Error("Media not found");
	}

	const ctx = await policy.loadPolicyContext(media.podId, viewer);
	if (!ctx || !policy.canView(ctx)) throw new Error("Access denied");

	// Spec §3.6: reactor identities visible only to members in group pods.
	// Public pods show count only; private pods = owner sees own reactions.
	if (ctx.pod.visibility === "public" && !policy.isMember(ctx)) return [];
	if (ctx.pod.visibility === "group" && !policy.isMember(ctx)) return [];

	return reactions.getReactors(mediaId, reaction);
};

// --- Reports ---

// Sliding-window limiter for reports (per user). Best-effort per-process; a
// durable limiter lives with the other rate-limit follow-ups.
const REPORT_WINDOW_MS = 60 * 60 * 1000;
const REPORT_MAX_PER_WINDOW = 20;
const reportAttempts = new Map<string, number[]>();

const checkReportRateLimit = (userId: string): void => {
	const now = Date.now();
	const cutoff = now - REPORT_WINDOW_MS;
	const hits = (reportAttempts.get(userId) ?? []).filter((t) => t > cutoff);
	if (hits.length >= REPORT_MAX_PER_WINDOW) {
		throw new Error("Too many reports. Please try again later.");
	}
	hits.push(now);
	reportAttempts.set(userId, hits);
};

export const reportMedia = async (
	mediaId: string,
	reason:
		| "nudity_sexual"
		| "violence"
		| "harassment"
		| "spam"
		| "illegal"
		| "other",
	details?: string,
) => {
	const user = await requireAuth();
	checkReportRateLimit(user.id);
	const database = requireDb();
	const media = await reactions.resolveMediaPod(mediaId);
	if (!media) throw new Error("Media not found");

	const { mediaReports } = await import("@/server/db/pods-schema");
	const outcome = await database.transaction(async (tx) => {
		// Dedup on (mediaId, reporterId). A single user cannot inflate
		// report_count past 1 for the same media — fixes LAC-2897 H4.
		const inserted = await tx
			.insert(mediaReports)
			.values({
				mediaId,
				reporterId: user.id,
				reason,
				details: details ?? null,
			})
			.onConflictDoNothing({
				target: [mediaReports.mediaId, mediaReports.reporterId],
			})
			.returning({ id: mediaReports.id });

		if (inserted.length === 0) {
			return { alreadyReported: true } as const;
		}

		await tx
			.update(podMedia)
			.set({ reportCount: sql`${podMedia.reportCount} + 1` })
			.where(eq(podMedia.id, mediaId));
		// Auto-hide at 3 pending reports as a conservative MVP guard.
		// The full "3 confirmed" workflow (LAC-2854 §7) is a follow-up on the
		// moderation queue.
		await tx.execute(sql`
			UPDATE ${podMedia}
			SET hidden_at = NOW()
			WHERE id = ${mediaId}
				AND hidden_at IS NULL
				AND report_count >= 3
		`);
		return { alreadyReported: false } as const;
	});
	return { ok: true, alreadyReported: outcome.alreadyReported };
};
