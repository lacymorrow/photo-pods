import { describe, expect, it, vi } from "vitest";

import { hasGpsExif } from "@/server/services/pod-media-processing";

describe("hasGpsExif — fail-closed (LAC-2928)", () => {
	it("returns true when sharp cannot parse the input", async () => {
		// A short byte sequence with no recognizable image header — sharp's
		// metadata() rejects it. Fail-closed semantics require this to be
		// treated as "GPS present" so the upload path rejects the file.
		const junk = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			await expect(hasGpsExif(junk)).resolves.toBe(true);
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("returns false for a valid image with no GPS EXIF", async () => {
		// 1x1 transparent PNG — no EXIF, definitely no GPS.
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
			"base64",
		);
		await expect(hasGpsExif(png)).resolves.toBe(false);
	});
});
