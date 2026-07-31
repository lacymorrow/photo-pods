/**
 * Generates the on-disk media fixtures the Photopods E2E suite needs
 * (LAC-3138). Large binaries are deliberately NOT committed to git.
 *
 * Outputs (under tests/e2e/fixtures/):
 *   gps-tagged.jpg    ~15 KB   valid JPEG with GPS EXIF for S4 (LAC-2917 EXIF strip)
 *   photo-50mb.jpg    ~49.9 MB inside the 50 MB accept boundary
 *   photo-51mb.jpg    ~51.0 MB just past the 50 MB reject boundary
 *   video-500mb.mp4   ~499.9 MB inside the 500 MB accept boundary
 *   video-501mb.mp4   ~501.0 MB just past the 500 MB reject boundary
 *   batch-51/         51 tiny JPEGs, for the batch-cap (LAC-2913) test
 *
 * The photo-{50,51}mb.jpg files are a real JPEG SOI/EOI plus JPEG "comment"
 * (COM) segments to pad to size — that keeps the byte stream syntactically
 * valid so ImageMagick/sharp/EXIF parsers won't reject the file outright.
 *
 * Videos are padded with MP4 `free` boxes so a container parser sees a
 * well-formed (empty) MP4 rather than random bytes.
 *
 * Usage:
 *   bun run scripts/gen-e2e-media.ts             # generate everything
 *   bun run scripts/gen-e2e-media.ts gps          # gps-tagged.jpg only
 *   bun run scripts/gen-e2e-media.ts photos       # just the sized photos
 *   bun run scripts/gen-e2e-media.ts videos       # just the sized videos
 *   bun run scripts/gen-e2e-media.ts batch        # just batch-51/
 */

import { mkdirSync, writeFileSync, existsSync, openSync, writeSync, closeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES_DIR = path.resolve(__dirname, "../tests/e2e/fixtures");

const MB = 1024 * 1024;

function ensureDir(p: string) {
	mkdirSync(p, { recursive: true });
}

/**
 * Build EXIF bytes with the GPS IFD populated. The values encode
 * 37° 46' 30" N, 122° 25' 09" W (San Francisco).
 *
 * Format matches the Exif standard v2.31: TIFF header → 0th IFD →
 * GPS sub-IFD. Refs: https://www.exiv2.org/tags-gps.html
 */
function buildExifWithGps(): Buffer {
	const parts: number[] = [];
	// TIFF header (little-endian)
	parts.push(0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00);

	// 0th IFD: 1 entry (GPS IFD pointer), then next IFD = 0
	const ifd0Start = parts.length;
	parts.push(0x01, 0x00); // 1 entry
	// GPSInfo tag: id 0x8825, type LONG(4), count 1, value = offset of GPS IFD
	parts.push(0x25, 0x88, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00);
	// placeholder for GPS IFD offset (4 bytes), patched below
	const gpsOffsetPos = parts.length;
	parts.push(0x00, 0x00, 0x00, 0x00);
	// next IFD offset = 0
	parts.push(0x00, 0x00, 0x00, 0x00);

	// GPS IFD (4 entries: LatRef, Lat, LonRef, Lon)
	const gpsIfdOffset = parts.length;
	parts.push(0x04, 0x00); // 4 entries

	// GPSLatitudeRef "N\0" — id 0x0001, type ASCII(2), count 2, value "N\0\0\0"
	parts.push(0x01, 0x00, 0x02, 0x00, 0x02, 0x00, 0x00, 0x00, 0x4e, 0x00, 0x00, 0x00);
	// GPSLatitude — id 0x0002, type RATIONAL(5), count 3, value = offset (patched)
	const latOffsetPos = parts.length + 8;
	parts.push(0x02, 0x00, 0x05, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
	// GPSLongitudeRef "W\0"
	parts.push(0x03, 0x00, 0x02, 0x00, 0x02, 0x00, 0x00, 0x00, 0x57, 0x00, 0x00, 0x00);
	// GPSLongitude — id 0x0004, type RATIONAL(5), count 3, value = offset (patched)
	const lonOffsetPos = parts.length + 8;
	parts.push(0x04, 0x00, 0x05, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
	// next IFD offset = 0
	parts.push(0x00, 0x00, 0x00, 0x00);

	const pushRational = (num: number, den: number) => {
		parts.push(num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, (num >> 24) & 0xff);
		parts.push(den & 0xff, (den >> 8) & 0xff, (den >> 16) & 0xff, (den >> 24) & 0xff);
	};

	// GPS rationals live after the GPS IFD:
	// Latitude 37/1, 46/1, 30/1
	const latDataOffset = parts.length;
	pushRational(37, 1);
	pushRational(46, 1);
	pushRational(30, 1);
	// Longitude 122/1, 25/1, 9/1
	const lonDataOffset = parts.length;
	pushRational(122, 1);
	pushRational(25, 1);
	pushRational(9, 1);

	// Patch offsets
	const buf = Buffer.from(parts);
	buf.writeUInt32LE(gpsIfdOffset, gpsOffsetPos);
	buf.writeUInt32LE(latDataOffset, latOffsetPos);
	buf.writeUInt32LE(lonDataOffset, lonOffsetPos);
	return buf;
}

async function makeGpsTaggedJpeg(outPath: string) {
	const exifBlock = buildExifWithGps();
	// sharp's `withExif` expects a structured object; the "raw exif chunk"
	// escape hatch is `withExifMerge` in newer sharps but is not universal.
	// Simplest reliable path: build the JPEG ourselves — write SOI, an APP1
	// segment carrying "Exif\0\0" + our TIFF bytes, then a real minimal
	// JPEG body produced by sharp (which we then splice in without its own
	// APP0/APP1 segments).
	const baseJpeg = await sharp({
		create: {
			width: 64,
			height: 64,
			channels: 3,
			background: { r: 128, g: 128, b: 200 },
		},
	})
		.jpeg({ quality: 80, mozjpeg: false })
		.toBuffer();

	// Skip existing APP markers in the base JPEG so we don't duplicate them.
	// baseJpeg starts with SOI (FFD8). We want to insert APP1 right after SOI.
	if (baseJpeg[0] !== 0xff || baseJpeg[1] !== 0xd8) {
		throw new Error("Unexpected base JPEG (no SOI)");
	}

	// APP1 = FFE1, length = payload length + 2, payload = "Exif\0\0" + tiff
	const exifSig = Buffer.from([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);
	const payload = Buffer.concat([exifSig, exifBlock]);
	const segLen = payload.length + 2;
	if (segLen > 0xffff) throw new Error("EXIF payload too large for single APP1");
	const app1 = Buffer.concat([
		Buffer.from([0xff, 0xe1, (segLen >> 8) & 0xff, segLen & 0xff]),
		payload,
	]);

	// Cursor past SOI, then skip any pre-existing APP0/APP1 the encoder inserted.
	let cursor = 2;
	while (
		cursor < baseJpeg.length - 1 &&
		baseJpeg[cursor] === 0xff &&
		(baseJpeg[cursor + 1] === 0xe0 || baseJpeg[cursor + 1] === 0xe1)
	) {
		const len = baseJpeg.readUInt16BE(cursor + 2);
		cursor += 2 + len;
	}

	const out = Buffer.concat([
		Buffer.from([0xff, 0xd8]),
		app1,
		baseJpeg.subarray(cursor),
	]);

	writeFileSync(outPath, out);
	console.log(`wrote ${outPath} (${out.length} bytes)`);
}

/**
 * Pads a base JPEG to `targetBytes` by appending JPEG COM (comment)
 * segments between SOI and the first real segment. Each COM segment is
 * up to 65535 bytes so we chain as many as needed.
 */
async function makePaddedJpeg(outPath: string, targetBytes: number) {
	const base = await sharp({
		create: {
			width: 128,
			height: 128,
			channels: 3,
			background: { r: 240, g: 240, b: 240 },
		},
	})
		.jpeg({ quality: 90 })
		.toBuffer();

	if (base[0] !== 0xff || base[1] !== 0xd8) throw new Error("Unexpected base JPEG");

	const paddingNeeded = targetBytes - base.length;
	if (paddingNeeded <= 0) {
		writeFileSync(outPath, base);
		console.log(`wrote ${outPath} (${base.length} bytes, no padding needed)`);
		return;
	}

	// Each COM segment: FFFE + 2 bytes big-endian length + payload
	// Length = payload + 2. Max payload = 65533. Overhead = 4 bytes/segment.
	const chunks: Buffer[] = [Buffer.from([0xff, 0xd8])];
	let remaining = paddingNeeded;
	while (remaining > 0) {
		const payloadLen = Math.min(remaining - 4, 65533);
		if (payloadLen <= 0) {
			// Trailing bytes < 4: pad an extra tiny COM segment
			const p = Math.max(1, remaining);
			chunks.push(Buffer.from([0xff, 0xfe]));
			const segLen = p + 2;
			chunks.push(Buffer.from([(segLen >> 8) & 0xff, segLen & 0xff]));
			chunks.push(Buffer.alloc(p, 0x20));
			remaining = 0;
			break;
		}
		chunks.push(Buffer.from([0xff, 0xfe]));
		const segLen = payloadLen + 2;
		chunks.push(Buffer.from([(segLen >> 8) & 0xff, segLen & 0xff]));
		chunks.push(Buffer.alloc(payloadLen, 0x20));
		remaining -= payloadLen + 4;
	}
	chunks.push(base.subarray(2));

	const out = Buffer.concat(chunks);
	writeFileSync(outPath, out);
	console.log(`wrote ${outPath} (${out.length} bytes)`);
}

/**
 * Writes a well-formed but empty MP4 padded to `targetBytes` using ftyp +
 * a single giant `free` box (per ISO/IEC 14496-12). A `free` box with
 * `size = 1` uses a 64-bit largesize field, letting us exceed 4 GB if
 * we ever needed it. Here 501 MB fits comfortably in the 32-bit size.
 */
function makePaddedMp4(outPath: string, targetBytes: number) {
	// ftyp box: 32 bytes — 4 size + "ftyp" + "isom" + 4-byte minor + "isom" + "mp41"
	const ftyp = Buffer.from([
		0x00, 0x00, 0x00, 0x20, // size = 32
		0x66, 0x74, 0x79, 0x70, // "ftyp"
		0x69, 0x73, 0x6f, 0x6d, // "isom"
		0x00, 0x00, 0x02, 0x00, // minor version
		0x69, 0x73, 0x6f, 0x6d, // compatible: "isom"
		0x69, 0x73, 0x6f, 0x32, // "iso2"
		0x61, 0x76, 0x63, 0x31, // "avc1"
		0x6d, 0x70, 0x34, 0x31, // "mp41"
	]);

	// free box header: 8 bytes (4 size + "free"); rest is arbitrary bytes.
	const freeHeaderSize = 8;
	const freeSize = targetBytes - ftyp.length;
	if (freeSize < freeHeaderSize + 1) {
		throw new Error(`targetBytes too small for MP4 (${targetBytes})`);
	}
	if (freeSize > 0xffffffff) {
		throw new Error("free box size overflows 32-bit; add 64-bit largesize path");
	}

	// Stream the file to avoid holding 500 MB in memory.
	const fd = openSync(outPath, "w");
	try {
		writeSync(fd, ftyp);
		// free box header
		const header = Buffer.alloc(8);
		header.writeUInt32BE(freeSize, 0);
		header.write("free", 4, "utf-8");
		writeSync(fd, header);

		const chunk = Buffer.alloc(1 * MB, 0x00);
		let remaining = freeSize - freeHeaderSize;
		while (remaining > 0) {
			const n = Math.min(remaining, chunk.length);
			writeSync(fd, chunk, 0, n);
			remaining -= n;
		}
	} finally {
		closeSync(fd);
	}
	console.log(`wrote ${outPath} (~${(targetBytes / MB).toFixed(1)} MB)`);
}

async function makeBatchDir(outDir: string, count: number) {
	ensureDir(outDir);
	for (let i = 0; i < count; i++) {
		const filename = `batch-${String(i).padStart(3, "0")}.jpg`;
		const p = path.join(outDir, filename);
		if (existsSync(p)) continue;
		const buf = await sharp({
			create: {
				width: 32,
				height: 32,
				channels: 3,
				background: { r: (i * 5) % 255, g: (i * 3) % 255, b: (i * 7) % 255 },
			},
		})
			.jpeg({ quality: 50 })
			.toBuffer();
		writeFileSync(p, buf);
	}
	console.log(`wrote ${count} images to ${outDir}`);
}

async function main() {
	ensureDir(FIXTURES_DIR);
	const only = process.argv[2] ?? "all";

	if (only === "all" || only === "gps") {
		await makeGpsTaggedJpeg(path.join(FIXTURES_DIR, "gps-tagged.jpg"));
	}
	if (only === "all" || only === "photos") {
		await makePaddedJpeg(path.join(FIXTURES_DIR, "photo-50mb.jpg"), Math.floor(49.9 * MB));
		await makePaddedJpeg(path.join(FIXTURES_DIR, "photo-51mb.jpg"), Math.floor(51 * MB));
	}
	if (only === "all" || only === "videos") {
		makePaddedMp4(path.join(FIXTURES_DIR, "video-500mb.mp4"), Math.floor(499.9 * MB));
		makePaddedMp4(path.join(FIXTURES_DIR, "video-501mb.mp4"), Math.floor(501 * MB));
	}
	if (only === "all" || only === "batch") {
		await makeBatchDir(path.join(FIXTURES_DIR, "batch-51"), 51);
	}
}

main().catch((err) => {
	console.error("gen-e2e-media failed:", err);
	process.exit(1);
});
