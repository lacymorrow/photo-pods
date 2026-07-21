import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	del: vi.fn(async () => undefined),
	loadStorageConfig: vi.fn(() => ({ provider: "r2" as const, bucket: "b" })),
	deleteObject: vi.fn(async () => ({ ok: true, status: 204 })),
	publicUrlForKey: vi.fn(() => null),
	insert: vi.fn(),
}));

vi.mock("@vercel/blob", () => ({ del: mocks.del }));

vi.mock("@/server/services/pod-storage", () => ({
	loadStorageConfig: mocks.loadStorageConfig,
	deleteObject: mocks.deleteObject,
	publicUrlForKey: mocks.publicUrlForKey,
}));

vi.mock("@/server/db", () => ({
	db: {
		insert: () => ({
			values: async (rows: unknown) => mocks.insert(rows),
		}),
	},
}));

import {
	collectMediaKeys,
	deleteObjectsWithRetry,
} from "@/server/services/pod-storage-cleanup";

describe("collectMediaKeys (LAC-2930)", () => {
	it("returns R2 keys for storageKey + variants", () => {
		const targets = collectMediaKeys({
			storageKey: "orig.jpg",
			variants: { w400: "v400.jpg", w800: "v800.jpg" },
			url: null,
		});
		expect(targets).toEqual([
			{ kind: "storage-key", value: "orig.jpg" },
			{ kind: "storage-key", value: "v400.jpg" },
			{ kind: "storage-key", value: "v800.jpg" },
		]);
	});

	it("includes legacy Vercel Blob url so GDPR erasure catches it", () => {
		const targets = collectMediaKeys({
			storageKey: null,
			variants: null,
			url: "https://abc123.public.blob.vercel-storage.com/pods/x/1.jpg",
		});
		expect(targets).toEqual([
			{
				kind: "blob-url",
				value: "https://abc123.public.blob.vercel-storage.com/pods/x/1.jpg",
			},
		]);
	});

	it("returns both r2 and blob-url targets when a row has both", () => {
		const targets = collectMediaKeys({
			storageKey: "orig.jpg",
			variants: null,
			url: "https://abc.public.blob.vercel-storage.com/y.jpg",
		});
		expect(targets).toHaveLength(2);
		expect(targets.map((t) => t.kind).sort()).toEqual(["blob-url", "storage-key"]);
	});

	it("ignores unrelated URLs stored in url", () => {
		const targets = collectMediaKeys({
			storageKey: null,
			variants: null,
			url: "https://cdn.example.com/file.jpg",
		});
		expect(targets).toEqual([]);
	});
});

describe("deleteObjectsWithRetry — Vercel Blob branch (LAC-2930)", () => {
	beforeEach(() => {
		mocks.del.mockClear();
		mocks.insert.mockClear();
		mocks.deleteObject.mockClear();
	});

	it("routes blob-url targets through @vercel/blob del", async () => {
		const url = "https://abc.public.blob.vercel-storage.com/x.jpg";
		const result = await deleteObjectsWithRetry([{ kind: "blob-url", value: url }]);
		expect(mocks.del).toHaveBeenCalledWith([url]);
		expect(result).toEqual({ deleted: [url], queued: [] });
		expect(mocks.insert).not.toHaveBeenCalled();
	});

	it("queues blob URLs with reason=blob-url on failure", async () => {
		mocks.del.mockRejectedValueOnce(new Error("blob outage"));
		const url = "https://abc.public.blob.vercel-storage.com/x.jpg";
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const result = await deleteObjectsWithRetry([
				{ kind: "blob-url", value: url },
			]);
			expect(result).toEqual({ deleted: [], queued: [url] });
			expect(mocks.insert).toHaveBeenCalledWith([
				{ storageKey: url, reason: "blob-url" },
			]);
		} finally {
			warn.mockRestore();
		}
	});

	it("splits mixed targets between R2 and blob backends", async () => {
		const url = "https://abc.public.blob.vercel-storage.com/x.jpg";
		await deleteObjectsWithRetry([
			{ kind: "storage-key", value: "r2-key" },
			{ kind: "blob-url", value: url },
		]);
		expect(mocks.deleteObject).toHaveBeenCalledWith(
			expect.anything(),
			"r2-key",
		);
		expect(mocks.del).toHaveBeenCalledWith([url]);
	});
});
