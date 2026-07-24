import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression tests for LAC-2913: the 10,000-item pod cap must be enforced in
// the policy layer (defense-in-depth behind the client-side batch cap).

const mocks = vi.hoisted(() => ({
	pod: null as any,
	membership: null as any,
}));

vi.mock("@/server/db", () => ({
	db: {
		query: {
			pods: { findFirst: vi.fn(async () => mocks.pod) },
			podMembers: { findFirst: vi.fn(async () => mocks.membership) },
		},
	},
}));

import { MAX_MEDIA_PER_POD } from "@/lib/pods/limits";
import {
	canUpload,
	guardUpload,
	hasMediaCapacity,
	type PolicyContext,
} from "@/server/services/pod-policy";

const ctxOf = (overrides: {
	visibility?: "private" | "group" | "public";
	mediaCount?: number;
	role?: "owner" | "member" | null;
	hiddenAt?: Date | null;
	userId?: string | null;
}): PolicyContext => ({
	pod: {
		id: "pod-1",
		visibility: overrides.visibility ?? "group",
		createdById: "owner-1",
		hiddenAt: overrides.hiddenAt ?? null,
		mediaCount: overrides.mediaCount ?? 0,
	},
	viewer: { userId: overrides.userId === undefined ? "user-1" : overrides.userId },
	membership: overrides.role ? { role: overrides.role } : null,
});

describe("pod capacity policy (LAC-2913)", () => {
	beforeEach(() => {
		mocks.pod = null;
		mocks.membership = null;
	});

	describe("hasMediaCapacity", () => {
		it("has capacity below the cap", () => {
			expect(hasMediaCapacity(ctxOf({ mediaCount: MAX_MEDIA_PER_POD - 1 }))).toBe(true);
		});

		it("is full at the cap", () => {
			expect(hasMediaCapacity(ctxOf({ mediaCount: MAX_MEDIA_PER_POD }))).toBe(false);
		});

		it("is full above the cap", () => {
			expect(hasMediaCapacity(ctxOf({ mediaCount: MAX_MEDIA_PER_POD + 5 }))).toBe(false);
		});
	});

	describe("canUpload", () => {
		it("allows a member of a group pod with capacity", () => {
			expect(canUpload(ctxOf({ role: "member", mediaCount: 42 }))).toBe(true);
		});

		it("denies a member of a group pod at the cap", () => {
			expect(canUpload(ctxOf({ role: "member", mediaCount: MAX_MEDIA_PER_POD }))).toBe(false);
		});

		it("denies the owner of a private pod at the cap", () => {
			expect(
				canUpload(
					ctxOf({ visibility: "private", role: "owner", mediaCount: MAX_MEDIA_PER_POD }),
				),
			).toBe(false);
		});

		it("still denies non-members regardless of capacity", () => {
			expect(canUpload(ctxOf({ role: null, mediaCount: 0 }))).toBe(false);
		});
	});

	describe("guardUpload", () => {
		const dbPod = (mediaCount: number) => ({
			id: "pod-1",
			visibility: "group",
			createdById: "owner-1",
			hiddenAt: null,
			mediaCount,
		});

		it("returns the context for a member with capacity", async () => {
			mocks.pod = dbPod(10);
			mocks.membership = { role: "member" };
			const ctx = await guardUpload("pod-1", { userId: "user-1" });
			expect(ctx.pod.mediaCount).toBe(10);
		});

		it("throws pod_full (409) for a member when the pod is at the cap", async () => {
			mocks.pod = dbPod(MAX_MEDIA_PER_POD);
			mocks.membership = { role: "member" };
			await expect(guardUpload("pod-1", { userId: "user-1" })).rejects.toMatchObject({
				code: "pod_full",
				status: 409,
			});
		});

		it("throws forbidden (403) for a non-member even when the pod is full", async () => {
			mocks.pod = dbPod(MAX_MEDIA_PER_POD);
			mocks.membership = null;
			await expect(guardUpload("pod-1", { userId: "user-2" })).rejects.toMatchObject({
				code: "forbidden",
				status: 403,
			});
		});

		it("throws unauthenticated (401) for guests", async () => {
			mocks.pod = dbPod(0);
			mocks.membership = null;
			await expect(guardUpload("pod-1", { userId: null })).rejects.toMatchObject({
				code: "unauthenticated",
				status: 401,
			});
		});

		it("throws not_found (404) when the pod does not exist", async () => {
			mocks.pod = null;
			await expect(guardUpload("missing", { userId: "user-1" })).rejects.toMatchObject({
				code: "not_found",
				status: 404,
			});
		});
	});
});
