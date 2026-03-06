/**
 * @fileoverview Database schema for Photo Pods feature
 * @module server/db/pods-schema
 */

import { relations, sql } from "drizzle-orm";
import {
	index,
	integer,
	json,
	pgEnum,
	pgTableCreator,
	text,
	timestamp,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";
import { env } from "@/env";
import { users } from "./schema";

const createTable = pgTableCreator((name) => `${env?.DB_PREFIX ?? ""}_${name}`);

// Enums
export const podVisibilityEnum = pgEnum("pod_visibility", [
	"public",
	"private",
	"invite-only",
]);

export const podMemberRoleEnum = pgEnum("pod_member_role", [
	"owner",
	"contributor",
	"viewer",
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
		visibility: podVisibilityEnum("visibility").notNull().default("invite-only"),
		createdById: varchar("created_by_id", { length: 255 })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
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
		role: podMemberRoleEnum("role").notNull().default("viewer"),
		joinedAt: timestamp("joined_at", { withTimezone: true })
			.default(sql`CURRENT_TIMESTAMP`)
			.notNull(),
	},
	(table) => [
		index("pod_member_pod_idx").on(table.podId),
		index("pod_member_user_idx").on(table.userId),
	],
);

export const podPhotos = createTable(
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
		url: text("url").notNull(),
		thumbnailUrl: text("thumbnail_url"),
		caption: text("caption"),
		width: integer("width"),
		height: integer("height"),
		size: integer("size"),
		mimeType: varchar("mime_type", { length: 100 }),
		exifData: json("exif_data").$type<Record<string, unknown>>(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.default(sql`CURRENT_TIMESTAMP`)
			.notNull(),
	},
	(table) => [
		index("pod_photo_pod_idx").on(table.podId),
		index("pod_photo_uploaded_by_idx").on(table.uploadedById),
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
		role: podMemberRoleEnum("role").notNull().default("viewer"),
		email: varchar("email", { length: 255 }),
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		acceptedAt: timestamp("accepted_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.default(sql`CURRENT_TIMESTAMP`)
			.notNull(),
	},
	(table) => [
		index("pod_invite_token_idx").on(table.token),
		index("pod_invite_pod_idx").on(table.podId),
	],
);

// --- Relations ---

export const podsRelations = relations(pods, ({ one, many }) => ({
	createdBy: one(users, {
		fields: [pods.createdById],
		references: [users.id],
	}),
	members: many(podMembers),
	photos: many(podPhotos),
	invites: many(podInvites),
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

export const podPhotosRelations = relations(podPhotos, ({ one }) => ({
	pod: one(pods, {
		fields: [podPhotos.podId],
		references: [pods.id],
	}),
	uploadedBy: one(users, {
		fields: [podPhotos.uploadedById],
		references: [users.id],
	}),
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

// --- Types ---

export type Pod = typeof pods.$inferSelect;
export type NewPod = typeof pods.$inferInsert;
export type PodMember = typeof podMembers.$inferSelect;
export type NewPodMember = typeof podMembers.$inferInsert;
export type PodPhoto = typeof podPhotos.$inferSelect;
export type NewPodPhoto = typeof podPhotos.$inferInsert;
export type PodInvite = typeof podInvites.$inferSelect;
export type NewPodInvite = typeof podInvites.$inferInsert;
