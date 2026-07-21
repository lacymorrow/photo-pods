import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

import { env } from "@/env";
import { logger } from "@/lib/logger";

// Redis-backed sliding-window limiter for photopods user actions (upload,
// report). Falls back to a per-process in-memory sliding window when Upstash
// is not configured (local dev, tests). Every serverless instance shares the
// Redis counter, so a user hitting different cold lambdas can no longer
// multiply their effective ceiling by N. Follow-up to [LAC-2859] §4.

export interface PodRateLimitConfig {
	name: string;
	requests: number;
	windowSeconds: number;
	message: string;
}

const UPLOAD_CONFIG: PodRateLimitConfig = {
	name: "pod-upload",
	requests: 100,
	windowSeconds: 60 * 60,
	message: "Upload limit reached. Please try again later.",
};

const REPORT_CONFIG: PodRateLimitConfig = {
	name: "pod-report",
	requests: 20,
	windowSeconds: 60 * 60,
	message: "Too many reports. Please try again later.",
};

const buildRedis = (): Redis | null => {
	if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return null;
	try {
		return new Redis({
			url: env.UPSTASH_REDIS_REST_URL,
			token: env.UPSTASH_REDIS_REST_TOKEN,
		});
	} catch (error) {
		logger.error("pod-rate-limit: failed to init Upstash Redis", { error });
		return null;
	}
};

// Module-level singletons — one Ratelimit per config, one shared Redis client.
// Guarded to survive Next.js/Turbopack HMR duplicating module instances.
const globalStore = globalThis as unknown as {
	__podRateLimitRedis?: Redis | null;
	__podRateLimiters?: Map<string, Ratelimit>;
	__podRateLimitMemory?: Map<string, number[]>;
};

const getRedis = (): Redis | null => {
	if (globalStore.__podRateLimitRedis === undefined) {
		globalStore.__podRateLimitRedis = buildRedis();
	}
	return globalStore.__podRateLimitRedis;
};

const getLimiter = (config: PodRateLimitConfig): Ratelimit | null => {
	const redis = getRedis();
	if (!redis) return null;
	if (!globalStore.__podRateLimiters) {
		globalStore.__podRateLimiters = new Map();
	}
	const existing = globalStore.__podRateLimiters.get(config.name);
	if (existing) return existing;
	const limiter = new Ratelimit({
		redis,
		limiter: Ratelimit.slidingWindow(config.requests, `${config.windowSeconds} s`),
		prefix: `podratelimit:${config.name}`,
		analytics: false,
	});
	globalStore.__podRateLimiters.set(config.name, limiter);
	return limiter;
};

const getMemoryStore = (): Map<string, number[]> => {
	if (!globalStore.__podRateLimitMemory) {
		globalStore.__podRateLimitMemory = new Map();
	}
	return globalStore.__podRateLimitMemory;
};

const checkInMemory = (userId: string, config: PodRateLimitConfig): void => {
	const store = getMemoryStore();
	const key = `${config.name}:${userId}`;
	const now = Date.now();
	const cutoff = now - config.windowSeconds * 1000;
	const hits = (store.get(key) ?? []).filter((t) => t > cutoff);
	if (hits.length >= config.requests) {
		throw new Error(config.message);
	}
	hits.push(now);
	store.set(key, hits);
};

const check = async (userId: string, config: PodRateLimitConfig): Promise<void> => {
	const limiter = getLimiter(config);
	if (!limiter) {
		checkInMemory(userId, config);
		return;
	}
	try {
		const { success } = await limiter.limit(userId);
		if (!success) {
			throw new Error(config.message);
		}
	} catch (error) {
		if (error instanceof Error && error.message === config.message) {
			throw error;
		}
		// Redis outage: fail-open to in-memory rather than blocking every
		// upload. This matches how the platform-wide rate-limit-service
		// degrades under Redis loss.
		logger.warn("pod-rate-limit: Redis check failed, falling back to memory", {
			name: config.name,
			error,
		});
		checkInMemory(userId, config);
	}
};

export const checkUploadRateLimit = async (userId: string): Promise<void> => {
	await check(userId, UPLOAD_CONFIG);
};

export const checkReportRateLimit = async (userId: string): Promise<void> => {
	await check(userId, REPORT_CONFIG);
};

// Test-only: reset module state so tests can assert clean per-instance behaviour.
export const __resetForTests = (): void => {
	globalStore.__podRateLimitRedis = undefined;
	globalStore.__podRateLimiters = undefined;
	globalStore.__podRateLimitMemory = undefined;
};

export const __configs = { upload: UPLOAD_CONFIG, report: REPORT_CONFIG };
