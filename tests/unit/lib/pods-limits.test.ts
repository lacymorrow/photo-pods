import { describe, expect, it } from "vitest";
import {
	acceptUploadBatch,
	MAX_MEDIA_PER_POD,
	MAX_UPLOAD_BATCH,
} from "@/lib/pods/limits";

describe("pods limits (LAC-2913)", () => {
	it("matches the spec caps from LAC-2854", () => {
		expect(MAX_UPLOAD_BATCH).toBe(50);
		expect(MAX_MEDIA_PER_POD).toBe(10_000);
	});

	describe("acceptUploadBatch", () => {
		const files = (n: number) => Array.from({ length: n }, (_, i) => `f${i}`);

		it("accepts everything when under the cap", () => {
			const result = acceptUploadBatch(0, files(10));
			expect(result.accepted).toHaveLength(10);
			expect(result.rejectedCount).toBe(0);
		});

		it("accepts exactly up to the cap", () => {
			const result = acceptUploadBatch(0, files(MAX_UPLOAD_BATCH));
			expect(result.accepted).toHaveLength(MAX_UPLOAD_BATCH);
			expect(result.rejectedCount).toBe(0);
		});

		it("truncates a single oversized selection", () => {
			const result = acceptUploadBatch(0, files(MAX_UPLOAD_BATCH + 25));
			expect(result.accepted).toHaveLength(MAX_UPLOAD_BATCH);
			expect(result.rejectedCount).toBe(25);
		});

		it("accounts for already-selected files across multiple drops", () => {
			const result = acceptUploadBatch(45, files(10));
			expect(result.accepted).toHaveLength(5);
			expect(result.rejectedCount).toBe(5);
		});

		it("rejects everything when the batch is already full", () => {
			const result = acceptUploadBatch(MAX_UPLOAD_BATCH, files(3));
			expect(result.accepted).toHaveLength(0);
			expect(result.rejectedCount).toBe(3);
		});
	});
});
