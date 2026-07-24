import { beforeEach, describe, expect, it, vi } from "vitest";

// The transaction has three phases: dedup insert, count bump, auto-hide
// UPDATE. We record every one so tests can assert exact side effects
// (particularly: no bump/hide on dedup, hide fires when the SQL condition
// is satisfied).
const mocks = vi.hoisted(() => ({
	auth: vi.fn(async () => ({ user: { id: "reporter-1", role: "user" } })),
	resolveMediaPod: vi.fn(),
	// [reason, insertedRowCount] — tests set the row count to 0 (dedup) or 1.
	insertReturning: 1,
	updates: [] as string[],
	executes: [] as string[],
	checkReportRateLimit: vi.fn(async () => undefined),
}));

vi.mock("@/server/auth", () => ({ auth: mocks.auth }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/server/services/pod-media-processing", () => ({
	stripExif: vi.fn(),
	hasGpsExif: vi.fn(async () => false),
}));

vi.mock("@/server/services/pod-storage", () => ({
	isStorageConfigured: () => false,
	loadStorageConfig: vi.fn(),
	buildStorageKey: vi.fn(),
	fetchObject: vi.fn(),
	fetchObjectRange: vi.fn(),
	presign: vi.fn(),
	publicUrlForKey: vi.fn(),
	putObject: vi.fn(),
}));

vi.mock("@/server/services/pod-storage-cleanup", () => ({
	collectMediaKeys: vi.fn(() => []),
	deleteObjectsWithRetry: vi.fn(async () => undefined),
}));

vi.mock("@/server/services/pod-video-processing", () => ({
	hasVideoGpsMetadata: vi.fn(async () => false),
	scrubMp4Metadata: vi.fn(),
}));

vi.mock("@/server/services/pod-rate-limit", () => ({
	checkReportRateLimit: mocks.checkReportRateLimit,
	checkUploadRateLimit: vi.fn(async () => undefined),
}));

vi.mock("@/server/services/pod-policy", async (orig) => {
	const actual = await orig<typeof import("@/server/services/pod-policy")>();
	return { ...actual, guardPod: vi.fn(), loadPolicyContext: vi.fn() };
});

vi.mock("@/server/services/pod-reactions", () => ({
	resolveMediaPod: mocks.resolveMediaPod,
	setReaction: vi.fn(),
	getReactionCounts: vi.fn(async () => ({})),
	getViewerReactions: vi.fn(async () => ({})),
	getReactors: vi.fn(async () => []),
}));

vi.mock("@/server/db/pods-schema", async () => {
	const actual = await vi.importActual<any>("@/server/db/pods-schema");
	// Add a mediaReports export because pods.ts dynamic-imports it. It only
	// needs to exist as a Drizzle-ish handle for the fake tx to accept.
	return {
		...actual,
		mediaReports: {
			mediaId: "mediaId",
			reporterId: "reporterId",
		},
	};
});

vi.mock("@/server/db", () => ({
	db: {
		query: {},
		transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => {
			const tx: any = {
				insert: () => ({
					values: () => ({
						onConflictDoNothing: () => ({
							returning: async () =>
								mocks.insertReturning === 0
									? []
									: [{ id: "report-1" }],
						}),
					}),
				}),
				update: () => ({
					set: (patch: any) => ({
						where: async () => {
							// patch objects contain Drizzle sql`` tags with
							// back-references to their PgTable — stringifying
							// hits a cycle. Record the column keys only.
							mocks.updates.push(Object.keys(patch).join(","));
							return undefined;
						},
					}),
				}),
				execute: async (sqlObj: any) => {
					// Drizzle sql`` tags carry a `.queryChunks` array; we just
					// record the fact that an execute() ran so tests can
					// assert the auto-hide fired.
					mocks.executes.push(String(sqlObj?.queryChunks ?? sqlObj));
					return undefined;
				},
			};
			return cb(tx);
		}),
	},
	isDatabaseInitialized: async () => true,
	safeDbExecute: async (_cb: unknown, def: unknown) => def,
}));

import { reportMedia } from "@/server/actions/pods";

describe("reportMedia — dedup + auto-hide (LAC-2914, LAC-2897 H4/M3)", () => {
	beforeEach(() => {
		mocks.insertReturning = 1;
		mocks.updates = [];
		mocks.executes = [];
		mocks.resolveMediaPod.mockReset();
		mocks.checkReportRateLimit.mockClear();
		mocks.resolveMediaPod.mockResolvedValue({
			id: "media-1",
			podId: "pod-1",
			status: "ready",
			hiddenAt: null,
			uploadedById: "uploader-1",
		});
	});

	it("throws when the media does not exist", async () => {
		mocks.resolveMediaPod.mockResolvedValueOnce(null);
		await expect(reportMedia("missing", "spam")).rejects.toThrow(/not found/i);
	});

	it("returns alreadyReported=true and does NOT bump the counter on dedup", async () => {
		// The (mediaId, reporterId) unique constraint kicks in →
		// onConflictDoNothing returns []. A single user must not be able to
		// stack report_count past 1 for the same media.
		mocks.insertReturning = 0;
		const result = await reportMedia("media-1", "spam");
		expect(result).toEqual({ ok: true, alreadyReported: true });
		// Zero side-effects: no counter bump, no auto-hide check.
		expect(mocks.updates).toHaveLength(0);
		expect(mocks.executes).toHaveLength(0);
	});

	it("bumps the counter and evaluates the auto-hide SQL on a fresh report", async () => {
		mocks.insertReturning = 1;
		const result = await reportMedia("media-1", "nudity_sexual", "context");
		expect(result).toEqual({ ok: true, alreadyReported: false });
		// Exactly one counter bump.
		expect(mocks.updates).toHaveLength(1);
		expect(mocks.updates[0]).toContain("reportCount");
		// Exactly one auto-hide SQL execution (the "report_count >= 3" gate
		// is enforced in SQL, so we assert the statement ran regardless of
		// whether it flipped hidden_at this time).
		expect(mocks.executes).toHaveLength(1);
	});

	it("enforces the per-user report rate limit", async () => {
		mocks.checkReportRateLimit.mockRejectedValueOnce(
			new Error("Rate limit exceeded"),
		);
		await expect(reportMedia("media-1", "spam")).rejects.toThrow(/rate limit/i);
	});
});
