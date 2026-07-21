/**
 * @fileoverview Database schema for Photopods MVP (LAC-2857).
 *
 * Aligned with the product spec (LAC-2854) and the architecture doc (LAC-2855):
 *  - visibility: private | group | public
 *  - membership role: owner | member (no permission tiers)
 *  - unified pod_media table for photos + videos with processing status
 *  - media_reactions (curated emoji set, enforced in the policy layer, no pg enum)
 *  - pod_follows for public-pod feed subscription (follow != membership)
 *  - media_reports + pod_reports for the moderation queue
 *
 * @module server/db/pods-schema
 */

import { relations, sql } from "drizzle-orm";
import {
	bigint,
	index,
	integer,
	json,
	pgEnum,
	pgTableCreator,
	text,
	timestamp,
	uniqueIndex,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";
import { env } from "@/env";
import { users } from "./schema";

const createTable = pgTableCreator((name) => `${env?.DB_PREFIX ?? ""}_${name}`);

// --- Enums ---

export const podVisibilityEnum = pgEnum("pod_visibility", [
	"private",
	"group",
	"public",
]);

export const podMemberRoleEnum = pgEnum("pod_member_role", [
	"owner",
	"member",
]);

export const mediaTypeEnum = pgEnum("pod_media_type", ["photo", "video"]);

export const mediaStatusEnum = pgEnum("pod_media_status", [
	"processing",
	"ready",
	"hidden",
	"removed",
]);

export const reportReasonEnum = pgEnum("pod_report_reason", [
	"nudity_sexual",
	"violence",
	"harassment",
	"spam",
	"illegal",
	"other",
]);

export const reportStatusEnum = pgEnum("pod_report_status", [
	"pending",
	"confirmed",
	"dismissed",
]);

// --- Tables ---

export const pods = createTable(
	"pod",
	{
		id: uuid("id")
			.primaryKey()
			.default(sql`gen_random_uuid()`),
		name: varchar("name", { length: 255 }).notNull(),
		description: text("description"),
		coverPhotoUrl: text("cover_photo_url"),
		visibility: podVisibilityEnum("visibility").notNull().default("group"),
		createdById: varchar("created_by_id", { length: 255 })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		mediaCount: integer("media_count").notNull().default(0),
		memberCount: integer("member_count").notNull().default(1),
		followerCount: integer("follower_count").notNull().default(0),
		// Owner opt-in per pod to preserve EXIF GPS on uploads (default: strip).
		retainLocationExif: timestamp("retain_location_exif_at", { withTimezone: true }),
		hiddenAt: timestamp("hidden_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.default(sql`CURRENT_TIMESTAMP`)
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.default(sql`CURRENT_TIMESTAMP`)
			.notNull(),
	},
	(table) => [
		index("pod_created_by_idx").on(table.createdById),
		index("pod_visibility_idx").on(table.visibility),
		index("pod_public_recent_idx").on(table.visibility, table.createdAt),
	],
);

export const podMembers = createTable(
	"pod_member",
	{
		id: uuid("id")
			.primaryKey()
			.default(sql`gen_random_uuid()`),
		podId: uuid("pod_id")
			.notNull()
			.references(() => pods.id, { onDelete: "cascade" }),
		userId: varchar("user_id", { length: 255 })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		role: podMemberRoleEnum("role").notNull().default("member"),
		joinedAt: timestamp("joined_at", { withTimezone: true })
			.default(sql`CURRENT_TIMESTAMP`)
			.notNull(),
	},
	(table) => [
		uniqueIndex("pod_member_unique_idx").on(table.podId, table.userId),
		index("pod_member_pod_idx").on(table.podId),
		index("pod_member_user_idx").on(table.userId),
	],
);

/**
 * Unified media table. Photos are served from R2 via `storageKey`;
 * videos are served from Cloudflare Stream via `streamId`.
 * Kept the historical table name `pod_photo` to keep the initial migration
 * additive — the MVP renames the concept but not the SQL table.
 */
export const podMedia = createTable(
	"pod_photo",
	{
		id: uuid("id")
			.primaryKey()
			.default(sql`gen_random_uuid()`),
		podId: uuid("pod_id")
			.notNull()
			.references(() => pods.id, { onDelete: "cascade" }),
		uploadedById: varchar("uploaded_by_id", { length: 255 })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		type: mediaTypeEnum("type").notNull().default("photo"),
		status: mediaStatusEnum("status").notNull().default("processing"),
		// Photos: R2 object key for the original.
		storageKey: text("storage_key"),
		// Photos: precomputed variants (400/800/1600) as object keys.
		variants: json("variants").$type<{
			w400?: string;
			w800?: string;
			w1600?: string;
		}>(),
		// Videos: Cloudflare Stream id + HLS playback id.
		streamId: varchar("stream_id", { length: 128 }),
		playbackId: varchar("playback_id", { length: 128 }),
		// Legacy/direct URL fallback for the pre-R2 upload path. New rows leave
		// this null and use storageKey; existing rows keep it populated.
		url: text("url"),
		thumbnailUrl: text("thumbnail_url"),
		caption: text("caption"),
		width: integer("width"),
		height: integer("height"),
		durationSeconds: integer("duration_seconds"),
		size: bigint("size", { mode: "number" }),
		mimeType: varchar("mime_type", { length: 100 }),
		exifStripped: timestamp("exif_stripped_at", { withTimezone: true }),
		exifData: json("exif_data").$type<Record<string, unknown>>(),
		hiddenAt: timestamp("hidden_at", { withTimezone: true }),
		reportCount: integer("report_count").notNull().default(0),
		readyAt: timestamp("ready_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.default(sql`CURRENT_TIMESTAMP`)
			.notNull(),
	},
	(table) => [
		index("pod_media_pod_idx").on(table.podId),
		index("pod_media_uploaded_by_idx").on(table.uploadedById),
		index("pod_media_pod_created_idx").on(table.podId, table.createdAt),
		index("pod_media_status_idx").on(table.status),
	],
);

export const podInvites = createTable(
	"pod_invite",
	{
		id: uuid("id")
			.primaryKey()
			.default(sql`gen_random_uuid()`),
		podId: uuid("pod_id")
			.notNull()
			.references(() => pods.id, { onDelete: "cascade" }),
		invitedById: varchar("invited_by_id", { length: 255 })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		token: varchar("token", { length: 64 }).notNull().unique(),
		// AirDrop-style 6-digit code for the invite circle UX.
		shortCode: varchar("short_code", { length: 8 }),
		role: podMemberRoleEnum("role").notNull().default("member"),
		email: varchar("email", { length: 255 }),
		maxUses: integer("max_uses"),
		useCount: integer("use_count").notNull().default(0),
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		acceptedAt: timestamp("accepted_at", { withTimezone: true }),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.default(sql`CURRENT_TIMESTAMP`)
			.notNull(),
	},
	(table) => [
		index("pod_invite_token_idx").on(table.token),
		index("pod_invite_pod_idx").on(table.podId),
		index("pod_invite_short_code_idx").on(table.shortCode),
	],
);

/**
 * Public-pod follow (feed subscription). Distinct from membership: following a
 * public pod does not grant upload/react rights beyond the base authenticated
 * user permissions.
 */
export const podFollows = createTable(
	"pod_follow",
	{
		id: uuid("id")
			.primaryKey()
			.default(sql`gen_random_uuid()`),
		podId: uuid("pod_id")
			.notNull()
			.references(() => pods.id, { onDelete: "cascade" }),
		userId: varchar("user_id", { length: 255 })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.default(sql`CURRENT_TIMESTAMP`)
			.notNull(),
	},
	(table) => [
		uniqueIndex("pod_follow_unique_idx").on(table.podId, table.userId),
		index("pod_follow_user_idx").on(table.userId),
	],
);

/**
 * One reaction per user per media item. The emoji slug is validated in the
 * policy/service layer against the curated set (see lib/pods/reactions.ts) so
 * the set can evolve without a schema migration.
 */
export const mediaReactions = createTable(
	"pod_media_reaction",
	{
		id: uuid("id")
			.primaryKey()
			.default(sql`gen_random_uuid()`),
		mediaId: uuid("media_id")
			.notNull()
			.references(() => podMedia.id, { onDelete: "cascade" }),
		userId: varchar("user_id", { length: 255 })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		reaction: varchar("reaction", { length: 32 }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.default(sql`CURRENT_TIMESTAMP`)
			.notNull(),
	},
	(table) => [
		uniqueIndex("pod_media_reaction_unique_idx").on(table.mediaId, table.userId),
		index("pod_media_reaction_media_idx").on(table.mediaId),
	],
);

export const mediaReports = createTable(
	"pod_media_report",
	{
		id: uuid("id")
			.primaryKey()
			.default(sql`gen_random_uuid()`),
		mediaId: uuid("media_id")
			.notNull()
			.references(() => podMedia.id, { onDelete: "cascade" }),
		reporterId: varchar("reporter_id", { length: 255 })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		reason: reportReasonEnum("reason").notNull(),
		details: text("details"),
		status: reportStatusEnum("status").notNull().default("pending"),
		reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
		reviewedById: varchar("reviewed_by_id", { length: 255 }).references(
			() => users.id,
			{ onDelete: "set null" },
		),
		createdAt: timestamp("created_at", { withTimezone: true })
			.default(sql`CURRENT_TIMESTAMP`)
			.notNull(),
	},
	(table) => [
		// One report per (media, reporter). Backs the reportMedia dedup so a
		// single account cannot auto-hide media via three self-reports.
		// (LAC-2897 H4.)
		uniqueIndex("pod_media_report_unique_idx").on(table.mediaId, table.reporterId),
		index("pod_media_report_media_idx").on(table.mediaId),
		index("pod_media_report_status_idx").on(table.status),
	],
);

export const podReports = createTable(
	"pod_report",
	{
		id: uuid("id")
			.primaryKey()
			.default(sql`gen_random_uuid()`),
		podId: uuid("pod_id")
			.notNull()
			.references(() => pods.id, { onDelete: "cascade" }),
		reporterId: varchar("reporter_id", { length: 255 })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		reason: reportReasonEnum("reason").notNull(),
		details: text("details"),
		status: reportStatusEnum("status").notNull().default("pending"),
		reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
		reviewedById: varchar("reviewed_by_id", { length: 255 }).references(
			() => users.id,
			{ onDelete: "set null" },
		),
		createdAt: timestamp("created_at", { withTimezone: true })
			.default(sql`CURRENT_TIMESTAMP`)
			.notNull(),
	},
	(table) => [
		index("pod_report_pod_idx").on(table.podId),
		index("pod_report_status_idx").on(table.status),
	],
);

// --- Relations ---

export const podsRelations = relations(pods, ({ one, many }) => ({
	createdBy: one(users, {
		fields: [pods.createdById],
		references: [users.id],
	}),
	members: many(podMembers),
	media: many(podMedia),
	invites: many(podInvites),
	follows: many(podFollows),
}));

export const podMembersRelations = relations(podMembers, ({ one }) => ({
	pod: one(pods, {
		fields: [podMembers.podId],
		references: [pods.id],
	}),
	user: one(users, {
		fields: [podMembers.userId],
		references: [users.id],
	}),
}));

export const podMediaRelations = relations(podMedia, ({ one, many }) => ({
	pod: one(pods, {
		fields: [podMedia.podId],
		references: [pods.id],
	}),
	uploadedBy: one(users, {
		fields: [podMedia.uploadedById],
		references: [users.id],
	}),
	reactions: many(mediaReactions),
}));

export const podInvitesRelations = relations(podInvites, ({ one }) => ({
	pod: one(pods, {
		fields: [podInvites.podId],
		references: [pods.id],
	}),
	invitedBy: one(users, {
		fields: [podInvites.invitedById],
		references: [users.id],
	}),
}));

export const podFollowsRelations = relations(podFollows, ({ one }) => ({
	pod: one(pods, {
		fields: [podFollows.podId],
		references: [pods.id],
	}),
	user: one(users, {
		fields: [podFollows.userId],
		references: [users.id],
	}),
}));

export const mediaReactionsRelations = relations(mediaReactions, ({ one }) => ({
	media: one(podMedia, {
		fields: [mediaReactions.mediaId],
		references: [podMedia.id],
	}),
	user: one(users, {
		fields: [mediaReactions.userId],
		references: [users.id],
	}),
}));

// --- Types ---

export type Pod = typeof pods.$inferSelect;
export type NewPod = typeof pods.$inferInsert;
export type PodMember = typeof podMembers.$inferSelect;
export type NewPodMember = typeof podMembers.$inferInsert;
export type PodMedia = typeof podMedia.$inferSelect;
export type NewPodMedia = typeof podMedia.$inferInsert;
export type PodInvite = typeof podInvites.$inferSelect;
export type NewPodInvite = typeof podInvites.$inferInsert;
export type PodFollow = typeof podFollows.$inferSelect;
export type NewPodFollow = typeof podFollows.$inferInsert;
export type MediaReaction = typeof mediaReactions.$inferSelect;
export type NewMediaReaction = typeof mediaReactions.$inferInsert;
export type MediaReport = typeof mediaReports.$inferSelect;
export type NewMediaReport = typeof mediaReports.$inferInsert;
export type PodReport = typeof podReports.$inferSelect;
export type NewPodReport = typeof podReports.$inferInsert;

// Back-compat alias so existing imports of `podPhotos` keep working during
// the frontend transition; new code should use `podMedia`.
export const podPhotos = podMedia;
export const podPhotosRelations = podMediaRelations;
export type PodPhoto = PodMedia;
export type NewPodPhoto = NewPodMedia;

export type PodVisibility = (typeof podVisibilityEnum.enumValues)[number];
export type PodMemberRole = (typeof podMemberRoleEnum.enumValues)[number];
export type MediaType = (typeof mediaTypeEnum.enumValues)[number];
export type MediaStatus = (typeof mediaStatusEnum.enumValues)[number];
