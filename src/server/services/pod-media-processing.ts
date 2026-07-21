/**
 * @fileoverview EXIF stripping / inspection for Photopods uploads (LAC-2917 H1).
 *
 * Default posture: strip all EXIF (including GPS + camera identifiers) from
 * every uploaded photo. Pod owners may opt in per-pod via `pods.retainLocationExif`
 * to preserve GPS + capture metadata (e.g. travel pods where geotags are the point).
 *
 * Uses `sharp` on the server. This module is Node-only.
 *
 * @module server/services/pod-media-processing
 */

import sharp from "sharp";

export interface RetainedExif {
	// Subset of tags we keep when the pod opts in to retention.
	gpsLatitude?: number;
	gpsLongitude?: number;
	gpsAltitude?: number;
	dateTimeOriginal?: string;
	make?: string;
	model?: string;
	orientation?: number;
}

export interface StripResult {
	buffer: Buffer;
	retained: RetainedExif | null;
	// True if the original had GPS tags before stripping.
	hadGps: boolean;
}

const SUPPORTED_MIMES = new Set([
	"image/jpeg",
	"image/png",
	"image/webp",
	"image/heic",
	"image/heif",
]);

const parseExif = (metadata: sharp.Metadata): RetainedExif => {
	const retained: RetainedExif = {};
	if (metadata.orientation) retained.orientation = metadata.orientation;
	// sharp exposes EXIF as a Buffer under `exif`. Decoding it fully needs
	// exif-reader; for the retention subset we read structured tags exposed
	// via `sharp` where possible and leave GPS coords for a follow-up parser
	// if callers need the numeric values. For H1 we only need to detect
	// presence — the actual retained coords come from the client for now.
	return retained;
};

/**
 * Look for a GPS IFD in the EXIF buffer. Handles JPEG APP1 EXIF and standalone
 * TIFF-style EXIF blocks. Returns true if any GPS tag is present.
 *
 * EXIF layout: [II|MM][0x2A00][ifd0Offset]... IFD0 entries include a pointer
 * (tag 0x8825) to the GPS IFD. Presence of that pointer is sufficient — we
 * don't need to walk the GPS IFD itself.
 */
const exifHasGps = (exif: Buffer | null | undefined): boolean => {
	if (!exif || exif.length < 8) return false;
	// sharp's `exif` buffer may or may not include the leading "Exif\0\0" header
	// depending on the source image; skip if present.
	let offset = 0;
	if (
		exif.length >= 6 &&
		exif[0] === 0x45 && // 'E'
		exif[1] === 0x78 && // 'x'
		exif[2] === 0x69 && // 'i'
		exif[3] === 0x66    // 'f'
	) {
		offset = 6;
	}
	if (exif.length - offset < 8) return false;
	const byteOrder = exif.readUInt16BE(offset);
	const isLittleEndian = byteOrder === 0x4949; // 'II'
	const isBigEndian = byteOrder === 0x4d4d;    // 'MM'
	if (!isLittleEndian && !isBigEndian) return false;
	const readU16 = (o: number) =>
		isLittleEndian ? exif.readUInt16LE(o) : exif.readUInt16BE(o);
	const readU32 = (o: number) =>
		isLittleEndian ? exif.readUInt32LE(o) : exif.readUInt32BE(o);
	const magic = readU16(offset + 2);
	if (magic !== 0x002a) return false;
	const ifd0 = offset + readU32(offset + 4);
	if (ifd0 + 2 > exif.length) return false;
	const numEntries = readU16(ifd0);
	for (let i = 0; i < numEntries; i++) {
		const entry = ifd0 + 2 + i * 12;
		if (entry + 2 > exif.length) return false;
		const tag = readU16(entry);
		// 0x8825 = GPSInfo IFD pointer. Its presence means the image carries
		// a GPS IFD, even if empty.
		if (tag === 0x8825) return true;
	}
	return false;
};

/**
 * Strip EXIF from an image buffer. Returns the stripped buffer plus a small
 * retained subset when the caller has opted in.
 *
 * @param input      raw image bytes
 * @param mimeType   client-declared MIME (used only to short-circuit)
 * @param options.retainMetadata true = keep EXIF/ICC (opt-in per pod)
 */
export const stripExif = async (
	input: Buffer,
	mimeType: string,
	options: { retainMetadata?: boolean } = {},
): Promise<StripResult> => {
	const mime = mimeType.toLowerCase();
	if (!SUPPORTED_MIMES.has(mime)) {
		// Unsupported format — return unchanged. Server rejects unsupported
		// MIMEs at the action layer; this is defense in depth.
		return { buffer: input, retained: null, hadGps: false };
	}

	const image = sharp(input, { failOn: "truncated" });
	const metadata = await image.metadata();
	const hadGps = exifHasGps(metadata.exif);
	const retained = options.retainMetadata ? parseExif(metadata) : null;

	// sharp drops EXIF, XMP, IPTC, and ICC by default. When retaining, keep
	// the full metadata block so downstream tools still see it.
	const pipeline = options.retainMetadata ? image.withMetadata() : image;
	// Preserve orientation visually by baking it into pixels when stripping.
	const rotated = options.retainMetadata ? pipeline : pipeline.rotate();
	const buffer = await rotated.toBuffer();

	return { buffer, retained, hadGps };
};

/**
 * Fast GPS presence check without re-encoding. Used by `finalizeUpload` to
 * verify that the client-side strip actually ran before we mark the media
 * ready. Reads metadata only — no pixel decode.
 */
export const hasGpsExif = async (input: Buffer): Promise<boolean> => {
	try {
		const metadata = await sharp(input).metadata();
		return exifHasGps(metadata.exif);
	} catch {
		// Unreadable/corrupt image — treat as "no GPS we can detect".
		// finalizeUpload's caller will still fail loudly if the media is
		// unusable at read time.
		return false;
	}
};
