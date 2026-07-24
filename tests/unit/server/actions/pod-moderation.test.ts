import { beforeEach, describe, expect, it, vi } from "vitest";

// Records every update/select issued inside the transaction so tests can
// assert which tables were written and with what values.
const mocks = vi.hoisted(() => ({
	session: null as any,
	isAdminResult: false,
	reportRows: [] as any[],
	activeReportCount: 0,
	updates: [] as { table: any; set: any; where: any }[],
	selectWheres: [] as any[],
}));

vi.mock("@/server/auth", () => ({ auth: vi.fn(async () => mocks.session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/services/admin-service", () => ({
	isAdmin: vi.fn(async () => mocks.isAdminResult),
}));

vi.mock("@/server/db", () => {
	const makeTx = () => ({
		update: vi.fn((table: any) => {
			const entry: any = { table, set: null, where: null };
			mocks.updates.push(entry);
			// Awaitable directly (media/pod updates) or via .returning() (reports).
			const afterWhere: any = Promise.resolve(undefined);
			afterWhere.returning = () => Promise.resolve(mocks.reportRows);
			const chain: any = {
				set: vi.fn((s: any) => {
					entry.set = s;
					return chain;
				}),
				where: vi.fn((w: any) => {
					entry.where = w;
					return afterWhere;
				}),
			};
			return chain;
		}),
		select: vi.fn(() => ({
			from: vi.fn(() => ({
				where: vi.fn((w: any) => {
					mocks.selectWheres.push(w);
					return Promise.resolve([{ count: mocks.activeReportCount }]);
				}),
			})),
		})),
	});
	return {
		db: { transaction: vi.fn(async (fn: any) => fn(makeTx())) },
	};
});

import { PgDialect } from "drizzle-orm/pg-core";

import {
	reviewMediaReport,
	reviewPodReport,
} from "@/server/actions/pod-moderation";
import {
	mediaReports,
	podMedia,
	podReports,
	pods,
} from "@/server/db/pods-schema";

const compile = (node: any) => new PgDialect().sqlToQuery(node);

const updatesFor = (table: any) => mocks.updates.filter((u) => u.table === table);

const asAdmin = () => {
	mocks.session = { user: { id: "admin-1", email: "admin@example.com" } };
	mocks.isAdminResult = true;
};

beforeEach(() => {
	mocks.session = null;
	mocks.isAdminResult = false;
	mocks.reportRows = [];
	mocks.activeReportCount = 0;
	mocks.updates = [];
	mocks.selectWheres = [];
});

describe("reviewMediaReport", () => {
	it("rejects unauthenticated users without touching the database", async () => {
		await expect(reviewMediaReport("r1", "confirmed")).rejects.toThrow(
			/unauthorized/i,
		);
		expect(mocks.updates).toHaveLength(0);
	});

	it("rejects authenticated non-admins", async () => {
		mocks.session = { user: { id: "u1", email: "user@example.com" } };
		mocks.isAdminResult = false;
		await expect(reviewMediaReport("r1", "confirmed")).rejects.toThrow(
			/admin/i,
		);
		expect(mocks.updates).toHaveLength(0);
	});

	it("rejects an invalid verdict", async () => {
		asAdmin();
		await expect(
			reviewMediaReport("r1", "escalated" as any),
		).rejects.toThrow(/verdict/i);
		expect(mocks.updates).toHaveLength(0);
	});

	it("throws when the report is missing or already reviewed", async () => {
		asAdmin();
		mocks.reportRows = [];
		await expect(reviewMediaReport("r1", "confirmed")).rejects.toThrow(
			/already reviewed|not found/i,
		);
	});

	it("confirm marks the report reviewed and hides the media", async () => {
		asAdmin();
		mocks.reportRows = [{ mediaId: "m1" }];
		const result = await reviewMediaReport("r1", "confirmed");
		expect(result).toEqual({ ok: true });

		const [reportUpdate] = updatesFor(mediaReports);
		expect(reportUpdate.set.status).toBe("confirmed");
		expect(reportUpdate.set.reviewedById).toBe("admin-1");
		expect(reportUpdate.set.reviewedAt).toBeInstanceOf(Date);
		// Only pending reports are reviewable (double-review guard).
		expect(compile(reportUpdate.where).params).toContain("pending");

		const [mediaUpdate] = updatesFor(podMedia);
		expect(mediaUpdate).toBeDefined();
		// Preserves an existing hidden_at timestamp instead of overwriting it.
		expect(compile(mediaUpdate.set.hiddenAt).sql.toLowerCase()).toContain(
			"coalesce",
		);
	});

	it("dismiss keeps auto-hidden media hidden while other reports are active", async () => {
		asAdmin();
		mocks.reportRows = [{ mediaId: "m1" }];
		mocks.activeReportCount = 2;
		await reviewMediaReport("r1", "dismissed");

		const [reportUpdate] = updatesFor(mediaReports);
		expect(reportUpdate.set.status).toBe("dismissed");
		expect(updatesFor(podMedia)).toHaveLength(0);
	});

	it("dismissing the last active report restores media visibility", async () => {
		asAdmin();
		mocks.reportRows = [{ mediaId: "m1" }];
		mocks.activeReportCount = 0;
		await reviewMediaReport("r1", "dismissed");

		const [mediaUpdate] = updatesFor(podMedia);
		expect(mediaUpdate).toBeDefined();
		expect(mediaUpdate.set.hiddenAt).toBeNull();
	});
});

describe("reviewPodReport", () => {
	it("rejects non-admins", async () => {
		mocks.session = { user: { id: "u1", email: "user@example.com" } };
		await expect(reviewPodReport("r1", "confirmed")).rejects.toThrow(/admin/i);
		expect(mocks.updates).toHaveLength(0);
	});

	it("confirm below the threshold does not hide the pod", async () => {
		asAdmin();
		mocks.reportRows = [{ podId: "p1" }];
		mocks.activeReportCount = 4;
		await reviewPodReport("r1", "confirmed");

		const [reportUpdate] = updatesFor(podReports);
		expect(reportUpdate.set.status).toBe("confirmed");
		expect(updatesFor(pods)).toHaveLength(0);
	});

	it("confirm hides the pod once 5 reports are confirmed (LAC-2854 §Moderation)", async () => {
		asAdmin();
		mocks.reportRows = [{ podId: "p1" }];
		mocks.activeReportCount = 5;
		await reviewPodReport("r1", "confirmed");

		const [podUpdate] = updatesFor(pods);
		expect(podUpdate).toBeDefined();
		expect(compile(podUpdate.set.hiddenAt).sql.toLowerCase()).toContain(
			"coalesce",
		);
	});

	it("dismiss only updates the report", async () => {
		asAdmin();
		mocks.reportRows = [{ podId: "p1" }];
		await reviewPodReport("r1", "dismissed");

		const [reportUpdate] = updatesFor(podReports);
		expect(reportUpdate.set.status).toBe("dismissed");
		expect(updatesFor(pods)).toHaveLength(0);
		// No count query needed on dismissal — pods only hide via confirmed count.
		expect(mocks.selectWheres).toHaveLength(0);
	});
});
