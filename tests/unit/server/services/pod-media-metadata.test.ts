import { describe, expect, it } from "vitest";
import { stripImageMetadata } from "@/server/services/pod-media-metadata";

// --- byte helpers ---

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u32be = (n: number) => [
	(n >>> 24) & 0xff,
	(n >>> 16) & 0xff,
	(n >>> 8) & 0xff,
	n & 0xff,
];
const u32le = (n: number) => [
	n & 0xff,
	(n >>> 8) & 0xff,
	(n >>> 16) & 0xff,
	(n >>> 24) & 0xff,
];

const hasBytes = (haystack: Uint8Array, needle: number[]): boolean => {
	outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
		for (let j = 0; j < needle.length; j++) {
			if (haystack[i + j] !== needle[j]) continue outer;
		}
		return true;
	}
	return false;
};

// Little-endian TIFF: IFD0 with a single GPS-IFD pointer entry (tag 0x8825).
// The tag bytes `25 88` in an LE entry are the regression marker the
// assertions below look for.
const GPS_TAG_LE = [0x25, 0x88, 0x04, 0x00];
const tiffWithGps = () => [
	...ascii("II"),
	0x2a,
	0x00,
	0x08,
	0x00,
	0x00,
	0x00, // IFD0 at offset 8
	0x01,
	0x00, // 1 entry
	...GPS_TAG_LE, // tag 0x8825 (GPSInfo), type LONG
	0x01,
	0x00,
	0x00,
	0x00, // count 1
	0x1a,
	0x00,
	0x00,
	0x00, // GPS IFD at offset 0x1a
	0x00,
	0x00,
	0x00,
	0x00, // next IFD: none
	0x00,
	0x00, // GPS IFD: 0 entries
	0x00,
	0x00,
	0x00,
	0x00, // GPS next IFD: none
];

// --- JPEG fixtures ---

const jpegSegment = (marker: number, payload: number[]) => [
	0xff,
	marker,
	...u16be(payload.length + 2),
	...payload,
];

const JPEG_TAIL = [
	...jpegSegment(0xdb, new Array(65).fill(1)), // DQT
	0xff,
	0xda,
	...u16be(4),
	0x01,
	0x00, // SOS
	0x12,
	0xff,
	0x00,
	0x56, // entropy-coded data (incl. a stuffed 0xFF00)
	0xff,
	0xd9, // EOI
];

const buildJpeg = (metaSegments: number[][]) =>
	Uint8Array.from([
		0xff,
		0xd8, // SOI
		...jpegSegment(0xe0, [...ascii("JFIF\0"), 1, 2, 0, 0, 1, 0, 1, 0, 0]),
		...metaSegments.flat(),
		...JPEG_TAIL,
	]);

const exifApp1 = jpegSegment(0xe1, [...ascii("Exif\0\0"), ...tiffWithGps()]);
const xmpApp1 = jpegSegment(0xe1, [
	...ascii("http://ns.adobe.com/xap/1.0/\0"),
	...ascii("<x:xmpmeta>gps</x:xmpmeta>"),
]);
const iptcApp13 = jpegSegment(0xed, [
	...ascii("Photoshop 3.0\0"),
	1,
	2,
	3,
	4,
]);
const iccApp2 = jpegSegment(0xe2, [...ascii("ICC_PROFILE\0"), 1, 1, 9, 9]);

// --- PNG fixtures ---

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const pngChunk = (type: string, data: number[]) => [
	...u32be(data.length),
	...ascii(type),
	...data,
	...u32be(0xdeadbeef), // CRC — not validated by the stripper
];

const buildPng = (metaChunks: number[][]) =>
	Uint8Array.from([
		...PNG_SIG,
		...pngChunk("IHDR", [...u32be(1), ...u32be(1), 8, 6, 0, 0, 0]),
		...metaChunks.flat(),
		...pngChunk("IDAT", [1, 2, 3, 4]),
		...pngChunk("IEND", []),
	]);

// --- WebP fixtures ---

const webpChunk = (fourcc: string, data: number[]) => [
	...ascii(fourcc),
	...u32le(data.length),
	...data,
	...(data.length % 2 === 1 ? [0] : []), // pad to even
];

const buildWebp = (chunks: number[][]) => {
	const body = [...ascii("WEBP"), ...chunks.flat()];
	return Uint8Array.from([...ascii("RIFF"), ...u32le(body.length), ...body]);
};

// VP8X flags byte: 0x20 ICC | 0x10 alpha | 0x08 EXIF | 0x04 XMP | 0x02 anim
const vp8x = (flags: number) =>
	webpChunk("VP8X", [flags, 0, 0, 0, ...u32be(0).slice(1), 0, 0, 0]);

// --- HEIF fixtures ---

const bmffBox = (type: string, payload: number[]) => [
	...u32be(payload.length + 8),
	...ascii(type),
	...payload,
];
const bmffFullBox = (type: string, version: number, payload: number[]) =>
	bmffBox(type, [version, 0, 0, 0, ...payload]);

const infeV2 = (itemId: number, itemType: string, contentType?: string) =>
	bmffFullBox("infe", 2, [
		...u16be(itemId),
		...u16be(0), // protection index
		...ascii(itemType),
		0, // item_name: empty c-string
		...(contentType ? [...ascii(contentType), 0] : []),
	]);

interface HeifItem {
	id: number;
	payload: number[];
	infe: number[];
}

/**
 * Assemble a minimal-but-structurally-valid HEIC: ftyp + meta(hdlr/iinf/iloc)
 * + mdat with each item's payload. iloc extent offsets are absolute file
 * offsets, computed via a fixed-size two-pass build.
 */
const buildHeif = (items: HeifItem[], opts: { ilocVersion?: 0 | 1 } = {}) => {
	const ilocVersion = opts.ilocVersion ?? 0;
	const ftyp = bmffBox("ftyp", [
		...ascii("heic"),
		...u32be(0),
		...ascii("mif1"),
		...ascii("heic"),
	]);
	const hdlr = bmffFullBox("hdlr", 0, [
		...u32be(0),
		...ascii("pict"),
		...u32be(0),
		...u32be(0),
		...u32be(0),
		0,
	]);
	const iinf = bmffFullBox("iinf", 0, [
		...u16be(items.length),
		...items.flatMap((i) => i.infe),
	]);
	// iloc: offset_size=4, length_size=4, base_offset_size=0, index_size=0
	const ilocPayloadFor = (offsets: number[]) => [
		0x44,
		0x00,
		...u16be(items.length),
		...items.flatMap((item, i) => [
			...u16be(item.id),
			...(ilocVersion === 1 ? u16be(0) : []), // construction_method 0 (file)
			...u16be(0), // data_reference_index: this file
			...u16be(1), // extent_count
			...u32be(offsets[i] ?? 0),
			...u32be(item.payload.length),
		]),
	];
	const metaFor = (offsets: number[]) =>
		bmffFullBox("meta", 0, [
			...hdlr,
			...iinf,
			...bmffFullBox("iloc", ilocVersion, ilocPayloadFor(offsets)),
		]);

	// Two-pass: sizes are offset-independent (u32 fields), so measure with
	// zeros then rebuild with real offsets.
	const headerLen = ftyp.length + metaFor(items.map(() => 0)).length + 8; // +8 mdat header
	const offsets: number[] = [];
	let cursor = headerLen;
	for (const item of items) {
		offsets.push(cursor);
		cursor += item.payload.length;
	}
	const mdat = bmffBox("mdat", items.flatMap((i) => i.payload));
	const bytes = Uint8Array.from([...ftyp, ...metaFor(offsets), ...mdat]);
	return { bytes, offsets };
};

const heifExifItem = (id = 1): HeifItem => ({
	id,
	payload: [...u32be(0), ...tiffWithGps()], // ExifDataBlock
	infe: infeV2(id, "Exif"),
});

const heifXmpItem = (id = 2): HeifItem => ({
	id,
	payload: ascii('<x:xmpmeta xmlns:x="adobe:ns:meta/">gps</x:xmpmeta>'),
	infe: infeV2(id, "mime", "application/rdf+xml"),
});

const heifImageItem = (id = 3): HeifItem => ({
	id,
	payload: [0xaa, 0xbb, 0xcc, 0xdd, 0xee],
	infe: infeV2(id, "hvc1"),
});

// --- tests ---

describe("stripImageMetadata — JPEG (LAC-3169)", () => {
	it("removes the Exif APP1 segment carrying GPS", () => {
		const input = buildJpeg([exifApp1]);
		expect(hasBytes(input, GPS_TAG_LE)).toBe(true);

		const result = stripImageMetadata(input);
		if (!result.ok) throw new Error("expected ok");
		expect(result.changed).toBe(true);
		expect(result.format).toBe("jpeg");
		expect(hasBytes(result.data, GPS_TAG_LE)).toBe(false);
		expect(hasBytes(result.data, ascii("Exif"))).toBe(false);
		// Image structure survives: SOI, JFIF, DQT, SOS, entropy data, EOI.
		expect(hasBytes(result.data, ascii("JFIF"))).toBe(true);
		expect(Array.from(result.data.slice(-2))).toEqual([0xff, 0xd9]);
	});

	it("removes XMP APP1, IPTC APP13 and COM but keeps the ICC APP2 profile", () => {
		const com = jpegSegment(0xfe, ascii("shot at 12.34,56.78"));
		const input = buildJpeg([xmpApp1, iccApp2, iptcApp13, com]);

		const result = stripImageMetadata(input);
		if (!result.ok) throw new Error("expected ok");
		expect(result.changed).toBe(true);
		expect(hasBytes(result.data, ascii("ns.adobe.com/xap"))).toBe(false);
		expect(hasBytes(result.data, ascii("Photoshop"))).toBe(false);
		expect(hasBytes(result.data, ascii("shot at"))).toBe(false);
		expect(hasBytes(result.data, ascii("ICC_PROFILE"))).toBe(true);
	});

	it("returns changed=false and identical bytes for a clean JPEG", () => {
		const input = buildJpeg([]);
		const result = stripImageMetadata(input);
		if (!result.ok) throw new Error("expected ok");
		expect(result.changed).toBe(false);
		expect(Array.from(result.data)).toEqual(Array.from(input));
	});

	it("fails closed on a truncated JPEG segment", () => {
		const input = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x00]);
		expect(stripImageMetadata(input).ok).toBe(false);
	});
});

describe("stripImageMetadata — PNG (LAC-3169)", () => {
	it("removes eXIf and textual chunks, keeps IHDR/IDAT/IEND", () => {
		const input = buildPng([
			pngChunk("eXIf", tiffWithGps()),
			pngChunk("tEXt", ascii("GPSLatitude\0 12.34")),
			pngChunk("iTXt", ascii("XML:com.adobe.xmp\0\0\0\0\0<gps/>")),
		]);
		expect(hasBytes(input, GPS_TAG_LE)).toBe(true);

		const result = stripImageMetadata(input);
		if (!result.ok) throw new Error("expected ok");
		expect(result.changed).toBe(true);
		expect(result.format).toBe("png");
		expect(hasBytes(result.data, GPS_TAG_LE)).toBe(false);
		expect(hasBytes(result.data, ascii("GPSLatitude"))).toBe(false);
		expect(hasBytes(result.data, ascii("IHDR"))).toBe(true);
		expect(hasBytes(result.data, ascii("IDAT"))).toBe(true);
		expect(hasBytes(result.data, ascii("IEND"))).toBe(true);
	});

	it("returns changed=false for a clean PNG", () => {
		const input = buildPng([]);
		const result = stripImageMetadata(input);
		if (!result.ok) throw new Error("expected ok");
		expect(result.changed).toBe(false);
		expect(Array.from(result.data)).toEqual(Array.from(input));
	});
});

describe("stripImageMetadata — WebP (LAC-3169)", () => {
	it("removes EXIF/XMP chunks, fixes the RIFF size and clears VP8X flags", () => {
		const input = buildWebp([
			vp8x(0x2c), // ICC | EXIF | XMP
			webpChunk("VP8 ", [1, 2, 3, 4, 5]),
			webpChunk("EXIF", tiffWithGps()),
			webpChunk("XMP ", ascii("<gps/>")),
		]);
		expect(hasBytes(input, GPS_TAG_LE)).toBe(true);

		const result = stripImageMetadata(input);
		if (!result.ok) throw new Error("expected ok");
		expect(result.changed).toBe(true);
		expect(result.format).toBe("webp");
		expect(hasBytes(result.data, GPS_TAG_LE)).toBe(false);
		expect(hasBytes(result.data, ascii("XMP "))).toBe(false);

		// RIFF size matches the shrunk body.
		const view = new DataView(result.data.buffer, result.data.byteOffset);
		expect(view.getUint32(4, true)).toBe(result.data.byteLength - 8);
		// VP8X keeps ICC (0x20) but drops EXIF (0x08) and XMP (0x04).
		const vp8xAt = result.data.findIndex(
			(_, i) =>
				result.data[i] === 0x56 &&
				result.data[i + 1] === 0x50 &&
				result.data[i + 2] === 0x38 &&
				result.data[i + 3] === 0x58,
		);
		expect(vp8xAt).toBeGreaterThan(0);
		expect(result.data[vp8xAt + 8]).toBe(0x20);
	});

	it("returns changed=false for a clean WebP", () => {
		const input = buildWebp([webpChunk("VP8 ", [1, 2, 3, 4, 5])]);
		const result = stripImageMetadata(input);
		if (!result.ok) throw new Error("expected ok");
		expect(result.changed).toBe(false);
		expect(Array.from(result.data)).toEqual(Array.from(input));
	});
});

describe("stripImageMetadata — HEIC/HEIF (LAC-3169)", () => {
	it("blanks the Exif item in place without moving any box offsets", () => {
		const { bytes, offsets } = buildHeif([heifExifItem(), heifImageItem()]);
		expect(hasBytes(bytes, GPS_TAG_LE)).toBe(true);

		const result = stripImageMetadata(bytes);
		if (!result.ok) throw new Error("expected ok");
		expect(result.changed).toBe(true);
		expect(result.format).toBe("heif");
		expect(result.data.byteLength).toBe(bytes.byteLength);
		expect(hasBytes(result.data, GPS_TAG_LE)).toBe(false);

		// Everything before the Exif payload is byte-identical — box offsets
		// referenced from iloc stay valid.
		expect(Array.from(result.data.slice(0, offsets[0]))).toEqual(
			Array.from(bytes.slice(0, offsets[0])),
		);
		// The unrelated image item's payload is untouched.
		const imgStart = offsets[1];
		expect(Array.from(result.data.slice(imgStart, imgStart + 5))).toEqual([
			0xaa, 0xbb, 0xcc, 0xdd, 0xee,
		]);
	});

	it("blanks XMP mime items too", () => {
		const { bytes } = buildHeif([heifExifItem(1), heifXmpItem(2)]);
		const result = stripImageMetadata(bytes);
		if (!result.ok) throw new Error("expected ok");
		expect(result.changed).toBe(true);
		expect(hasBytes(result.data, ascii("xmpmeta"))).toBe(false);
	});

	it("handles iloc version 1 with construction_method 0", () => {
		const { bytes } = buildHeif([heifExifItem()], { ilocVersion: 1 });
		expect(hasBytes(bytes, GPS_TAG_LE)).toBe(true);
		const result = stripImageMetadata(bytes);
		if (!result.ok) throw new Error("expected ok");
		expect(result.changed).toBe(true);
		expect(hasBytes(result.data, GPS_TAG_LE)).toBe(false);
	});

	it("returns changed=false when no metadata items exist", () => {
		const { bytes } = buildHeif([heifImageItem(1)]);
		const result = stripImageMetadata(bytes);
		if (!result.ok) throw new Error("expected ok");
		expect(result.changed).toBe(false);
		expect(Array.from(result.data)).toEqual(Array.from(bytes));
	});

	it("fails closed when an Exif extent points outside the file", () => {
		const { bytes, offsets } = buildHeif([heifExifItem()]);
		// Corrupt the iloc extent offset (last 8 bytes of iloc are offset+length
		// in this fixture): point it past EOF.
		const view = new DataView(bytes.buffer, bytes.byteOffset);
		// Find the offset value we wrote and overwrite it with a huge one.
		for (let i = 0; i + 4 <= bytes.length; i++) {
			if (view.getUint32(i) === offsets[0]) {
				view.setUint32(i, 0x7fffffff);
				break;
			}
		}
		expect(stripImageMetadata(bytes).ok).toBe(false);
	});
});

describe("stripImageMetadata — unknown formats", () => {
	it("fails closed on unrecognized bytes", () => {
		expect(stripImageMetadata(Uint8Array.from(ascii("GIF89a....."))).ok).toBe(
			false,
		);
		expect(stripImageMetadata(new Uint8Array(0)).ok).toBe(false);
		expect(stripImageMetadata(Uint8Array.from([1, 2, 3])).ok).toBe(false);
	});
});
