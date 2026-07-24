import { beforeEach, describe, expect, it, vi } from "vitest";

// Chainable select-builder fake: records call args so tests can assert the
// query shape (limit, where params) and resolves with `mocks.rows`.
const mocks = vi.hoisted(() => ({
	rows: [] as any[],
	selectCalls: 0,
	whereArg: null as any,
	limitArg: null as number | null,
}));

vi.mock("@/server/auth", () => ({ auth: vi.fn(async () => null) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/services/pod-policy", () => ({}));
vi.mock("@/server/services/pod-reactions", () => ({}));
vi.mock("@/server/services/pod-storage", () => ({
	buildStorageKey: vi.fn(),
	isStorageConfigured: () => false,
	loadStorageConfig: vi.fn(),
	presign: vi.fn(),
	publicUrlForKey: vi.fn(),
}));

vi.mock("@/server/db", () => {
	const chain: any = {};
	chain.select = vi.fn(() => {
		mocks.selectCalls += 1;
		return chain;
	});
	chain.from = vi.fn(() => chain);
	chain.where = vi.fn((arg: any) => {
		mocks.whereArg = arg;
		return chain;
	});
	chain.orderBy = vi.fn(() => chain);
	chain.limit = vi.fn((n: number) => {
		mocks.limitArg = n;
		return Promise.resolve(mocks.rows);
	});
	return { db: chain };
});

import { PgDialect } from "drizzle-orm/pg-core";

import { listPublicPods, searchPublicPods } from "@/server/actions/pods";

/** Compile a Drizzle SQL fragment and return its bound parameter values. */
const sqlParams = (node: any): any[] =>
	new PgDialect().sqlToQuery(node).params as any[];

const makeRow = (i: number) => ({
	id: `pod-${i}`,
	name: `Pod ${i}`,
	description: null,
	coverPhotoUrl: null,
	mediaCount: 0,
	followerCount: 0,
	createdAt: new Date(Date.UTC(2026, 0, 30 - i)),
});

beforeEach(() => {
	mocks.rows = [];
	mocks.selectCalls = 0;
	mocks.whereArg = null;
	mocks.limitArg = null;
});

describe("listPublicPods", () => {
	it("returns pods with no nextCursor when results fit the page", async () => {
		mocks.rows = [makeRow(1), makeRow(2)];
		const result = await listPublicPods({ limit: 5 });
		expect(result.pods).toHaveLength(2);
		expect(result.nextCursor).toBeNull();
		// Over-fetches by one row to detect a further page.
		expect(mocks.limitArg).toBe(6);
	});

	it("pops the sentinel row and returns the last visible createdAt as cursor", async () => {
		mocks.rows = [makeRow(1), makeRow(2), makeRow(3)];
		const result = await listPublicPods({ limit: 2 });
		expect(result.pods.map((p) => p.id)).toEqual(["pod-1", "pod-2"]);
		expect(result.nextCursor).toBe(makeRow(2).createdAt.toISOString());
	});

	it("clamps limit into [1, 100]", async () => {
		await listPublicPods({ limit: 500 });
		expect(mocks.limitArg).toBe(101);
		await listPublicPods({ limit: 0 });
		expect(mocks.limitArg).toBe(2);
	});

	it("filters to public visibility and binds the cursor date", async () => {
		const cursor = new Date(Date.UTC(2026, 0, 15)).toISOString();
		await listPublicPods({ cursor });
		const params = sqlParams(mocks.whereArg);
		expect(params).toContain("public");
		expect(
			params.some((p) => p instanceof Date && p.toISOString() === cursor),
		).toBe(true);
	});

	it("treats an unparseable cursor as no cursor instead of binding Invalid Date", async () => {
		const result = await listPublicPods({ cursor: "not-a-date" });
		expect(result.pods).toEqual([]);
		const params = sqlParams(mocks.whereArg);
		expect(params.some((p) => p instanceof Date)).toBe(false);
	});
});

describe("searchPublicPods", () => {
	it("returns empty result without querying for blank input", async () => {
		const result = await searchPublicPods("   ");
		expect(result.pods).toEqual([]);
		expect(mocks.selectCalls).toBe(0);
	});

	it("escapes ILIKE wildcards in the query", async () => {
		await searchPublicPods("100%_done");
		const params = sqlParams(mocks.whereArg);
		expect(params).toContain("%100\\%\\_done%");
	});

	it("filters to public pods and clamps limit into [1, 50]", async () => {
		await searchPublicPods("sunset", 500);
		expect(sqlParams(mocks.whereArg)).toContain("public");
		expect(mocks.limitArg).toBe(50);
		await searchPublicPods("sunset", 0);
		expect(mocks.limitArg).toBe(1);
	});
});
