"use server";

/**
 * Admin moderation actions for the Photopods report queue (LAC-2911).
 *
 * Reviews move a report pending → confirmed | dismissed and stamp
 * reviewedById/reviewedAt so the <4h moderation SLA (LAC-2854 §Moderation)
 * is measurable. Visibility side effects:
 *  - confirmed media report → media hidden immediately (platform action).
 *  - dismissing the last active (pending/confirmed) report on hidden media
 *    → media restored, undoing a false-positive auto-hide.
 *  - 5th confirmed pod report → pod hidden (spec threshold).
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { routes } from "@/config/routes";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import {
	mediaReports,
	podMedia,
	podReports,
	pods,
} from "@/server/db/pods-schema";
import { isAdmin } from "@/server/services/admin-service";

export type ReportVerdict = "confirmed" | "dismissed";

// LAC-2854 §Moderation: "After 5 confirmed reports against a pod, pod is
// hidden pending review."
const CONFIRMED_POD_REPORTS_TO_HIDE = 5;

const requireAdmin = async () => {
	const session = await auth();
	const user = session?.user;
	if (!user?.id) throw new Error("Unauthorized");
	const admin = await isAdmin({ email: user.email, userId: user.id });
	if (!admin) throw new Error("Admin access required");
	return user;
};

const requireDb = () => {
	if (!db) throw new Error("Database not initialized");
	return db;
};

const assertVerdict = (verdict: string): ReportVerdict => {
	if (verdict !== "confirmed" && verdict !== "dismissed") {
		throw new Error("Invalid verdict");
	}
	return verdict;
};

export const reviewMediaReport = async (
	reportId: string,
	verdict: ReportVerdict,
) => {
	const admin = await requireAdmin();
	const resolved = assertVerdict(verdict);
	const database = requireDb();

	await database.transaction(async (tx) => {
		// The status=pending guard makes concurrent reviews safe: the second
		// reviewer matches zero rows and gets the "already reviewed" error.
		const [report] = await tx
			.update(mediaReports)
			.set({
				status: resolved,
				reviewedAt: new Date(),
				reviewedById: admin.id,
			})
			.where(
				and(eq(mediaReports.id, reportId), eq(mediaReports.status, "pending")),
			)
			.returning({ mediaId: mediaReports.mediaId });
		if (!report) throw new Error("Report not found or already reviewed");

		if (resolved === "confirmed") {
			await tx
				.update(podMedia)
				.set({ hiddenAt: sql`COALESCE(${podMedia.hiddenAt}, NOW())` })
				.where(eq(podMedia.id, report.mediaId));
			return;
		}

		// Dismissal: media hidden_at is only ever set by the report pipeline
		// (auto-hide at 3 reports, or a confirmed review above), so once no
		// pending/confirmed reports remain the hide has no support — restore.
		const [active] = await tx
			.select({ count: sql<number>`count(*)` })
			.from(mediaReports)
			.where(
				and(
					eq(mediaReports.mediaId, report.mediaId),
					inArray(mediaReports.status, ["pending", "confirmed"]),
				),
			);
		if (Number(active?.count ?? 0) === 0) {
			await tx
				.update(podMedia)
				.set({ hiddenAt: null })
				.where(eq(podMedia.id, report.mediaId));
		}
	});

	revalidatePath(routes.admin.moderationPods);
	return { ok: true };
};

export const reviewPodReport = async (
	reportId: string,
	verdict: ReportVerdict,
) => {
	const admin = await requireAdmin();
	const resolved = assertVerdict(verdict);
	const database = requireDb();

	await database.transaction(async (tx) => {
		const [report] = await tx
			.update(podReports)
			.set({
				status: resolved,
				reviewedAt: new Date(),
				reviewedById: admin.id,
			})
			.where(and(eq(podReports.id, reportId), eq(podReports.status, "pending")))
			.returning({ podId: podReports.podId });
		if (!report) throw new Error("Report not found or already reviewed");

		if (resolved !== "confirmed") return;

		const [confirmed] = await tx
			.select({ count: sql<number>`count(*)` })
			.from(podReports)
			.where(
				and(
					eq(podReports.podId, report.podId),
					eq(podReports.status, "confirmed"),
				),
			);
		if (Number(confirmed?.count ?? 0) >= CONFIRMED_POD_REPORTS_TO_HIDE) {
			await tx
				.update(pods)
				.set({
					hiddenAt: sql`COALESCE(${pods.hiddenAt}, NOW())`,
					updatedAt: new Date(),
				})
				.where(eq(pods.id, report.podId));
		}
	});

	revalidatePath(routes.admin.moderationPods);
	return { ok: true };
};
