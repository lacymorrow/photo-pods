/**
 * Read side of the Photopods moderation queue (LAC-2911). Server Components
 * fetch pending reports here; verdict mutations live in
 * server/actions/pod-moderation.ts.
 */

import { asc, eq } from "drizzle-orm";

import { db } from "@/server/db";
import {
	mediaReports,
	podMedia,
	podReports,
	pods,
} from "@/server/db/pods-schema";
import { users } from "@/server/db/schema";

// Oldest-first so the queue surfaces the reports closest to breaching the
// <4h review SLA (LAC-2854 §Quality Gates). Capped defensively; a queue this
// deep is an incident, not a pagination problem.
const QUEUE_LIMIT = 200;

export type PendingMediaReport = Awaited<
	ReturnType<typeof getPendingMediaReports>
>[number];
export type PendingPodReport = Awaited<
	ReturnType<typeof getPendingPodReports>
>[number];

export const getPendingMediaReports = async () => {
	if (!db) return [];
	return db
		.select({
			id: mediaReports.id,
			reason: mediaReports.reason,
			details: mediaReports.details,
			createdAt: mediaReports.createdAt,
			reporterName: users.name,
			media: {
				id: podMedia.id,
				type: podMedia.type,
				url: podMedia.url,
				thumbnailUrl: podMedia.thumbnailUrl,
				caption: podMedia.caption,
				hiddenAt: podMedia.hiddenAt,
				reportCount: podMedia.reportCount,
			},
			pod: {
				id: pods.id,
				name: pods.name,
				visibility: pods.visibility,
			},
		})
		.from(mediaReports)
		.innerJoin(podMedia, eq(mediaReports.mediaId, podMedia.id))
		.innerJoin(pods, eq(podMedia.podId, pods.id))
		.innerJoin(users, eq(mediaReports.reporterId, users.id))
		.where(eq(mediaReports.status, "pending"))
		.orderBy(asc(mediaReports.createdAt))
		.limit(QUEUE_LIMIT);
};

export const getPendingPodReports = async () => {
	if (!db) return [];
	return db
		.select({
			id: podReports.id,
			reason: podReports.reason,
			details: podReports.details,
			createdAt: podReports.createdAt,
			reporterName: users.name,
			pod: {
				id: pods.id,
				name: pods.name,
				visibility: pods.visibility,
				hiddenAt: pods.hiddenAt,
			},
		})
		.from(podReports)
		.innerJoin(pods, eq(podReports.podId, pods.id))
		.innerJoin(users, eq(podReports.reporterId, users.id))
		.where(eq(podReports.status, "pending"))
		.orderBy(asc(podReports.createdAt))
		.limit(QUEUE_LIMIT);
};
