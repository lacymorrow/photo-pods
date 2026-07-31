import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock refs so vi.mock() factories can share them with test bodies.
const mocks = vi.hoisted(() => ({
	loadStorageConfig: vi.fn(),
	deleteObject: vi.fn(),
	publicUrlForKey: vi.fn(() => null as string | null),
	dbInsert: vi.fn(),
}));

vi.mock("@/server/services/pod-storage", () => ({
	loadStorageConfig: mocks.loadStorageConfig,
	deleteObject: mocks.deleteObject,
	publicUrlForKey: mocks.publicUrlForKey,
}));

vi.mock("@/server/db", () => ({
	db: {
		insert: mocks.dbInsert,
	},
}));

import {
	collectMediaKeys,
	deleteObjectsWithRetry,
} from "@/server/services/pod-storage-cleanup";

const R2_CONFIG = { provider: "r2", bucket: "pods" };

describe("collectMediaKeys (LAC-2917 H2)", () => {
	it("returns the original key plus every variant key", () => {
		const keys = collectMediaKeys({
			storageKey: "pods/p-1/media/m-1.jpg",
			variants: {
				w400: "pods/p-1/media/m-1_w400.jpg",
				w800: "pods/p-1/media/m-1_w800.jpg",
			},
		} as any);
		expect(keys).toEqual([
			"pods/p-1/media/m-1.jpg",
			"pods/p-1/media/m-1_w400.jpg",
			"pods/p-1/media/m-1_w800.jpg",
		]);
	});

	it("skips a missing storageKey and non-string variant values", () => {
		const keys = collectMediaKeys({
			storageKey: null,
			variants: { w400: "", w800: 42, w1600: "pods/x.jpg" },
		} as any);
		expect(keys).toEqual(["pods/x.jpg"]);
	});

	it("returns empty for a legacy row with no storage key or variants", () => {
		expect(collectMediaKeys({ storageKey: null, variants: null } as any)).toEqual([]);
	});
});

describe("deleteObjectsWithRetry (LAC-2917 H2)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.publicUrlForKey.mockReturnValue(null);
		mocks.dbInsert.mockReturnValue({ values: vi.fn(async () => undefined) });
	});

	it("queues everything when object storage is not configured", async () => {
		mocks.loadStorageConfig.mockReturnValue({ provider: "vercel-blob" });

		const result = await deleteObjectsWithRetry(["a.jpg", "b.jpg"]);

		expect(result).toEqual({ deleted: [], queued: ["a.jpg", "b.jpg"] });
		expect(mocks.deleteObject).not.toHaveBeenCalled();
		expect(mocks.dbInsert).toHaveBeenCalledTimes(1);
	});

	it("deletes each key and queues nothing on success", async () => {
		mocks.loadStorageConfig.mockReturnValue(R2_CONFIG);
		mocks.deleteObject.mockResolvedValue({ ok: true, status: 204 });

		const result = await deleteObjectsWithRetry(["a.jpg", "b.jpg"]);

		expect(result).toEqual({ deleted: ["a.jpg", "b.jpg"], queued: [] });
		expect(mocks.deleteObject).toHaveBeenCalledTimes(2);
		expect(mocks.dbInsert).not.toHaveBeenCalled();
	});

	it("enqueues failed keys for worker retry and never throws", async () => {
		mocks.loadStorageConfig.mockReturnValue(R2_CONFIG);
		mocks.deleteObject
			.mockResolvedValueOnce({ ok: true, status: 204 })
			.mockResolvedValueOnce({ ok: false, status: 500, error: "500 boom" });
		const values = vi.fn(async () => undefined);
		mocks.dbInsert.mockReturnValue({ values });

		const result = await deleteObjectsWithRetry(["ok.jpg", "fail.jpg"]);

		expect(result).toEqual({ deleted: ["ok.jpg"], queued: ["fail.jpg"] });
		expect(values).toHaveBeenCalledWith([{ storageKey: "fail.jpg" }]);
	});
});
