import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted DB mock. loadPolicyContext hits the database; the pure predicates
// (canView / canUpload / canReact / canInvite / canModerate / canFollow) do
// not — those we exercise directly with hand-built PolicyContext objects.
const dbState = vi.hoisted(() => ({
	pod: null as any,
	membership: null as any,
}));

vi.mock("@/server/db", () => ({
	db: {
		query: {
			pods: {
				findFirst: vi.fn(async () => dbState.pod),
			},
			podMembers: {
				findFirst: vi.fn(async () => dbState.membership),
			},
		},
	},
}));

import {
	canFollow,
	canInvite,
	canModerate,
	canReact,
	canUpload,
	canView,
	guardPod,
	loadPolicyContext,
} from "@/server/services/pod-policy";

// Small factory so the matrix stays legible. Consumers override only what
// matters for the row under test.
const ctx = (opts: {
	visibility: "private" | "group" | "public";
	role?: "owner" | "member" | null;
	viewerId?: string | null;
	isAdmin?: boolean;
	hiddenAt?: Date | null;
}) => ({
	pod: {
		id: "pod-1",
		visibility: opts.visibility,
		createdById: "owner-1",
		hiddenAt: opts.hiddenAt ?? null,
		retainLocationExif: false,
	},
	viewer: {
		userId: opts.viewerId === undefined ? "u-1" : opts.viewerId,
		isAdmin: opts.isAdmin ?? false,
	},
	membership: opts.role ? { role: opts.role } : null,
});

describe("pod-policy: privacy matrix (LAC-2914, LAC-2855 §2.5)", () => {
	// The 11 rows from the test plan. Explicit tuples so a regression on any
	// single cell fails a single, obvious assertion — no cleverness in the
	// loop layer.
	const rows: Array<{
		name: string;
		vis: "private" | "group" | "public";
		role?: "owner" | "member" | null;
		viewerId?: string | null;
		view: boolean;
		upload: boolean;
		react: boolean;
	}> = [
		// Private pod: owner-only across the board. Membership rows that
		// linger after a group→private downgrade must not grant access.
		{ name: "private / owner", vis: "private", role: "owner", view: true, upload: true, react: true },
		{ name: "private / stale member", vis: "private", role: "member", view: false, upload: false, react: false },
		{ name: "private / stranger", vis: "private", role: null, view: false, upload: false, react: false },
		{ name: "private / guest", vis: "private", role: null, viewerId: null, view: false, upload: false, react: false },
		// Group pod: any member reads/writes/reacts; non-members are locked out.
		{ name: "group / owner", vis: "group", role: "owner", view: true, upload: true, react: true },
		{ name: "group / member", vis: "group", role: "member", view: true, upload: true, react: true },
		{ name: "group / non-member", vis: "group", role: null, view: false, upload: false, react: false },
		{ name: "group / guest", vis: "group", role: null, viewerId: null, view: false, upload: false, react: false },
		// Public pod: world-viewable. Uploads require membership (invite-only
		// per the board clarification). Reactions require any authenticated
		// user, no membership needed.
		{ name: "public / owner", vis: "public", role: "owner", view: true, upload: true, react: true },
		{ name: "public / authed non-member", vis: "public", role: null, view: true, upload: false, react: true },
		{ name: "public / guest", vis: "public", role: null, viewerId: null, view: true, upload: false, react: false },
	];

	for (const row of rows) {
		it(row.name, () => {
			const c = ctx({
				visibility: row.vis,
				role: row.role,
				viewerId: row.viewerId,
			});
			expect(canView(c)).toBe(row.view);
			expect(canUpload(c)).toBe(row.upload);
			expect(canReact(c)).toBe(row.react);
		});
	}
});

describe("pod-policy: hidden pod (moderation)", () => {
	it("hides from members but keeps owner + admin access", () => {
		const hidden = { hiddenAt: new Date("2026-01-01T00:00:00Z") };
		// Group members lose read access; owner keeps it. Admin can view a
		// hidden public pod (canView still gates on membership for group).
		expect(canView(ctx({ visibility: "group", role: "member", ...hidden }))).toBe(false);
		expect(canView(ctx({ visibility: "group", role: "owner", ...hidden }))).toBe(true);
		expect(
			canView(ctx({ visibility: "public", role: null, isAdmin: true, ...hidden })),
		).toBe(true);
		// Non-admin guest on a hidden public pod is blocked by the moderation gate.
		expect(
			canView(ctx({ visibility: "public", role: null, viewerId: null, ...hidden })),
		).toBe(false);
	});

	it("blocks uploads and reactions on hidden pods for everyone", () => {
		const hidden = { hiddenAt: new Date() };
		// Owner is not exempt: hidden pods are frozen until moderation clears.
		expect(canUpload(ctx({ visibility: "group", role: "owner", ...hidden }))).toBe(false);
		expect(canReact(ctx({ visibility: "public", role: null, ...hidden }))).toBe(false);
	});
});

describe("pod-policy: canInvite / canModerate / canFollow", () => {
	it("only group-pod owners can invite", () => {
		expect(canInvite(ctx({ visibility: "group", role: "owner" }))).toBe(true);
		expect(canInvite(ctx({ visibility: "group", role: "member" }))).toBe(false);
		// Private pods have no invite flow (owner-only pods).
		expect(canInvite(ctx({ visibility: "private", role: "owner" }))).toBe(false);
		// Public pods aren't gated by invites either.
		expect(canInvite(ctx({ visibility: "public", role: "owner" }))).toBe(false);
	});

	it("owners moderate their pod; platform admins moderate anywhere", () => {
		expect(canModerate(ctx({ visibility: "group", role: "owner" }))).toBe(true);
		expect(canModerate(ctx({ visibility: "group", role: "member" }))).toBe(false);
		expect(
			canModerate(ctx({ visibility: "group", role: null, isAdmin: true })),
		).toBe(true);
	});

	it("only authenticated users can follow, and only public pods", () => {
		expect(canFollow(ctx({ visibility: "public", role: null }))).toBe(true);
		expect(canFollow(ctx({ visibility: "public", role: null, viewerId: null }))).toBe(false);
		expect(canFollow(ctx({ visibility: "group", role: "member" }))).toBe(false);
		expect(canFollow(ctx({ visibility: "private", role: "owner" }))).toBe(false);
	});
});

describe("pod-policy: guardPod / loadPolicyContext", () => {
	beforeEach(() => {
		dbState.pod = null;
		dbState.membership = null;
	});

	it("loadPolicyContext returns null when the pod is missing", async () => {
		dbState.pod = null;
		const result = await loadPolicyContext("missing", { userId: "u-1" });
		expect(result).toBeNull();
	});

	it("loadPolicyContext returns membership=null for guests", async () => {
		dbState.pod = {
			id: "p-1",
			visibility: "public",
			createdById: "u-owner",
			hiddenAt: null,
			retainLocationExif: false,
		};
		const result = await loadPolicyContext("p-1", { userId: null });
		expect(result?.membership).toBeNull();
	});

	it("guardPod throws 404 with code 'not_found' when the pod is missing", async () => {
		dbState.pod = null;
		await expect(
			guardPod("missing", { userId: "u-1" }, () => true, "view"),
		).rejects.toMatchObject({ code: "not_found", status: 404 });
	});

	it("guardPod throws 401 for guests when the predicate rejects", async () => {
		dbState.pod = {
			id: "p-1",
			visibility: "private",
			createdById: "u-owner",
			hiddenAt: null,
			retainLocationExif: false,
		};
		await expect(
			guardPod("p-1", { userId: null }, () => false, "view"),
		).rejects.toMatchObject({ code: "unauthenticated", status: 401 });
	});

	it("guardPod throws 403 for signed-in users when the predicate rejects", async () => {
		dbState.pod = {
			id: "p-1",
			visibility: "private",
			createdById: "u-owner",
			hiddenAt: null,
			retainLocationExif: false,
		};
		await expect(
			guardPod("p-1", { userId: "u-other" }, () => false, "view"),
		).rejects.toMatchObject({ code: "forbidden", status: 403 });
	});
});
