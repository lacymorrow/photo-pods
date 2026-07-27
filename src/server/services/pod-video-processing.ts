/**
 * @fileoverview MP4/MOV atom-level GPS metadata scrubbing for Photopods
 * video uploads (LAC-2933, LAC-2949).
 *
 * MP4 and QuickTime containers carry GPS metadata in several locations:
 * - `moov/udta`: Apple `©xyz` ISO 6709 location + Android capture tags
 * - `moov/meta`: Apple `keys`/`ilst` with `com.apple.quicktime.location.*`
 * - `uuid` boxes: ISOBMFF arbitrary metadata keyed by 16-byte UUID.
 *   Adobe XMP (UUID be7acfcb-97a9-42e8-9c71-999491e3afac) can carry
 *   `exif:GPSLatitude` / `exif:GPSLongitude`. GoPro, drones, and some
 *   Android OEMs write proprietary GPS uuid boxes.
 *
 * Strategy: parse the box tree and, for every `udta`, `meta`, `©xyz`, or
 * `uuid` box we find, rewrite the box header type to `free` and zero the
 * payload. `free` is a standard padding box that spec-compliant parsers
 * skip, so downstream consumers see a well-formed file with no GPS
 * metadata. Because we keep box sizes constant, `stco`/`co64` chunk
 * offsets do not need to be fixed up.
 *
 * Fail-closed model (LAC-2928 pattern): parse errors throw from
 * `scrubMp4Metadata` and cause `hasVideoGpsMetadata` to return true.
 * Callers must reject the upload on either signal.
 *
 * @module server/services/pod-video-processing
 */

// Container box types whose payload is more boxes. We recurse into these
// while walking the tree so scrubbing reaches nested `udta`/`meta`.
const CONTAINER_TYPES = new Set([
	"moov",
	"trak",
	"mdia",
	"minf",
	"stbl",
	"edts",
	"mvex",
	"dinf",
	"moof",
	"traf",
	"mfra",
]);

// Box types that carry (or can carry) GPS/location metadata. The whole
// payload of a matched box is zeroed and its type is rewritten to `free`.
const SCRUB_TYPES = new Set([
	"udta", // Apple ©xyz ISO 6709 location + other capture tags live here
	"meta", // ISOBMFF/QuickTime metadata container (keys/ilst)
	"©xyz", // top-level or nested Apple location box
	"uuid", // ISOBMFF arbitrary metadata — Adobe XMP, GoPro, proprietary GPS (LAC-2949)
]);

const FREE_TYPE = Buffer.from("free", "ascii");

interface Box {
	offset: number;
	headerSize: number;
	size: number;
	type: string;
	dataOffset: number;
	dataSize: number;
}

const readBox = (buf: Buffer, offset: number, end: number): Box => {
	if (offset + 8 > end) {
		throw new Error(`Malformed MP4: box header past container end at ${offset}`);
	}
	const size32 = buf.readUInt32BE(offset);
	const type = buf.subarray(offset + 4, offset + 8).toString("latin1");
	let size = size32;
	let headerSize = 8;
	if (size32 === 1) {
		if (offset + 16 > end) {
			throw new Error(
				`Malformed MP4: extended-size header past container end at ${offset}`,
			);
		}
		const high = buf.readUInt32BE(offset + 8);
		const low = buf.readUInt32BE(offset + 12);
		size = high * 0x1_0000_0000 + low;
		headerSize = 16;
	} else if (size32 === 0) {
		size = end - offset;
	}
	if (size < headerSize) {
		throw new Error(
			`Malformed MP4: box size ${size} < header ${headerSize} at ${offset}`,
		);
	}
	if (offset + size > end) {
		throw new Error(
			`Malformed MP4: box size ${size} exceeds container end at ${offset}`,
		);
	}
	return {
		offset,
		headerSize,
		size,
		type,
		dataOffset: offset + headerSize,
		dataSize: size - headerSize,
	};
};

const scrubBox = (buf: Buffer, box: Box): void => {
	// Preserve the size field so the surrounding tree stays intact; rewrite
	// the 4-byte type to `free` and zero the payload. Any GPS bytes (©xyz
	// header, ISO 6709 string, Apple key strings) inside the payload are
	// physically overwritten.
	FREE_TYPE.copy(buf, box.offset + 4);
	if (box.dataSize > 0) {
		buf.fill(0, box.dataOffset, box.dataOffset + box.dataSize);
	}
};

const walkAndScrub = (buf: Buffer, start: number, end: number): void => {
	let cursor = start;
	while (cursor < end) {
		const box = readBox(buf, cursor, end);
		if (SCRUB_TYPES.has(box.type)) {
			scrubBox(buf, box);
		} else if (CONTAINER_TYPES.has(box.type)) {
			walkAndScrub(buf, box.dataOffset, box.dataOffset + box.dataSize);
		}
		cursor += box.size;
	}
};

const looksLikeIsoBmff = (buf: Buffer): boolean => {
	if (buf.length < 8) return false;
	// ISOBMFF/QuickTime files start with a small handful of well-known
	// top-level box types. Reject anything that doesn't look like one so we
	// fail closed on non-video uploads sneaking through the MIME check.
	const type = buf.subarray(4, 8).toString("latin1");
	return (
		type === "ftyp" ||
		type === "moov" ||
		type === "free" ||
		type === "skip" ||
		type === "wide" ||
		type === "mdat" ||
		type === "styp"
	);
};

/**
 * Strip GPS/location metadata from an MP4 or MOV buffer.
 *
 * Returns a NEW buffer; the input is not modified. Fails closed (throws)
 * when the file cannot be parsed as ISOBMFF/QuickTime.
 */
export const scrubMp4Metadata = (input: Buffer): Buffer => {
	if (!looksLikeIsoBmff(input)) {
		throw new Error("Not a recognizable MP4/MOV container");
	}
	const output = Buffer.from(input);
	walkAndScrub(output, 0, output.length);
	return output;
};

const GPS_MARKERS: Buffer[] = [
	// Apple ©xyz box type (four bytes: 0xA9 'x' 'y' 'z').
	Buffer.from([0xa9, 0x78, 0x79, 0x7a]),
	// Apple keys-atom key string. Any `com.apple.quicktime.location.*` variant
	// starts with this prefix, so matching the prefix catches all of them.
	Buffer.from("com.apple.quicktime.location", "ascii"),
	// XMP GPS fields written by Adobe, GoPro, and desktop editors (LAC-2949).
	Buffer.from("exif:GPSLatitude", "ascii"),
	Buffer.from("exif:GPSLongitude", "ascii"),
	// Adobe XMP uuid identifier (be7acfcb-97a9-42e8-9c71-999491e3afac).
	// Presence means an XMP packet that may contain GPS survived scrubbing.
	Buffer.from([0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8, 0x9c, 0x71, 0x99, 0x94, 0x91, 0xe3, 0xaf, 0xac]),
];

/**
 * Detect GPS/location metadata in an MP4/MOV buffer.
 *
 * Used by the finalize path to verify `scrubMp4Metadata` cleaned the file
 * before we mark the media row ready. Combines a structural walk (any live
 * `udta`/`meta`/`©xyz` box means GPS could still be present) with a
 * byte-level scan for known Apple GPS markers.
 *
 * Fails closed (returns true) if the buffer cannot be parsed — a malformed
 * file with GPS in an unparsed segment must not slip through.
 */
export const hasVideoGpsMetadata = (input: Buffer): boolean => {
	try {
		if (!looksLikeIsoBmff(input)) return true;
		let structuralHit = false;
		const walk = (start: number, end: number): void => {
			let cursor = start;
			while (cursor < end) {
				const box = readBox(input, cursor, end);
				if (SCRUB_TYPES.has(box.type)) {
					structuralHit = true;
					return;
				}
				if (CONTAINER_TYPES.has(box.type)) {
					walk(box.dataOffset, box.dataOffset + box.dataSize);
					if (structuralHit) return;
				}
				cursor += box.size;
			}
		};
		walk(0, input.length);
		if (structuralHit) return true;
		return GPS_MARKERS.some((needle) => input.includes(needle));
	} catch (err) {
		console.warn("[hasVideoGpsMetadata] parse failed, failing closed", err);
		return true;
	}
};
