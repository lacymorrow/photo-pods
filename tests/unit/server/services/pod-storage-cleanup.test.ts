import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	del: vi.fn(async () => undefined),
	loadStorageConfig: vi.fn(() => ({
		provider: "r2" as const,
		bucket: "pods",
	})),
	deleteObject: vi.fn(async () => ({ ok: true, status: 204 })),
	publicUrlForKey: vi.fn(() => null as string | null),
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

const R2_CONFIG = { provider: "r2" as const, bucket: "pods" };

describe("collectMediaKeys", () => {
	it("returns R2 targets for storageKey + variants (LAC-2917 H2)", () => {
		const targets = collectMediaKeys({
			storageKey: "pods/p-1/media/m-1.jpg",
			variants: {
				w400: "pods/p-1/media/m-1_w400.jpg",
				w800: "pods/p-1/media/m-1_w800.jpg",
			},
			url: null,
		} as any);
		expect(targets).toEqual([
			{ kind: "storage-key", value: "pods/p-1/media/m-1.jpg" },
			{ kind: "storage-key", value: "pods/p-1/media/m-1_w400.jpg" },
			{ kind: "storage-key", value: "pods/p-1/media/m-1_w800.jpg" },
		]);
	});

	it("skips a missing storageKey and non-string variant values", () => {
		const targets = collectMediaKeys({
			storageKey: null,
			variants: { w400: "", w800: 42, w1600: "pods/x.jpg" },
			url: null,
		} as any);
		expect(targets).toEqual([
			{ kind: "storage-key", value: "pods/x.jpg" },
		]);
	});

	it("returns empty for a legacy row with no storage key, variants, or url", () => {
		expect(
			collectMediaKeys({ storageKey: null, variants: null, url: null } as any),
		).toEqual([]);
	});

	it("includes a legacy Vercel Blob url so GDPR erasure catches it (LAC-2930)", () => {
		const targets = collectMediaKeys({
			storageKey: null,
			variants: null,
			url: "https://abc123.public.blob.vercel-storage.com/pods/x/1.jpg",
		} as any);
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
		} as any);
		expect(targets).toHaveLength(2);
		expect(targets.map((t) => t.kind).sort()).toEqual([
			"blob-url",
			"storage-key",
		]);
	});

	it("ignores unrelated URLs stored in url", () => {
		const targets = collectMediaKeys({
			storageKey: null,
			variants: null,
			url: "https://cdn.example.com/file.jpg",
		} as any);
		expect(targets).toEqual([]);
	});
});

describe("deleteObjectsWithRetry — R2 branch", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.publicUrlForKey.mockReturnValue(null);
	});

	it("queues everything when object storage is not configured", async () => {
		mocks.loadStorageConfig.mockReturnValue({
			provider: "vercel-blob",
		} as any);

		const result = await deleteObjectsWithRetry([
			{ kind: "storage-key", value: "a.jpg" },
			{ kind: "storage-key", value: "b.jpg" },
		]);

		expect(result).toEqual({ deleted: [], queued: ["a.jpg", "b.jpg"] });
		expect(mocks.deleteObject).not.toHaveBeenCalled();
		expect(mocks.insert).toHaveBeenCalledWith([
			{ storageKey: "a.jpg", reason: "delete" },
			{ storageKey: "b.jpg", reason: "delete" },
		]);
	});

	it("deletes each key and queues nothing on success", async () => {
		mocks.loadStorageConfig.mockReturnValue(R2_CONFIG);
		mocks.deleteObject.mockResolvedValue({ ok: true, status: 204 });

		const result = await deleteObjectsWithRetry([
			{ kind: "storage-key", value: "a.jpg" },
			{ kind: "storage-key", value: "b.jpg" },
		]);

		expect(result).toEqual({ deleted: ["a.jpg", "b.jpg"], queued: [] });
		expect(mocks.deleteObject).toHaveBeenCalledTimes(2);
		expect(mocks.insert).not.toHaveBeenCalled();
	});

	it("enqueues failed keys for worker retry and never throws", async () => {
		mocks.loadStorageConfig.mockReturnValue(R2_CONFIG);
		mocks.deleteObject
			.mockResolvedValueOnce({ ok: true, status: 204 })
			.mockResolvedValueOnce({ ok: false, status: 500, error: "500 boom" });

		const result = await deleteObjectsWithRetry([
			{ kind: "storage-key", value: "ok.jpg" },
			{ kind: "storage-key", value: "fail.jpg" },
		]);

		expect(result).toEqual({ deleted: ["ok.jpg"], queued: ["fail.jpg"] });
		expect(mocks.insert).toHaveBeenCalledWith([
			{ storageKey: "fail.jpg", reason: "delete" },
		]);
	});
});

describe("deleteObjectsWithRetry — Vercel Blob branch (LAC-2930)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.loadStorageConfig.mockReturnValue(R2_CONFIG);
	});

	it("routes blob-url targets through @vercel/blob del", async () => {
		const url = "https://abc.public.blob.vercel-storage.com/x.jpg";
		const result = await deleteObjectsWithRetry([
			{ kind: "blob-url", value: url },
		]);
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
