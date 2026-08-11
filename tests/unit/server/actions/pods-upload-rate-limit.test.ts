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

	it("resets after the 1-hour sliding window elapses", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
			for (let i = 0; i < 100; i++) {
				await expect(requestAs("rl-user-d")).resolves.toBeDefined();
			}
			await expect(requestAs("rl-user-d")).rejects.toThrow(
				/upload limit reached/i,
			);

			// Advance past the full window so every prior timestamp is now stale.
			vi.advanceTimersByTime(60 * 60 * 1000 + 1);

			await expect(requestAs("rl-user-d")).resolves.toBeDefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("expires only the entries that fall outside the sliding window", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

			// One entry at T=0, then fill to 100 near the end of the window.
			await expect(requestAs("rl-user-e")).resolves.toBeDefined();
			vi.advanceTimersByTime(59 * 60 * 1000);
			for (let i = 0; i < 99; i++) {
				await expect(requestAs("rl-user-e")).resolves.toBeDefined();
			}
			// 100 entries in window → next request rejected.
			await expect(requestAs("rl-user-e")).rejects.toThrow(
				/upload limit reached/i,
			);

			// Move just past the 1h mark so only the T=0 entry ages out; the 99
			// entries added at T=59min are still within the window.
			vi.advanceTimersByTime(60 * 1000 + 1);

			// One slot freed → next request succeeds, then we're capped again.
			await expect(requestAs("rl-user-e")).resolves.toBeDefined();
			await expect(requestAs("rl-user-e")).rejects.toThrow(
				/upload limit reached/i,
			);
		} finally {
			vi.useRealTimers();
		}
	});
});
