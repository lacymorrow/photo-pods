/**
 * @fileoverview Reaction persistence and aggregation for Photopods media.
 *
 * MVP rules (LAC-2854 §3.6):
 *  - one reaction per (user, media)
 *  - tap to switch, tap again to remove
 *  - the reaction slug must be in the curated set (`lib/pods/reactions.ts`)
 *
 * @module server/services/pod-reactions
 */

import { and, count, eq, inArray, sql } from "drizzle-orm";

import { REACTION_BY_SLUG, type ReactionCounts } from "@/lib/pods/reactions";
import { db } from "@/server/db";
import { mediaReactions, podMedia } from "@/server/db/pods-schema";

const requireDb = () => {
	if (!db) throw new Error("Database not initialized");
	return db;
};

export const isValidReactionSlug = (slug: string): boolean =>
	Object.hasOwn(REACTION_BY_SLUG, slug);

/**
 * Set/switch/remove the reaction for a media item.
 *
 * Callers MUST verify the viewer has `canReact` for the pod before invoking
 * this (see `services/pod-policy`).
 */
export const setReaction = async (
	mediaId: string,
	userId: string,
	reaction: string | null,
): Promise<{ reaction: string | null }> => {
	const database = requireDb();

	if (reaction === null) {
		await database
			.delete(mediaReactions)
			.where(
				and(
					eq(mediaReactions.mediaId, mediaId),
					eq(mediaReactions.userId, userId),
				),
			);
		return { reaction: null };
	}

	if (!isValidReactionSlug(reaction)) {
		throw new Error(`Unsupported reaction: ${reaction}`);
	}

	await database
		.insert(mediaReactions)
		.values({ mediaId, userId, reaction })
		.onConflictDoUpdate({
			target: [mediaReactions.mediaId, mediaReactions.userId],
			set: { reaction, createdAt: new Date() },
		});

	return { reaction };
};

/**
 * Aggregated reaction counts for a set of media ids. The result maps
 * `mediaId -> { slug: count }`. Media without reactions are absent.
 */
export const getReactionCounts = async (
	mediaIds: string[],
): Promise<Record<string, ReactionCounts>> => {
	if (mediaIds.length === 0) return {};
	const database = requireDb();
	const rows = await database
		.select({
			mediaId: mediaReactions.mediaId,
			reaction: mediaReactions.reaction,
			total: count(),
		})
		.from(mediaReactions)
		.where(inArray(mediaReactions.mediaId, mediaIds))
		.groupBy(mediaReactions.mediaId, mediaReactions.reaction);

	const out: Record<string, ReactionCounts> = {};
	for (const row of rows) {
		const bucket = (out[row.mediaId] ??= {});
		bucket[row.reaction] = Number(row.total);
	}
	return out;
};

/**
 * The viewer's own reactions across a set of media. Returns `mediaId -> slug`.
 * Media the viewer has not reacted to are absent.
 */
export const getViewerReactions = async (
	mediaIds: string[],
	userId: string,
): Promise<Record<string, string>> => {
	if (mediaIds.length === 0) return {};
	const database = requireDb();
	const rows = await database
		.select({
			mediaId: mediaReactions.mediaId,
			reaction: mediaReactions.reaction,
		})
		.from(mediaReactions)
		.where(
			and(
				inArray(mediaReactions.mediaId, mediaIds),
				eq(mediaReactions.userId, userId),
			),
		);
	const out: Record<string, string> = {};
	for (const row of rows) out[row.mediaId] = row.reaction;
	return out;
};

/**
 * Ensure the media exists and return its podId. Small helper so callers can
 * resolve the pod once before invoking the policy layer.
 */
export const resolveMediaPod = async (
	mediaId: string,
): Promise<{ id: string; podId: string; status: string } | null> => {
	const database = requireDb();
	const row = await database.query.podMedia.findFirst({
		where: eq(podMedia.id, mediaId),
		columns: { id: true, podId: true, status: true },
	});
	if (!row) return null;
	return row;
};

/**
 * Users who left a given reaction on a media item. Used in the reaction
 * details drawer (group pods only per spec §3.6 — enforce in caller).
 */
export const getReactors = async (
	mediaId: string,
	reaction: string,
	limit = 100,
): Promise<{ userId: string; createdAt: Date }[]> => {
	if (!isValidReactionSlug(reaction)) return [];
	const database = requireDb();
	const rows = await database
		.select({
			userId: mediaReactions.userId,
			createdAt: mediaReactions.createdAt,
		})
		.from(mediaReactions)
		.where(
			and(
				eq(mediaReactions.mediaId, mediaId),
				eq(mediaReactions.reaction, reaction),
			),
		)
		.orderBy(sql`created_at desc`)
		.limit(limit);
	return rows;
};
