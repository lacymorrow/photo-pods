"use server";

import crypto from "node:crypto";
import { and, desc, eq, sql, count } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import {
	pods,
	podMembers,
	podPhotos,
	podInvites,
	type Pod,
	type PodMember,
	type PodPhoto,
} from "@/server/db/pods-schema";
import { users } from "@/server/db/schema";

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

const requirePodAccess = async (
	podId: string,
	requiredRoles?: ("owner" | "contributor" | "viewer")[],
) => {
	const user = await requireAuth();
	const database = requireDb();

	const member = await database.query.podMembers.findFirst({
		where: and(eq(podMembers.podId, podId), eq(podMembers.userId, user.id)),
	});

	if (!member) throw new Error("Not a member of this pod");
	if (requiredRoles && !requiredRoles.includes(member.role)) {
		throw new Error("Insufficient permissions");
	}

	return { user, member };
};

// --- Pod CRUD ---

export const createPod = async (data: {
	name: string;
	description?: string;
	visibility?: "public" | "private" | "invite-only";
}) => {
	const user = await requireAuth();
	const database = requireDb();

	const [pod] = await database
		.insert(pods)
		.values({
			name: data.name,
			description: data.description ?? null,
			visibility: data.visibility ?? "invite-only",
			createdById: user.id,
		})
		.returning();

	if (!pod) throw new Error("Failed to create pod");

	// Add creator as owner
	await database.insert(podMembers).values({
		podId: pod.id,
		userId: user.id,
		role: "owner",
	});

	revalidatePath("/pods");
	return pod;
};

export const updatePod = async (
	podId: string,
	data: {
		name?: string;
		description?: string;
		visibility?: "public" | "private" | "invite-only";
		coverPhotoUrl?: string;
	},
) => {
	await requirePodAccess(podId, ["owner"]);
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
	await requirePodAccess(podId, ["owner"]);
	const database = requireDb();

	await database.delete(pods).where(eq(pods.id, podId));

	revalidatePath("/pods");
};

export const getPod = async (podId: string) => {
	const user = await requireAuth();
	const database = requireDb();

	const pod = await database.query.pods.findFirst({
		where: eq(pods.id, podId),
		with: {
			createdBy: true,
			members: {
				with: { user: true },
			},
		},
	});

	if (!pod) throw new Error("Pod not found");

	// Check access
	if (pod.visibility === "public") {
		// Anyone can view public pods
	} else {
		const isMember = pod.members.some((m) => m.userId === user.id);
		if (!isMember) throw new Error("Access denied");
	}

	const [photoCount] = await database
		.select({ count: count() })
		.from(podPhotos)
		.where(eq(podPhotos.podId, podId));

	return {
		...pod,
		photoCount: photoCount?.count ?? 0,
		memberCount: pod.members.length,
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
					photos: {
						limit: 1,
						orderBy: [desc(podPhotos.createdAt)],
					},
				},
			},
		},
		orderBy: [desc(podMembers.joinedAt)],
	});

	return memberships.map((m) => ({
		...m.pod,
		role: m.role,
		memberCount: m.pod.members.length,
		photoCount: 0, // Will be filled by count query if needed
		latestPhoto: m.pod.photos[0] ?? null,
	}));
};

// --- Members ---

export const addPodMember = async (
	podId: string,
	userId: string,
	role: "contributor" | "viewer" = "viewer",
) => {
	await requirePodAccess(podId, ["owner"]);
	const database = requireDb();

	// Check not already a member
	const existing = await database.query.podMembers.findFirst({
		where: and(eq(podMembers.podId, podId), eq(podMembers.userId, userId)),
	});
	if (existing) throw new Error("User is already a member");

	await database.insert(podMembers).values({ podId, userId, role });
	revalidatePath(`/pods/${podId}`);
};

export const removePodMember = async (podId: string, userId: string) => {
	const { member } = await requirePodAccess(podId, ["owner"]);
	const database = requireDb();

	// Can't remove yourself as owner
	if (userId === member.userId && member.role === "owner") {
		throw new Error("Cannot remove the pod owner");
	}

	await database
		.delete(podMembers)
		.where(and(eq(podMembers.podId, podId), eq(podMembers.userId, userId)));

	revalidatePath(`/pods/${podId}`);
};

export const updateMemberRole = async (
	podId: string,
	userId: string,
	role: "contributor" | "viewer",
) => {
	await requirePodAccess(podId, ["owner"]);
	const database = requireDb();

	await database
		.update(podMembers)
		.set({ role })
		.where(and(eq(podMembers.podId, podId), eq(podMembers.userId, userId)));

	revalidatePath(`/pods/${podId}`);
};

// --- Invites ---

export const createInviteLink = async (
	podId: string,
	role: "contributor" | "viewer" = "viewer",
	expiresInHours = 72,
) => {
	const { user } = await requirePodAccess(podId, ["owner", "contributor"]);
	const database = requireDb();

	const token = crypto.randomBytes(32).toString("hex");
	const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

	await database.insert(podInvites).values({
		podId,
		invitedById: user.id,
		token,
		role,
		expiresAt,
	});

	return { token, expiresAt };
};

export const acceptInvite = async (token: string) => {
	const user = await requireAuth();
	const database = requireDb();

	const invite = await database.query.podInvites.findFirst({
		where: eq(podInvites.token, token),
		with: { pod: true },
	});

	if (!invite) throw new Error("Invalid invite link");
	if (invite.acceptedAt) throw new Error("Invite already used");
	if (invite.expiresAt && invite.expiresAt < new Date()) {
		throw new Error("Invite has expired");
	}

	// Check not already a member
	const existing = await database.query.podMembers.findFirst({
		where: and(
			eq(podMembers.podId, invite.podId),
			eq(podMembers.userId, user.id),
		),
	});

	if (existing) {
		return { pod: invite.pod, alreadyMember: true };
	}

	// Add member + mark invite used
	await database.insert(podMembers).values({
		podId: invite.podId,
		userId: user.id,
		role: invite.role,
	});

	await database
		.update(podInvites)
		.set({ acceptedAt: new Date() })
		.where(eq(podInvites.id, invite.id));

	revalidatePath(`/pods/${invite.podId}`);
	return { pod: invite.pod, alreadyMember: false };
};

// --- Photos ---

export const uploadPhoto = async (podId: string, formData: FormData) => {
	const { user } = await requirePodAccess(podId, ["owner", "contributor"]);
	const database = requireDb();

	const file = formData.get("file") as File;
	if (!file) throw new Error("No file provided");

	// Validate file type
	const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
	if (!allowedTypes.includes(file.type)) {
		throw new Error("Invalid file type. Allowed: JPEG, PNG, WebP, HEIC");
	}

	// For now, use the existing S3 upload service
	// Convert File to Buffer for storage
	const buffer = Buffer.from(await file.arrayBuffer());
	const fileName = `pods/${podId}/${Date.now()}-${file.name}`;

	// Use the existing file upload infrastructure
	const { uploadFile } = await import("@/server/services/file");
	const { url } = await uploadFile(file as any);

	const [photo] = await database
		.insert(podPhotos)
		.values({
			podId,
			uploadedById: user.id,
			url,
			mimeType: file.type,
			size: file.size,
			caption: (formData.get("caption") as string) ?? null,
		})
		.returning();

	revalidatePath(`/pods/${podId}`);
	return photo;
};

export const deletePhoto = async (photoId: string) => {
	const user = await requireAuth();
	const database = requireDb();

	const photo = await database.query.podPhotos.findFirst({
		where: eq(podPhotos.id, photoId),
	});

	if (!photo) throw new Error("Photo not found");

	// Must be photo uploader or pod owner
	const member = await database.query.podMembers.findFirst({
		where: and(
			eq(podMembers.podId, photo.podId),
			eq(podMembers.userId, user.id),
		),
	});

	if (!member) throw new Error("Access denied");
	if (photo.uploadedById !== user.id && member.role !== "owner") {
		throw new Error("Can only delete your own photos");
	}

	await database.delete(podPhotos).where(eq(podPhotos.id, photoId));
	revalidatePath(`/pods/${photo.podId}`);
};

export const getPodPhotos = async (
	podId: string,
	cursor?: string,
	limit = 50,
) => {
	await requirePodAccess(podId);
	const database = requireDb();

	const photos = await database.query.podPhotos.findMany({
		where: eq(podPhotos.podId, podId),
		with: { uploadedBy: true },
		orderBy: [desc(podPhotos.createdAt)],
		limit: limit + 1,
		...(cursor ? { offset: Number.parseInt(cursor, 10) } : {}),
	});

	const hasMore = photos.length > limit;
	if (hasMore) photos.pop();

	return {
		photos,
		nextCursor: hasMore ? String((Number(cursor ?? "0")) + limit) : null,
	};
};
