import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock refs so vi.mock() factories can share them with test bodies.
const mocks = vi.hoisted(() => ({
	auth: vi.fn(async () => ({ user: { id: "u-1", role: "user" } })),
	guardUpload: vi.fn(),
	dbInsert: vi.fn(),
	isStorageConfigured: vi.fn(() => false),
	deleteObjectsWithRetry: vi.fn(async () => ({ deleted: [], queued: [] })),
}));

vi.mock("@/server/auth", () => ({
	auth: mocks.auth,
}));

vi.mock("@/server/db", () => ({
	db: {
		insert: mocks.dbInsert,
		query: {},
	},
}));

vi.mock("@/server/services/pod-policy", () => ({
	guardUpload: mocks.guardUpload,
}));

vi.mock("@/server/services/pod-reactions", () => ({}));

vi.mock("@/server/services/pod-storage", () => ({
	isStorageConfigured: mocks.isStorageConfigured,
	loadStorageConfig: vi.fn(() => ({})),
	buildStorageKey: vi.fn(() => "pods/p-1/media/m.jpg"),
	presign: vi.fn(() => "https://r2.example/signed"),
	publicUrlForKey: vi.fn(),
}));

vi.mock("@/server/services/pod-storage-cleanup", () => ({
	collectMediaKeys: vi.fn(() => []),
	deleteObjectsWithRetry: mocks.deleteObjectsWithRetry,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requestPresignedUpload } from "@/server/actions/pods";

// The sliding-window limiter is module-level state shared across tests, so
// every test uses its own user id to get a fresh window.
const requestAs = (userId: string) => {
	mocks.guardUpload.mockImplementation(async (_podId: string, viewer: any) => ({
		pod: { id: "p-1", retainLocationExif: null },
		viewer: { ...viewer, userId },
		membership: { role: "owner" },
	}));
	return requestPresignedUpload({
		podId: "p-1",
		filename: "a.jpg",
		contentType: "image/jpeg",
		size: 1024,
	});
};

describe("upload rate limit (LAC-2917 H3)", () => {
	beforeEach(() => {
		mocks.dbInsert.mockReset();
		mocks.dbInsert.mockReturnValue({ values: vi.fn(async () => undefined) });
		mocks.isStorageConfigured.mockReturnValue(false);
	});

	it("allows 100 uploads per hour, rejects the 101st", async () => {
		for (let i = 0; i < 100; i++) {
			await expect(requestAs("rl-user-a")).resolves.toBeDefined();
		}
		await expect(requestAs("rl-user-a")).rejects.toThrow(
			/upload limit reached/i,
		);
	});

	it("does not throttle a different user hitting the same window", async () => {
		for (let i = 0; i < 100; i++) {
			await requestAs("rl-user-b");
		}
		await expect(requestAs("rl-user-c")).resolves.toBeDefined();
	});
});
