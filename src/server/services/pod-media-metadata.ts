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

// APP1 (Exif/XMP), APP13 (Photoshop/IPTC) and COM carry metadata; APP0
// (JFIF), APP2 (ICC color profile) and APP14 (Adobe transform) are needed
// for correct decoding and carry no location/identity data.
const JPEG_METADATA_MARKERS = new Set([0xe1, 0xed, 0xfe]);

const stripJpeg = (input: Uint8Array): StripResult => {
	const dv = view(input);
	const kept: Uint8Array[] = [input.subarray(0, 2)];
	let pos = 2;
	let changed = false;

	while (pos < input.length) {
		if (input[pos] !== 0xff) fail(`expected JPEG marker at ${pos}`);
		// Skip fill bytes (0xFF padding before a marker is legal).
		let markerAt = pos;
		while (input[markerAt + 1] === 0xff) markerAt++;
		const marker = input[markerAt + 1];
		if (marker === undefined) fail("truncated JPEG");

		if (marker === 0xd9) {
			// EOI without SOS — degenerate but well-formed enough to pass through.
			kept.push(input.subarray(pos));
			break;
		}
		if (marker === 0xda) {
			// Start of scan: entropy-coded data follows; copy the rest verbatim.
			kept.push(input.subarray(pos));
			break;
		}
		if (markerAt + 4 > input.length) fail("truncated JPEG segment header");
		const length = dv.getUint16(markerAt + 2);
		if (length < 2) fail("invalid JPEG segment length");
		const end = markerAt + 2 + length;
		if (end > input.length) fail("JPEG segment overruns file");

		if (JPEG_METADATA_MARKERS.has(marker!)) {
			changed = true;
		} else {
			kept.push(input.subarray(pos, end));
		}
		pos = end;
	}

	return {
		ok: true,
		changed,
		data: changed ? concat(kept) : input,
		format: "jpeg",
	};
};

// --- PNG: drop eXIf and textual chunks ---

const PNG_METADATA_CHUNKS = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);

const stripPng = (input: Uint8Array): StripResult => {
	const dv = view(input);
	const kept: Uint8Array[] = [input.subarray(0, 8)];
	let pos = 8;
	let changed = false;

	while (pos < input.length) {
		if (pos + 8 > input.length) fail("truncated PNG chunk header");
		const length = dv.getUint32(pos);
		const type = fourcc(input, pos + 4);
		const end = pos + 8 + length + 4; // header + data + CRC
		if (end > input.length) fail("PNG chunk overruns file");

		if (PNG_METADATA_CHUNKS.has(type)) {
			changed = true;
		} else {
			kept.push(input.subarray(pos, end));
		}
		pos = end;
		if (type === "IEND") {
			kept.push(input.subarray(pos)); // trailing bytes, if any
			break;
		}
	}

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
	let changed = false;
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
			changed = true;
		} else {
			if (type === "VP8X") vp8xFlagOffsetInOutput = outputLength + 8;
			kept.push(input.subarray(pos, end));
			outputLength += end - pos;
		}
		pos = end;
	}

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
