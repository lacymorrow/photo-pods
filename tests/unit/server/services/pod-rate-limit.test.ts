import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock state so we can vary env + a fake Redis client per suite
// without importing the module before the mocks are wired.
const state = vi.hoisted(() => ({
	env: {
		UPSTASH_REDIS_REST_URL: undefined as string | undefined,
		UPSTASH_REDIS_REST_TOKEN: undefined as string | undefined,
	},
	// Shared "Redis" storage: single process-wide map keyed by
	// `prefix:userId`. Both simulated lambda instances construct their own
	// Ratelimit but read/write against this same map, so the sliding window
	// is shared exactly like Upstash would enforce.
	sharedCounters: new Map<string, number>(),
	redisInstances: 0,
	makeRedis: () => {
		state.redisInstances += 1;
		return {} as unknown; // Ratelimit only needs an opaque handle in tests
	},
}));

vi.mock("@/env", () => ({
	env: state.env,
}));

vi.mock("@/lib/logger", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@upstash/redis", () => ({
	Redis: class {
		constructor() {
			return state.makeRedis();
		}
	},
}));

// A minimal fake Ratelimit that shares state across every constructed
// instance via `state.sharedCounters` — matching how real Upstash sliding
// windows are enforced from any lambda that hits the same Redis.
vi.mock("@upstash/ratelimit", () => {
	class FakeRatelimit {
		private readonly prefix: string;
		private readonly requests: number;
		constructor(opts: { prefix: string; limiter: { requests: number } }) {
			this.prefix = opts.prefix;
			this.requests = opts.limiter.requests;
		}
		static slidingWindow(requests: number, _window: string) {
			return { kind: "sliding", requests };
		}
		async limit(identifier: string): Promise<{ success: boolean }> {
			const key = `${this.prefix}:${identifier}`;
			const count = (state.sharedCounters.get(key) ?? 0) + 1;
			state.sharedCounters.set(key, count);
			return { success: count <= this.requests };
		}
	}
	return { Ratelimit: FakeRatelimit };
});

const importFresh = async () => {
	// Simulate a cold lambda: nuke the module registry AND the per-instance
	// caches that pod-rate-limit keeps on globalThis. Without this, the
	// second import would reuse Instance A's Ratelimit reference and we
	// would not be proving anything about cross-instance behaviour.
	vi.resetModules();
	const anyGlobal = globalThis as unknown as Record<string, unknown>;
	delete anyGlobal.__podRateLimitRedis;
	delete anyGlobal.__podRateLimiters;
	delete anyGlobal.__podRateLimitMemory;
	return await import("@/server/services/pod-rate-limit");
};

const withRedisEnv = () => {
	state.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
	state.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
};

const withoutRedisEnv = () => {
	state.env.UPSTASH_REDIS_REST_URL = undefined;
	state.env.UPSTASH_REDIS_REST_TOKEN = undefined;
};

beforeEach(() => {
	state.sharedCounters.clear();
	state.redisInstances = 0;
	// Every test starts from a clean module-level singleton state.
	const anyGlobal = globalThis as unknown as Record<string, unknown>;
	delete anyGlobal.__podRateLimitRedis;
	delete anyGlobal.__podRateLimiters;
	delete anyGlobal.__podRateLimitMemory;
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("pod-rate-limit (LAC-2931)", () => {
	it("uses Upstash when configured and shares the counter across simulated instances", async () => {
		withRedisEnv();

		// "Instance A" — imports fresh, hits the limiter 60 times.
		const modA = await importFresh();
		for (let i = 0; i < 60; i += 1) {
			await modA.checkUploadRateLimit("user-x");
		}

		// "Instance B" — a second cold lambda that imports its own copy of
		// the module. Without a shared Redis, this instance's ceiling would
		// be independent. With Redis, the 41st hit here is the 101st overall
		// and MUST throw.
		const modB = await importFresh();
		for (let i = 0; i < 40; i += 1) {
			await modB.checkUploadRateLimit("user-x");
		}
		await expect(modB.checkUploadRateLimit("user-x")).rejects.toThrow(
			/Upload limit reached/i,
		);
	});

	it("falls back to the in-memory sliding window when Redis env is absent", async () => {
		withoutRedisEnv();
		const mod = await importFresh();

		// No Redis constructed at all.
		expect(state.redisInstances).toBe(0);

		for (let i = 0; i < 100; i += 1) {
			await mod.checkUploadRateLimit("user-y");
		}
		await expect(mod.checkUploadRateLimit("user-y")).rejects.toThrow(
			/Upload limit reached/i,
		);
	});

	it("in-memory fallback isolates counters between users", async () => {
		withoutRedisEnv();
		const mod = await importFresh();
		for (let i = 0; i < 100; i += 1) {
			await mod.checkUploadRateLimit("user-a");
		}
		// user-b starts at zero even though user-a has exhausted the window.
		await expect(mod.checkUploadRateLimit("user-b")).resolves.toBeUndefined();
	});

	it("report limiter enforces its own lower ceiling", async () => {
		withoutRedisEnv();
		const mod = await importFresh();
		for (let i = 0; i < 20; i += 1) {
			await mod.checkReportRateLimit("user-z");
		}
		await expect(mod.checkReportRateLimit("user-z")).rejects.toThrow(
			/Too many reports/i,
		);
	});
});
