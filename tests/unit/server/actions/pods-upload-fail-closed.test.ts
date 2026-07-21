import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock refs so vi.mock() factories can share them with test bodies.
const mocks = vi.hoisted(() => ({
	stripExif: vi.fn(),
	hasGpsExif: vi.fn(async () => false),
	auth: vi.fn(async () => ({ user: { id: "u-1", role: "user" } })),
	guardPod: vi.fn(),
	blobPut: vi.fn(async () => ({ url: "https://blob.example/x" })),
	uploadFile: vi.fn(async () => ({ url: "https://files.example/x" })),
	dbTransaction: vi.fn(),
}));

vi.mock("@/server/services/pod-media-processing", () => ({
	stripExif: mocks.stripExif,
	hasGpsExif: mocks.hasGpsExif,
}));

vi.mock("@/server/auth", () => ({
	auth: mocks.auth,
}));

vi.mock("@/server/db", () => ({
	db: {
		transaction: mocks.dbTransaction,
		query: {},
	},
	isDatabaseInitialized: async () => true,
	safeDbExecute: async (_cb: unknown, def: unknown) => def,
}));

vi.mock("@/server/services/pod-policy", async (orig) => {
	const actual = await orig<typeof import("@/server/services/pod-policy")>();
	return {
		...actual,
		guardPod: mocks.guardPod,
	};
});

vi.mock("@/server/services/pod-storage", () => ({
	isStorageConfigured: () => false,
	loadStorageConfig: vi.fn(),
	buildStorageKey: vi.fn(),
	fetchObjectRange: vi.fn(),
	presign: vi.fn(),
	publicUrlForKey: vi.fn(),
}));

vi.mock("@/server/services/pod-storage-cleanup", () => ({
	collectMediaKeys: vi.fn(() => []),
	deleteObjectsWithRetry: vi.fn(async () => undefined),
}));

vi.mock("@vercel/blob", () => ({ put: mocks.blobPut }));

vi.mock("@/server/services/file", () => ({ uploadFile: mocks.uploadFile }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Import under test AFTER mocks are declared. vi.mock is hoisted, so this
// order is just for readability.
import { uploadPhoto } from "@/server/actions/pods";

describe("uploadPhoto — fail-closed EXIF strip (LAC-2929)", () => {
	beforeEach(() => {
		mocks.stripExif.mockReset();
		mocks.blobPut.mockClear();
		mocks.uploadFile.mockClear();
		mocks.dbTransaction.mockClear();
		mocks.guardPod.mockReset();
		mocks.guardPod.mockImplementation(async (podId: string, viewer: any) => ({
			pod: {
				id: podId,
				visibility: "group",
				createdById: "u-1",
				hiddenAt: null,
				retainLocationExif: false,
			},
			viewer,
			membership: { role: "owner" },
		}));
	});

	it("rejects the upload when sharp throws while stripping EXIF", async () => {
		mocks.stripExif.mockRejectedValueOnce(new Error("sharp: corrupt image"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const file = new File([png], "photo.png", { type: "image/png" });
		const form = new FormData();
		form.set("file", file);

		try {
			await expect(uploadPhoto("pod-1", form)).rejects.toThrow(/EXIF/i);

			// Sharp was actually invoked — proves we didn't bail earlier.
			expect(mocks.stripExif).toHaveBeenCalledTimes(1);
			// Fail-closed: nothing was written to either storage backend, and
			// no DB transaction was opened to record the media row.
			expect(mocks.blobPut).not.toHaveBeenCalled();
			expect(mocks.uploadFile).not.toHaveBeenCalled();
			expect(mocks.dbTransaction).not.toHaveBeenCalled();
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});
});
