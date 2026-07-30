import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock state — the pods action module opens a DB transaction with a
// chained query builder (update().set().where().returning()). We give it a
// fake tx whose builder methods thread all the way through to a caller-set
// `claimResult`, so a single test can flip the invite from "slot free" to
// "already claimed" without wiring a real DB.
const mocks = vi.hoisted(() => ({
	auth: vi.fn(async () => ({ user: { id: "user-1", role: "user" } })),
	inviteRow: null as any,
	existingMember: null as any,
	claimResult: [] as { id: string }[],
	insertedMembership: 0,
	revalidatePath: vi.fn(),
}));

vi.mock("@/server/auth", () => ({ auth: mocks.auth }));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

// Every "processing" module the action imports touches sharp / next-server /
// storage — stub them out so importing pods.ts doesn't drag in the world.
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
	checkReportRateLimit: vi.fn(async () => undefined),
	checkUploadRateLimit: vi.fn(async () => undefined),
}));

vi.mock("@/server/services/pod-policy", async (orig) => {
	const actual = await orig<typeof import("@/server/services/pod-policy")>();
	return { ...actual, guardPod: vi.fn() };
});

vi.mock("@/server/services/pod-reactions", () => ({
	resolveMediaPod: vi.fn(),
	setReaction: vi.fn(),
	getReactionCounts: vi.fn(async () => ({})),
	getViewerReactions: vi.fn(async () => ({})),
	getReactors: vi.fn(async () => []),
}));

// Chainable no-op that just returns itself until awaited — Drizzle-shaped
// enough for the update/insert/delete calls inside the transaction that we
// don't care about (member insert, memberCount bump).
const chainable = () => {
	const p: any = new Proxy(function () {}, {
		get: (_t, prop) => {
			if (prop === "then") return undefined;
			return () => p;
		},
		apply: () => p,
	});
	return p;
};

vi.mock("@/server/db", () => ({
	db: {
		query: {
			podInvites: {
				findFirst: vi.fn(async () => mocks.inviteRow),
			},
			podMembers: {
				findFirst: vi.fn(async () => mocks.existingMember),
			},
		},
		transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => {
			// Fake tx: update() returns a builder that eventually resolves to
			// mocks.claimResult from .returning(); insert()/update() calls for
			// the member row are absorbed by the generic chainable proxy.
			const tx: any = {
				update: () => ({
					set: () => ({
						where: () => ({
							returning: async () => mocks.claimResult,
						}),
					}),
				}),
				insert: () => ({
					values: async () => {
						mocks.insertedMembership += 1;
					},
				}),
				delete: () => chainable(),
			};
			return cb(tx);
		}),
	},
	isDatabaseInitialized: async () => true,
	safeDbExecute: async (_cb: unknown, def: unknown) => def,
}));

import { acceptInvite } from "@/server/actions/pods";

describe("acceptInvite — short-code protection (LAC-2914, LAC-2897)", () => {
	beforeEach(() => {
		mocks.inviteRow = null;
		mocks.existingMember = null;
		mocks.claimResult = [{ id: "invite-1" }];
		mocks.insertedMembership = 0;
		mocks.revalidatePath.mockClear();
	});

	it("rejects a short code without a podId (brute-force guard)", async () => {
		// Six-digit codes are only ~1M keyspace — accepting them without a
		// pod scope means an attacker can enumerate them platform-wide.
		await expect(acceptInvite("123456")).rejects.toThrow(/Pod is required/i);
	});

	it("accepts a long token without a podId", async () => {
		// A 64-hex secret is unforgeable on its own; the podId scoping only
		// matters for the small short-code keyspace.
		mocks.inviteRow = {
			id: "invite-1",
			podId: "pod-1",
			revokedAt: null,
			expiresAt: null,
			acceptedAt: null,
			pod: { id: "pod-1", name: "test" },
		};
		const longToken = "a".repeat(64);
		const result = await acceptInvite(longToken);
		expect(result.alreadyMember).toBe(false);
		expect(mocks.insertedMembership).toBe(1);
	});

	it("enforces the per-user rate limit on short-code attempts", async () => {
		// 5 attempts per minute — the sixth throws. Miss counts, so we point
		// findFirst at "invite not found" and let the action's own guard
		// fail (still counts as an attempt) five times, then assert the sixth
		// bails on the rate limit instead of hitting the DB.
		mocks.inviteRow = null;
		for (let i = 0; i < 5; i++) {
			await expect(acceptInvite("999999", { podId: "pod-1" })).rejects.toThrow(
				/Invalid invite/i,
			);
		}
		await expect(acceptInvite("999999", { podId: "pod-1" })).rejects.toThrow(
			/Too many/i,
		);
	});
});

describe("acceptInvite — TOCTOU maxUses consumption (LAC-2897)", () => {
	beforeEach(() => {
		mocks.existingMember = null;
		mocks.insertedMembership = 0;
	});

	it("throws when the atomic UPDATE returns zero rows (slot lost to a race)", async () => {
		// The action UPDATEs with a `useCount < maxUses` guard and only
		// commits the membership if the UPDATE returned a row. A concurrent
		// accept that beat us to the slot produces an empty returning set —
		// we must reject, not silently drop the join.
		mocks.inviteRow = {
			id: "invite-1",
			podId: "pod-1",
			revokedAt: null,
			expiresAt: null,
			acceptedAt: null,
			pod: { id: "pod-1", name: "test" },
		};
		mocks.claimResult = [];

		const longToken = "b".repeat(64);
		await expect(acceptInvite(longToken)).rejects.toThrow(/fully used/i);
		// And no membership row is written when the slot claim failed.
		expect(mocks.insertedMembership).toBe(0);
	});

	it("returns early when the caller is already a member (no double-consume)", async () => {
		// A returning member accepting the same link should not burn a slot
		// on the invite. Existence check runs before the UPDATE.
		mocks.inviteRow = {
			id: "invite-1",
			podId: "pod-1",
			revokedAt: null,
			expiresAt: null,
			acceptedAt: null,
			pod: { id: "pod-1", name: "test" },
		};
		mocks.existingMember = { podId: "pod-1", userId: "user-1", role: "member" };

		const longToken = "c".repeat(64);
		const result = await acceptInvite(longToken);
		expect(result.alreadyMember).toBe(true);
		expect(mocks.insertedMembership).toBe(0);
	});

	it("rejects a revoked invite", async () => {
		mocks.inviteRow = {
			id: "invite-1",
			podId: "pod-1",
			revokedAt: new Date("2026-01-01"),
			expiresAt: null,
			acceptedAt: null,
			pod: { id: "pod-1" },
		};
		const longToken = "d".repeat(64);
		await expect(acceptInvite(longToken)).rejects.toThrow(/revoked/i);
	});

	it("rejects an expired invite", async () => {
		mocks.inviteRow = {
			id: "invite-1",
			podId: "pod-1",
			revokedAt: null,
			expiresAt: new Date("2020-01-01"),
			acceptedAt: null,
			pod: { id: "pod-1" },
		};
		const longToken = "e".repeat(64);
		await expect(acceptInvite(longToken)).rejects.toThrow(/expired/i);
	});
});
