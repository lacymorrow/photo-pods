import { describe, expect, it } from "vitest";
import { isHeicFile } from "@/lib/pods/heic";

const file = (name: string, type: string) => new File(["x"], name, { type });

describe("isHeicFile (LAC-2915)", () => {
	it("detects HEIC/HEIF by MIME type", () => {
		expect(isHeicFile(file("a.heic", "image/heic"))).toBe(true);
		expect(isHeicFile(file("a.heif", "image/heif"))).toBe(true);
		expect(isHeicFile(file("a.heic", "image/heic-sequence"))).toBe(true);
		expect(isHeicFile(file("a.heif", "image/heif-sequence"))).toBe(true);
	});

	it("detects HEIC/HEIF by extension when the browser reports no MIME type", () => {
		expect(isHeicFile(file("IMG_0001.heic", ""))).toBe(true);
		expect(isHeicFile(file("IMG_0001.HEIC", ""))).toBe(true);
		expect(isHeicFile(file("IMG_0001.heif", ""))).toBe(true);
	});

	it("returns false for browser-decodable image types", () => {
		expect(isHeicFile(file("a.jpg", "image/jpeg"))).toBe(false);
		expect(isHeicFile(file("a.png", "image/png"))).toBe(false);
		expect(isHeicFile(file("a.webp", "image/webp"))).toBe(false);
	});

	it("does not treat non-heic names without a type as HEIC", () => {
		expect(isHeicFile(file("archive.zip", ""))).toBe(false);
		expect(isHeicFile(file("heic-notes.txt", "text/plain"))).toBe(false);
	});
});
