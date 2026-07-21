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
import * as policy from "@/server/services/pod-policy";
import * as reactions from "@/server/services/pod-reactions";
import {
	buildStorageKey,
	isStorageConfigured,
	loadStorageConfig,
	presign,
	publicUrlForKey,
} from "@/server/services/pod-storage";

// --- Helpers ---

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
	await policy.guardPod(podId, viewer, policy.isOwner, "edit");
	const database = requireDb();

	const [updated] = await database
		.update(pods)
		.set({ ...data, updatedAt: new Date() })
		.where(eq(pods.id, podId))
		.returning();

	revalidatePath(`/pods/${podId}`);
	revalidatePath("/pods");
	return updated;
};

export const deletePod = async (podId: string) => {
	const viewer = await viewerOf();
	await policy.guardPod(podId, viewer, policy.isOwner, "delete");
	const database = requireDb();

	await database.delete(pods).where(eq(pods.id, podId));
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
			createdBy: true,
			members: { with: { user: true } },
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

export const acceptInvite = async (tokenOrCode: string) => {
	const user = await requireAuth();
	const database = requireDb();

	const trimmed = tokenOrCode.trim();
	const invite = await database.query.podInvites.findFirst({
		where:
			trimmed.length <= 8
				? eq(podInvites.shortCode, trimmed)
				: eq(podInvites.token, trimmed),
		with: { pod: true },
	});

	if (!invite) throw new Error("Invalid invite");
	if (invite.revokedAt) throw new Error("Invite revoked");
	if (invite.expiresAt && invite.expiresAt < new Date()) {
		throw new Error("Invite expired");
	}
	if (invite.maxUses != null && invite.useCount >= invite.maxUses) {
		throw new Error("Invite has been fully used");
	}

	const existing = await database.query.podMembers.findFirst({
		where: and(
			eq(podMembers.podId, invite.podId),
			eq(podMembers.userId, user.id),
		),
	});
	if (existing) return { pod: invite.pod, alreadyMember: true };

	await database.transaction(async (tx) => {
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
		await tx
			.update(podInvites)
			.set({
				useCount: sql`${podInvites.useCount} + 1`,
				acceptedAt: invite.acceptedAt ?? new Date(),
			})
			.where(eq(podInvites.id, invite.id));
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
		headers: { "Content-Type": contentType },
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
 */
export const uploadPhoto = async (podId: string, formData: FormData) => {
	const viewer = await viewerOf();
	const ctx = await policy.guardPod(podId, viewer, policy.canUpload, "upload to");
	if (!ctx.viewer.userId) throw new Error("Sign in required");
	const database = requireDb();

	const file = formData.get("file") as File;
	if (!file) throw new Error("No file provided");
	const contentType = file.type.toLowerCase();
	if (!PHOTO_MIMES.has(contentType)) {
		throw new Error("Invalid file type. Allowed: JPEG, PNG, WebP, HEIC");
	}

	let url: string;
	try {
		const { put } = await import("@vercel/blob");
		const blob = await put(`pods/${podId}/${Date.now()}-${file.name}`, file, {
			access: "public",
		});
		url = blob.url;
	} catch {
		const { uploadFile } = await import("@/server/services/file");
		const result = await uploadFile(file as any);
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
				size: file.size,
				caption: (formData.get("caption") as string) ?? null,
				readyAt: new Date(),
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
	revalidatePath(`/pods/${media.podId}`);
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

	const rows = await database.query.podMedia.findMany({
		where: and(
			eq(podMedia.podId, podId),
			eq(podMedia.status, "ready"),
			sql`${podMedia.hiddenAt} IS NULL`,
		),
		with: { uploadedBy: true },
		orderBy: [desc(podMedia.createdAt)],
		limit: limit + 1,
		...(cursor ? { offset: Number.parseInt(cursor, 10) } : {}),
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

	return {
		photos,
		nextCursor: hasMore ? String(Number(cursor ?? "0") + limit) : null,
	};
};

// --- Reactions ---

export const reactToMedia = async (mediaId: string, reaction: string | null) => {
	const viewer = await viewerOf();
	if (!viewer.userId) throw new Error("Unauthorized");
	if (!mediaId) throw new Error("mediaId required");

	const media = await reactions.resolveMediaPod(mediaId);
	if (!media) throw new Error("Media not found");

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

	const ctx = await policy.loadPolicyContext(media.podId, viewer);
	if (!ctx || !policy.canView(ctx)) throw new Error("Access denied");

	// Spec §3.6: reactor identities visible only to members in group pods.
	// Public pods show count only; private pods = owner sees own reactions.
	if (ctx.pod.visibility === "public" && !policy.isMember(ctx)) return [];
	if (ctx.pod.visibility === "group" && !policy.isMember(ctx)) return [];

	return reactions.getReactors(mediaId, reaction);
};

// --- Reports ---

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
	const database = requireDb();
	const media = await reactions.resolveMediaPod(mediaId);
	if (!media) throw new Error("Media not found");

	const { mediaReports } = await import("@/server/db/pods-schema");
	await database.transaction(async (tx) => {
		await tx.insert(mediaReports).values({
			mediaId,
			reporterId: user.id,
			reason,
			details: details ?? null,
		});
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
	});
	return { ok: true };
};
