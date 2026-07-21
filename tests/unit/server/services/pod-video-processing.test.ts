import { describe, expect, it, vi } from "vitest";

import {
	hasVideoGpsMetadata,
	scrubMp4Metadata,
} from "@/server/services/pod-video-processing";

// --- MP4 box builder helpers (test-only) ---

const box = (type: string, payload: Buffer): Buffer => {
	if (type.length !== 4) throw new Error(`Type must be 4 chars, got ${type}`);
	const size = 8 + payload.byteLength;
	const header = Buffer.alloc(8);
	header.writeUInt32BE(size, 0);
	header.write(type, 4, 4, "latin1");
	return Buffer.concat([header, payload]);
};

// Apple `©xyz` box: type byte 0xA9 followed by 'xyz'.
const copyrightXyz = (iso6709: string): Buffer => {
	const header = Buffer.alloc(8);
	const payload = Buffer.from(iso6709, "ascii");
	header.writeUInt32BE(8 + payload.byteLength, 0);
	header[4] = 0xa9;
	header[5] = 0x78; // 'x'
	header[6] = 0x79; // 'y'
	header[7] = 0x7a; // 'z'
	return Buffer.concat([header, payload]);
};

const buildMp4WithGps = (iso6709 = "+37.7749-122.4194/"): Buffer => {
	const ftyp = box(
		"ftyp",
		Buffer.concat([
			Buffer.from("mp42", "ascii"),
			Buffer.from([0, 0, 0, 0]),
			Buffer.from("mp42isomavc1", "ascii"),
		]),
	);
	const mvhd = box("mvhd", Buffer.alloc(100));
	const udta = box("udta", copyrightXyz(iso6709));
	// Apple keys/ilst pair carrying a location key.
	const keys = box(
		"keys",
		Buffer.concat([
			Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]),
			box(
				"mdta",
				Buffer.from("com.apple.quicktime.location.ISO6709", "ascii"),
			),
		]),
	);
	const ilst = box("ilst", Buffer.alloc(0));
	const meta = box(
		"meta",
		Buffer.concat([Buffer.from([0, 0, 0, 0]), keys, ilst]),
	);
	const moov = box("moov", Buffer.concat([mvhd, udta, meta]));
	const mdat = box("mdat", Buffer.from("fake-media-data-bytes"));
	return Buffer.concat([ftyp, moov, mdat]);
};

const buildCleanMp4 = (): Buffer => {
	const ftyp = box(
		"ftyp",
		Buffer.concat([
			Buffer.from("mp42", "ascii"),
			Buffer.from([0, 0, 0, 0]),
			Buffer.from("mp42isom", "ascii"),
		]),
	);
	const mvhd = box("mvhd", Buffer.alloc(100));
	const moov = box("moov", mvhd);
	const mdat = box("mdat", Buffer.from("fake-media-data-bytes"));
	return Buffer.concat([ftyp, moov, mdat]);
};

describe("scrubMp4Metadata (LAC-2933)", () => {
	it("strips ©xyz ISO 6709 location from moov/udta and Apple location key from moov/meta", () => {
		const input = buildMp4WithGps();
		// Sanity check: input has GPS markers.
		expect(input.includes(Buffer.from([0xa9, 0x78, 0x79, 0x7a]))).toBe(true);
		expect(input.includes(Buffer.from("com.apple.quicktime.location", "ascii"))).toBe(true);

		const output = scrubMp4Metadata(input);

		// Same overall size — we only rewrite type + zero payload; sizes preserved
		// so downstream stbl/stco offsets remain valid.
		expect(output.byteLength).toBe(input.byteLength);
		// GPS marker bytes are physically gone.
		expect(output.includes(Buffer.from([0xa9, 0x78, 0x79, 0x7a]))).toBe(false);
		expect(
			output.includes(Buffer.from("com.apple.quicktime.location", "ascii")),
		).toBe(false);
		// hasVideoGpsMetadata agrees.
		expect(hasVideoGpsMetadata(output)).toBe(false);
	});

	it("does not modify a clean MP4", () => {
		const input = buildCleanMp4();
		const output = scrubMp4Metadata(input);
		expect(output.equals(input)).toBe(true);
		expect(hasVideoGpsMetadata(output)).toBe(false);
	});

	it("fails closed by throwing on a non-ISOBMFF buffer", () => {
		const junk = Buffer.from("not an mp4 at all — plain text");
		expect(() => scrubMp4Metadata(junk)).toThrow();
	});

	it("fails closed by throwing on a truncated box", () => {
		// Declares a moov box that runs 4KB long but only supplies a header.
		const header = Buffer.alloc(8);
		header.writeUInt32BE(4096, 0);
		header.write("moov", 4, 4, "latin1");
		const ftyp = box("ftyp", Buffer.from("mp42\0\0\0\0mp42", "ascii"));
		const truncated = Buffer.concat([ftyp, header]);
		expect(() => scrubMp4Metadata(truncated)).toThrow(/Malformed MP4/);
	});
});

describe("hasVideoGpsMetadata (LAC-2933)", () => {
	it("returns true on any file containing a live udta box", () => {
		expect(hasVideoGpsMetadata(buildMp4WithGps())).toBe(true);
	});

	it("returns false on a scrubbed file", () => {
		const clean = scrubMp4Metadata(buildMp4WithGps());
		expect(hasVideoGpsMetadata(clean)).toBe(false);
	});

	it("returns false on a clean MP4", () => {
		expect(hasVideoGpsMetadata(buildCleanMp4())).toBe(false);
	});

	it("fails closed (returns true) on a non-ISOBMFF buffer", () => {
		expect(hasVideoGpsMetadata(Buffer.from("garbage"))).toBe(true);
	});

	it("fails closed (returns true) on a malformed box tree", () => {
		const header = Buffer.alloc(8);
		header.writeUInt32BE(4096, 0);
		header.write("moov", 4, 4, "latin1");
		const ftyp = box("ftyp", Buffer.from("mp42\0\0\0\0mp42", "ascii"));
		const bad = Buffer.concat([ftyp, header]);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			expect(hasVideoGpsMetadata(bad)).toBe(true);
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});
});
