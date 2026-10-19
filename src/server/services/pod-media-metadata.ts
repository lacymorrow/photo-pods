/**
 * @fileoverview Server-side image metadata strip for Photopods (LAC-3169, S4).
 *
 * Byte-level surgery on the photo container formats we accept — JPEG, PNG,
 * WebP, HEIC/HEIF. Metadata segments are removed (JPEG/PNG/WebP) or blanked
 * in place (HEIF, where iloc offsets into mdat must stay valid). No image
 * decode happens, which is the point: browsers outside Safari can't decode
 * HEIC (so the LAC-2917 client canvas strip silently no-ops there) and
 * sharp's prebuilt binaries exclude libheif, so any decode-and-re-encode
 * approach leaves HEIC — the default iPhone format — leaking GPS.
 *
 * Fail-closed contract: when `ok` is false the caller MUST reject the
 * upload. A file we can't parse is a file we can't prove GPS-free.
 *
 * @module server/services/pod-media-metadata
 */

export type StripResult =
	| {
			ok: true;
			changed: boolean;
			data: Uint8Array;
			format: "jpeg" | "png" | "webp" | "heif";
	  }
	| { ok: false; reason: string };

/**
 * Strip EXIF/XMP/IPTC metadata from an image, detecting the container by
 * magic bytes (client-supplied MIME types are not trusted).
 */
export const stripImageMetadata = (input: Uint8Array): StripResult => {
	try {
		if (isJpeg(input)) return stripJpeg(input);
		if (isPng(input)) return stripPng(input);
		if (isWebp(input)) return stripWebp(input);
		if (isIsoBmff(input)) return stripHeif(input);
		return { ok: false, reason: "unrecognized image format" };
	} catch (error) {
		return {
			ok: false,
			reason: `malformed image: ${error instanceof Error ? error.message : "parse error"}`,
		};
	}
};

// --- format detection ---

const isJpeg = (b: Uint8Array) =>
	b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const isPng = (b: Uint8Array) =>
	b.length > 8 && PNG_SIG.every((v, i) => b[i] === v);

const fourcc = (b: Uint8Array, at: number) =>
	String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);

const isWebp = (b: Uint8Array) =>
	b.length > 12 && fourcc(b, 0) === "RIFF" && fourcc(b, 8) === "WEBP";

const isIsoBmff = (b: Uint8Array) => b.length > 12 && fourcc(b, 4) === "ftyp";

const view = (b: Uint8Array) =>
	new DataView(b.buffer, b.byteOffset, b.byteLength);

const fail = (message: string): never => {
	throw new Error(message);
};

// --- JPEG: drop metadata segments, keep everything the decoder needs ---

const JPEG_EOI = 0xd9;
const JPEG_SOS = 0xda;
const JPEG_COM = 0xfe;
const JPEG_APP0 = 0xe0;
const JPEG_APP2 = 0xe2;
const JPEG_APP14 = 0xee;
const JPEG_APP15 = 0xef;
const JPEG_RST_FIRST = 0xd0;
const JPEG_RST_LAST = 0xd7;

const ICC_PROFILE_TAG = [0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00];

const startsWith = (bytes: Uint8Array, tag: number[]) =>
	bytes.length >= tag.length && tag.every((value, index) => bytes[index] === value);

const JPEG_APP_NAMES = new Map<number, string>([
	[0xe1, "APP1 (Exif/XMP)"],
	[0xe3, "APP3 (Meta)"],
	[0xeb, "APP11 (JUMBF)"],
	[0xed, "APP13 (Photoshop/IPTC)"],
]);

/**
 * Name the metadata a JPEG segment carries, or null when the decoder needs it.
 *
 * This is an allowlist on purpose. APP0 (JFIF) and APP14 (Adobe transform)
 * are decode data. APP2 is decode data only when it holds an ICC profile:
 * the same marker also carries MPF, and iPhone HDR/depth and Samsung
 * dual-camera files park a complete second JPEG in there with its own Exif
 * and GPS (LAC-4972 F1). Every other APPn is metadata, so a marker nobody
 * has vetted fails closed instead of riding along.
 */
const jpegSegmentResidue = (marker: number, payload: Uint8Array): string | null => {
	if (marker === JPEG_COM) return "COM";
	if (marker < JPEG_APP0 || marker > JPEG_APP15) return null;
	if (marker === JPEG_APP0 || marker === JPEG_APP14) return null;
	if (marker === JPEG_APP2) {
		return startsWith(payload, ICC_PROFILE_TAG) ? null : "APP2 (non-ICC, e.g. MPF)";
	}
	return JPEG_APP_NAMES.get(marker) ?? `APP${marker - JPEG_APP0}`;
};

interface JpegSegment {
	/** Offset of the 0xFF that opens the segment. */
	start: number;
	/** Offset just past it — past the entropy-coded data, for SOS. */
	end: number;
	marker: number;
	/** Segment body, excluding marker and length. Empty for SOS entropy data. */
	payload: Uint8Array;
}

interface JpegLayout {
	segments: JpegSegment[];
	/** Offset of the 0xFF that opens EOI. */
	eoiStart: number;
	/** Bytes past EOI: motion-photo video, Samsung SEF, anything at all. */
	trailer: Uint8Array;
}

/**
 * Walk entropy-coded scan data to the next real marker. Inside a scan 0xFF
 * is either a stuffed 0xFF00, a fill byte, or a restart marker; anything
 * else ends the scan.
 */
const scanPastEntropy = (input: Uint8Array, from: number): number => {
	let pos = from;
	while (pos < input.length) {
		if (input[pos] !== 0xff) {
			pos++;
			continue;
		}
		const next = input[pos + 1];
		if (next === undefined) fail("truncated JPEG entropy data");
		if (next === 0xff) {
			pos++;
			continue;
		}
		if (next === 0x00 || (next! >= JPEG_RST_FIRST && next! <= JPEG_RST_LAST)) {
			pos += 2;
			continue;
		}
		return pos;
	}
	return fail("JPEG scan data ends without a marker");
};

/**
 * Parse a JPEG into its segments, the EOI, and whatever follows. One walker
 * for both the strip and the verify pass: when they each had their own, the
 * two disagreed about what the file even contained (LAC-4972 F1/F2).
 */
const readJpeg = (input: Uint8Array): JpegLayout => {
	const dv = view(input);
	const segments: JpegSegment[] = [];
	let pos = 2;

	while (pos < input.length) {
		if (input[pos] !== 0xff) fail(`expected JPEG marker at ${pos}`);
		// 0xFF padding before a marker is legal.
		let markerAt = pos;
		while (input[markerAt + 1] === 0xff) markerAt++;
		const marker = input[markerAt + 1];
		if (marker === undefined) fail("truncated JPEG");

		if (marker === JPEG_EOI) {
			return {
				segments,
				eoiStart: markerAt,
				trailer: input.subarray(markerAt + 2),
			};
		}

		if (markerAt + 4 > input.length) fail("truncated JPEG segment header");
		const length = dv.getUint16(markerAt + 2);
		if (length < 2) fail("invalid JPEG segment length");
		const payloadStart = markerAt + 4;
		const headerEnd = markerAt + 2 + length;
		if (headerEnd > input.length) fail("JPEG segment overruns file");

		// A scan's entropy data is not a segment and carries no length, so walk
		// it to the next marker. Progressive JPEGs have several scans, and the
		// old parser gave up at the first one — which is how the region past it
		// went unread.
		const end = marker === JPEG_SOS ? scanPastEntropy(input, headerEnd) : headerEnd;
		segments.push({
			start: pos,
			end,
			marker: marker!,
			payload: input.subarray(payloadStart, headerEnd),
		});
		pos = end;
	}

	return fail("JPEG ends without EOI");
};

const stripJpeg = (input: Uint8Array): StripResult => {
	const { segments, eoiStart, trailer } = readJpeg(input);
	const kept: Uint8Array[] = [input.subarray(0, 2)];
	let changed = false;

	for (const segment of segments) {
		if (jpegSegmentResidue(segment.marker, segment.payload)) {
			changed = true;
		} else {
			kept.push(input.subarray(segment.start, segment.end));
		}
	}
	kept.push(input.subarray(eoiStart, eoiStart + 2));

	// Past EOI is not image data. Samsung SEF trailers and Google motion
	// photos park a whole second file there, metadata and GPS included, and
	// neither pass can vouch for it. Truncating keeps the still image and
	// drops the payload we cannot clean (LAC-4972 F2).
	if (trailer.length > 0) changed = true;

	return {
		ok: true,
		changed,
		data: changed ? concat(kept) : input,
		format: "jpeg",
	};
};

// --- PNG: drop eXIf and textual chunks ---

const PNG_METADATA_CHUNKS = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);

interface PngChunk {
	start: number;
	end: number;
	type: string;
}

interface PngLayout {
	chunks: PngChunk[];
	/** Offset just past IEND. */
	imageEnd: number;
	/** Bytes past IEND, which a PNG is not supposed to have. */
	trailer: Uint8Array;
}

/** Parse a PNG into its chunks and whatever sits past IEND. */
const readPng = (input: Uint8Array): PngLayout => {
	const dv = view(input);
	const chunks: PngChunk[] = [];
	let pos = 8;

	while (pos < input.length) {
		if (pos + 8 > input.length) fail("truncated PNG chunk header");
		const length = dv.getUint32(pos);
		const type = fourcc(input, pos + 4);
		const end = pos + 8 + length + 4; // header + data + CRC
		if (end > input.length) fail("PNG chunk overruns file");
		chunks.push({ start: pos, end, type });
		pos = end;
		if (type === "IEND") {
			return { chunks, imageEnd: end, trailer: input.subarray(end) };
		}
	}

	return fail("PNG ends without IEND");
};

const stripPng = (input: Uint8Array): StripResult => {
	const { chunks, trailer } = readPng(input);
	const kept: Uint8Array[] = [input.subarray(0, 8)];
	let changed = false;

	for (const chunk of chunks) {
		if (PNG_METADATA_CHUNKS.has(chunk.type)) {
			changed = true;
		} else {
			kept.push(input.subarray(chunk.start, chunk.end));
		}
	}

	// Same reasoning as the JPEG trailer: an eXIf chunk appended past IEND is
	// still readable by anything scanning the file, and is not image data
	// (LAC-4972 F2).
	if (trailer.length > 0) changed = true;

	return {
		ok: true,
		changed,
		data: changed ? concat(kept) : input,
		format: "png",
	};
};

// --- WebP: drop EXIF/XMP chunks, patch RIFF size and VP8X flags ---

const WEBP_METADATA_CHUNKS = new Set(["EXIF", "XMP "]);
const VP8X_EXIF_FLAG = 0x08;
const VP8X_XMP_FLAG = 0x04;

const stripWebp = (input: Uint8Array): StripResult => {
	const dv = view(input);
	const kept: Uint8Array[] = [];
	let pos = 12;
	let droppedChunk = false;
	let staleFlags = false;
	let vp8xFlagOffsetInOutput = -1;
	let outputLength = 0;

	while (pos < input.length) {
		if (pos + 8 > input.length) fail("truncated WebP chunk header");
		const type = fourcc(input, pos);
		const length = dv.getUint32(pos + 4, true);
		const padded = length + (length % 2);
		const end = pos + 8 + padded;
		if (end > input.length) fail("WebP chunk overruns file");

		if (WEBP_METADATA_CHUNKS.has(type)) {
			droppedChunk = true;
		} else {
			if (type === "VP8X") {
				vp8xFlagOffsetInOutput = outputLength + 8;
				staleFlags =
					((input[pos + 8] ?? 0) & (VP8X_EXIF_FLAG | VP8X_XMP_FLAG)) !== 0;
			}
			kept.push(input.subarray(pos, end));
			outputLength += end - pos;
		}
		pos = end;
	}

	// Clear the flag bits whenever they are set, not only when a chunk went
	// away. A file advertising EXIF it does not actually contain used to come
	// out unchanged and then fail verification, which left the uploader with
	// a rejection no retry could fix (LAC-4972 F3).
	const changed = droppedChunk || staleFlags;
	if (!changed) return { ok: true, changed: false, data: input, format: "webp" };

	const body = concat(kept);
	const out = new Uint8Array(12 + body.length);
	out.set(input.subarray(0, 12));
	out.set(body, 12);
	view(out).setUint32(4, out.length - 8, true);
	if (vp8xFlagOffsetInOutput >= 0) {
		const at = 12 + vp8xFlagOffsetInOutput;
		out[at] = out[at]! & ~(VP8X_EXIF_FLAG | VP8X_XMP_FLAG);
	}
	return { ok: true, changed: true, data: out, format: "webp" };
};

// --- HEIF/HEIC: blank Exif + XMP item payloads in place ---
//
// Removing boxes from an ISO-BMFF file would shift every iloc offset, so
// instead the metadata item payloads are overwritten in place: byte length
// and box structure stay identical, and readers see an empty (but valid)
// EXIF block. Orientation is unaffected — HEIF stores it in irot/imir
// container properties, not EXIF.

interface BmffBox {
	type: string;
	start: number;
	payloadStart: number;
	end: number;
}

const walkBoxes = (b: Uint8Array, start: number, end: number): BmffBox[] => {
	const dv = view(b);
	const boxes: BmffBox[] = [];
	let pos = start;
	while (pos + 8 <= end) {
		const size32 = dv.getUint32(pos);
		const type = fourcc(b, pos + 4);
		let payloadStart = pos + 8;
		let size = size32;
		if (size32 === 0) {
			size = end - pos; // box extends to end of enclosing scope
		} else if (size32 === 1) {
			if (pos + 16 > end) fail("truncated 64-bit box size");
			const large = dv.getBigUint64(pos + 8);
			if (large > BigInt(Number.MAX_SAFE_INTEGER)) fail("box too large");
			size = Number(large);
			payloadStart = pos + 16;
		}
		if (size < payloadStart - pos || pos + size > end) {
			fail(`box '${type}' overruns scope`);
		}
		boxes.push({ type, start: pos, payloadStart, end: pos + size });
		pos += size;
	}
	return boxes;
};

const readCString = (
	b: Uint8Array,
	at: number,
	end: number,
): { value: string; next: number } => {
	let cursor = at;
	while (cursor < end && b[cursor] !== 0) cursor++;
	return {
		value: String.fromCharCode(...b.subarray(at, cursor)),
		next: Math.min(cursor + 1, end),
	};
};

type MetadataKind = "exif" | "xmp";

/** Item IDs of metadata-carrying items, from the iinf/infe entries. */
const collectMetadataItems = (
	b: Uint8Array,
	iinf: BmffBox,
): Map<number, MetadataKind> => {
	const dv = view(b);
	const version = b[iinf.payloadStart]!;
	const countSize = version === 0 ? 2 : 4;
	const entriesStart = iinf.payloadStart + 4 + countSize;
	const items = new Map<number, MetadataKind>();

	for (const box of walkBoxes(b, entriesStart, iinf.end)) {
		if (box.type !== "infe") continue;
		const infeVersion = b[box.payloadStart]!;
		// infe v0/v1 predate HEIF and don't carry item_type; nothing modern
		// writes them, and an entry we can't classify might hide metadata.
		if (infeVersion < 2) fail(`unsupported infe version ${infeVersion}`);
		let cursor = box.payloadStart + 4;
		const itemId =
			infeVersion === 2 ? dv.getUint16(cursor) : dv.getUint32(cursor);
		cursor += infeVersion === 2 ? 2 : 4;
		cursor += 2; // item_protection_index
		const itemType = fourcc(b, cursor);
		cursor += 4;
		if (itemType === "Exif") {
			items.set(itemId, "exif");
		} else if (itemType === "mime") {
			const name = readCString(b, cursor, box.end);
			const contentType = readCString(b, name.next, box.end);
			if (/xml/i.test(contentType.value)) items.set(itemId, "xmp");
		}
	}
	return items;
};

interface ItemExtent {
	kind: MetadataKind;
	offset: number;
	length: number;
}

const readUint = (b: Uint8Array, at: number, size: number): number => {
	let value = 0;
	for (let i = 0; i < size; i++) value = value * 256 + b[at + i]!;
	if (!Number.isSafeInteger(value)) fail("integer overflow in iloc");
	return value;
};

/** Absolute file ranges of the metadata items, resolved from iloc. */
const resolveExtents = (
	b: Uint8Array,
	iloc: BmffBox,
	idat: BmffBox | undefined,
	targets: Map<number, MetadataKind>,
): ItemExtent[] => {
	const dv = view(b);
	const version = b[iloc.payloadStart]!;
	if (version > 2) fail(`unsupported iloc version ${version}`);
	let cursor = iloc.payloadStart + 4;
	const offsetSize = b[cursor]! >> 4;
	const lengthSize = b[cursor]! & 0xf;
	const baseOffsetSize = b[cursor + 1]! >> 4;
	const indexSize = version === 0 ? 0 : b[cursor + 1]! & 0xf;
	cursor += 2;
	const itemCount = version < 2 ? dv.getUint16(cursor) : dv.getUint32(cursor);
	cursor += version < 2 ? 2 : 4;

	const extents: ItemExtent[] = [];
	for (let i = 0; i < itemCount; i++) {
		const itemId = version < 2 ? dv.getUint16(cursor) : dv.getUint32(cursor);
		cursor += version < 2 ? 2 : 4;
		let constructionMethod = 0;
		if (version === 1 || version === 2) {
			constructionMethod = dv.getUint16(cursor) & 0xf;
			cursor += 2;
		}
		const dataReferenceIndex = dv.getUint16(cursor);
		cursor += 2;
		const baseOffset = readUint(b, cursor, baseOffsetSize);
		cursor += baseOffsetSize;
		const extentCount = dv.getUint16(cursor);
		cursor += 2;

		for (let e = 0; e < extentCount; e++) {
			cursor += indexSize; // extent_index — unused
			const extentOffset = readUint(b, cursor, offsetSize);
			cursor += offsetSize;
			const extentLength = readUint(b, cursor, lengthSize);
			cursor += lengthSize;

			const kind = targets.get(itemId);
			if (!kind) continue;
			if (dataReferenceIndex !== 0) fail("metadata item in external file");
			let absolute: number;
			if (constructionMethod === 0) {
				absolute = baseOffset + extentOffset;
			} else if (constructionMethod === 1) {
				if (!idat) fail("iloc references idat but meta has none");
				absolute = idat!.payloadStart + baseOffset + extentOffset;
			} else {
				fail(`unsupported iloc construction method ${constructionMethod}`);
				continue;
			}
			if (absolute + extentLength > b.length) {
				fail("metadata extent points outside the file");
			}
			extents.push({ kind, offset: absolute, length: extentLength });
		}
	}
	return extents;
};

// Minimal valid ExifDataBlock: exif_tiff_header_offset=0, then a
// little-endian TIFF whose IFD0 has zero entries. Readers parse it cleanly
// and find nothing.
const EMPTY_EXIF_BLOCK = Uint8Array.from([
	0x00, 0x00, 0x00, 0x00, 0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

const stripHeif = (input: Uint8Array): StripResult => {
	const topLevel = walkBoxes(input, 0, input.length);
	const meta = topLevel.find((box) => box.type === "meta");
	if (!meta) return { ok: true, changed: false, data: input, format: "heif" };

	// meta is a FullBox: 4 bytes of version/flags before its children.
	const children = walkBoxes(input, meta.payloadStart + 4, meta.end);
	const iinf = children.find((box) => box.type === "iinf");
	const iloc = children.find((box) => box.type === "iloc");
	const idat = children.find((box) => box.type === "idat");
	if (!iinf || !iloc) {
		return { ok: true, changed: false, data: input, format: "heif" };
	}

	const targets = collectMetadataItems(input, iinf);
	if (targets.size === 0) {
		return { ok: true, changed: false, data: input, format: "heif" };
	}

	const extents = resolveExtents(input, iloc, idat, targets);
	if (extents.length === 0) {
		// Metadata items are declared but not locatable — nothing we can blank,
		// so nothing a reader can find either.
		return { ok: true, changed: false, data: input, format: "heif" };
	}

	const out = input.slice();
	const firstExifBlanked = new Set<MetadataKind>();
	for (const extent of extents) {
		out.fill(
			extent.kind === "xmp" ? 0x20 : 0x00,
			extent.offset,
			extent.offset + extent.length,
		);
		if (
			extent.kind === "exif" &&
			!firstExifBlanked.has("exif") &&
			extent.length >= EMPTY_EXIF_BLOCK.length
		) {
			out.set(EMPTY_EXIF_BLOCK, extent.offset);
			firstExifBlanked.add("exif");
		}
	}
	return { ok: true, changed: true, data: out, format: "heif" };
};

// --- shared ---

const concat = (parts: Uint8Array[]): Uint8Array => {
	const total = parts.reduce((sum, p) => sum + p.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
};

// --- verification (LAC-2932) ---
//
// Stripping and verifying are separate events. `stripImageMetadata` reports
// what it *did*; this reports what is *left* in a set of bytes, by re-walking
// the container from scratch. Only a clean verdict from here justifies
// stamping `pod_media.exif_verified_at`.
//
// Re-running the stripper is not a substitute. For HEIF it blanks payloads in
// place and leaves the iinf/iloc declarations intact, so a second strip pass
// always reports `changed: true` on an already-clean file. Verification has to
// look at the payload bytes, not at whether a write happened.

export type VerifyResult =
	| {
			ok: true;
			clean: boolean;
			/** What is still present, when `clean` is false. */
			residue?: string;
			format: "jpeg" | "png" | "webp" | "heif";
	  }
	| { ok: false; reason: string };

/**
 * Check that a set of image bytes carries no EXIF/XMP/IPTC payload. Same
 * fail-closed contract as the stripper: `ok: false` means we could not parse
 * the container, which is not a pass.
 */
export const verifyImageMetadataStripped = (input: Uint8Array): VerifyResult => {
	try {
		if (isJpeg(input)) return verifyJpeg(input);
		if (isPng(input)) return verifyPng(input);
		if (isWebp(input)) return verifyWebp(input);
		if (isIsoBmff(input)) return verifyHeif(input);
		return { ok: false, reason: "unrecognized image format" };
	} catch (error) {
		return {
			ok: false,
			reason: `malformed image: ${error instanceof Error ? error.message : "parse error"}`,
		};
	}
};

const verifyJpeg = (input: Uint8Array): VerifyResult => {
	const { segments, trailer } = readJpeg(input);

	for (const segment of segments) {
		const residue = jpegSegmentResidue(segment.marker, segment.payload);
		if (residue) return { ok: true, clean: false, residue, format: "jpeg" };
	}

	// Never report clean for a region that was not read. The strip truncates
	// here, so bytes past EOI mean the file did not come through the stripper
	// (LAC-4972 F2).
	if (trailer.length > 0) {
		return {
			ok: true,
			clean: false,
			residue: `${trailer.length} bytes trailing after EOI`,
			format: "jpeg",
		};
	}

	return { ok: true, clean: true, format: "jpeg" };
};

const verifyPng = (input: Uint8Array): VerifyResult => {
	const { chunks, trailer } = readPng(input);

	for (const chunk of chunks) {
		if (PNG_METADATA_CHUNKS.has(chunk.type)) {
			return {
				ok: true,
				clean: false,
				residue: `${chunk.type} chunk`,
				format: "png",
			};
		}
	}

	if (trailer.length > 0) {
		return {
			ok: true,
			clean: false,
			residue: `${trailer.length} bytes trailing after IEND`,
			format: "png",
		};
	}

	return { ok: true, clean: true, format: "png" };
};

const verifyWebp = (input: Uint8Array): VerifyResult => {
	const dv = view(input);
	let pos = 12;
	let vp8xFlags = 0;

	while (pos < input.length) {
		if (pos + 8 > input.length) fail("truncated WebP chunk header");
		const type = fourcc(input, pos);
		const length = dv.getUint32(pos + 4, true);
		const end = pos + 8 + length + (length % 2);
		if (end > input.length) fail("WebP chunk overruns file");
		if (WEBP_METADATA_CHUNKS.has(type)) {
			return {
				ok: true,
				clean: false,
				residue: `${type.trim()} chunk`,
				format: "webp",
			};
		}
		if (type === "VP8X") vp8xFlags = input[pos + 8] ?? 0;
		pos = end;
	}

	// The chunks are gone but the container still advertises them: readers may
	// go looking, and the stripper is supposed to clear these bits.
	if (vp8xFlags & (VP8X_EXIF_FLAG | VP8X_XMP_FLAG)) {
		return {
			ok: true,
			clean: false,
			residue: "VP8X metadata flag still set",
			format: "webp",
		};
	}

	return { ok: true, clean: true, format: "webp" };
};

/** True when an EXIF item payload holds nothing but the empty TIFF stub. */
const isBlankedExif = (bytes: Uint8Array): boolean => {
	const allZero = (b: Uint8Array) => b.every((value) => value === 0x00);
	if (allZero(bytes)) return true;
	if (bytes.length < EMPTY_EXIF_BLOCK.length) return false;
	const stubbed = EMPTY_EXIF_BLOCK.every((value, index) => bytes[index] === value);
	return stubbed && allZero(bytes.subarray(EMPTY_EXIF_BLOCK.length));
};

const verifyHeif = (input: Uint8Array): VerifyResult => {
	const topLevel = walkBoxes(input, 0, input.length);
	const meta = topLevel.find((box) => box.type === "meta");
	if (!meta) return { ok: true, clean: true, format: "heif" };

	const children = walkBoxes(input, meta.payloadStart + 4, meta.end);
	const iinf = children.find((box) => box.type === "iinf");
	const iloc = children.find((box) => box.type === "iloc");
	const idat = children.find((box) => box.type === "idat");
	if (!iinf || !iloc) return { ok: true, clean: true, format: "heif" };

	const targets = collectMetadataItems(input, iinf);
	if (targets.size === 0) return { ok: true, clean: true, format: "heif" };

	// Declared but unlocatable items carry nothing a reader can reach, which
	// is what the stripper relies on too.
	for (const extent of resolveExtents(input, iloc, idat, targets)) {
		const bytes = input.subarray(extent.offset, extent.offset + extent.length);
		const blank =
			extent.kind === "xmp"
				? bytes.every((value) => value === 0x20)
				: isBlankedExif(bytes);
		if (!blank) {
			return {
				ok: true,
				clean: false,
				residue: `${extent.kind === "xmp" ? "XMP" : "Exif"} item payload`,
				format: "heif",
			};
		}
	}

	return { ok: true, clean: true, format: "heif" };
};
