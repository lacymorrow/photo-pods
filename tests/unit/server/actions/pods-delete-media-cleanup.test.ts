import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock refs so vi.mock() factories can share them with test bodies.
const mocks = vi.hoisted(() => ({
	auth: vi.fn(async () => ({ user: { id: "u-1", role: "user" } })),
	findFirstMedia: vi.fn(),
	transaction: vi.fn(),
	loadPolicyContext: vi.fn(),
	canModerate: vi.fn(() => false),
	collectMediaKeys: vi.fn(() => [] as string[]),
	deleteObjectsWithRetry: vi.fn(async () => ({ deleted: [], queued: [] })),
}));

vi.mock("@/server/auth", () => ({
	auth: mocks.auth,
}));

vi.mock("@/server/db", () => ({
	db: {
		query: { podMedia: { findFirst: mocks.findFirstMedia } },
		transaction: mocks.transaction,
	},
}));

vi.mock("@/server/services/pod-policy", () => ({
	loadPolicyContext: mocks.loadPolicyContext,
	canModerate: mocks.canModerate,
}));

vi.mock("@/server/services/pod-reactions", () => ({}));

vi.mock("@/server/services/pod-storage", () => ({
	isStorageConfigured: vi.fn(() => true),
	loadStorageConfig: vi.fn(() => ({})),
	buildStorageKey: vi.fn(),
	presign: vi.fn(),
	publicUrlForKey: vi.fn(),
}));

vi.mock("@/server/services/pod-storage-cleanup", () => ({
	collectMediaKeys: mocks.collectMediaKeys,
	deleteObjectsWithRetry: mocks.deleteObjectsWithRetry,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { deletePhoto } from "@/server/actions/pods";

const MEDIA_ROW = {
	id: "m-1",
	podId: "p-1",
	uploadedById: "u-1",
	storageKey: "pods/p-1/media/m-1.jpg",
	variants: { w400: "pods/p-1/media/m-1_w400.jpg" },
};

describe("deletePhoto — R2 object cleanup (LAC-2917 H2)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.auth.mockResolvedValue({ user: { id: "u-1", role: "user" } });
		mocks.findFirstMedia.mockResolvedValue(MEDIA_ROW);
		mocks.loadPolicyContext.mockResolvedValue({
			pod: { id: "p-1" },
			viewer: { userId: "u-1" },
			membership: { role: "member" },
		});
		const tx = {
			delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
			update: vi.fn(() => ({
				set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
			})),
		};
		mocks.transaction.mockImplementation(async (fn: any) => fn(tx));
	});

	it("deletes the R2 objects for the row after the DB delete", async () => {
		mocks.collectMediaKeys.mockReturnValue([
			MEDIA_ROW.storageKey,
			"pods/p-1/media/m-1_w400.jpg",
		]);

		await deletePhoto("m-1");

		expect(mocks.collectMediaKeys).toHaveBeenCalledWith(
			expect.objectContaining({ storageKey: MEDIA_ROW.storageKey }),
		);
		expect(mocks.deleteObjectsWithRetry).toHaveBeenCalledWith([
			MEDIA_ROW.storageKey,
			"pods/p-1/media/m-1_w400.jpg",
		]);
	});

	it("skips the storage call when the row has no object keys", async () => {
		mocks.collectMediaKeys.mockReturnValue([]);

		await deletePhoto("m-1");

		expect(mocks.deleteObjectsWithRetry).not.toHaveBeenCalled();
	});
});
