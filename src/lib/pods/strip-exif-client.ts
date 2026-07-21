/**
 * @fileoverview Client-side EXIF strip for Photopods uploads (LAC-2917 H1).
 *
 * Runs in the browser via `<canvas>` re-encode. Every EXIF/XMP/IPTC segment
 * is dropped because canvas emits pixels only. Orientation is preserved
 * visually by rendering through an <img> that has already applied EXIF
 * orientation.
 *
 * @module lib/pods/strip-exif-client
 */

const CANVAS_MIME_FALLBACK = "image/jpeg";
const JPEG_QUALITY = 0.92;

const canvasCompatibleMime = (mime: string): string => {
	const lower = mime.toLowerCase();
	// Canvas can only encode png / jpeg / webp reliably. HEIC/HEIF fall
	// through to JPEG, which is still a full EXIF-strip win over the
	// original geotagged file.
	if (
		lower === "image/png" ||
		lower === "image/webp" ||
		lower === "image/jpeg"
	) {
		return lower;
	}
	return CANVAS_MIME_FALLBACK;
};

/**
 * Return a File with EXIF stripped. Preserves the display name and mime type
 * where the browser can encode it; falls back to JPEG for HEIC/HEIF.
 *
 * If the browser can't decode the image at all we resolve with the original
 * file — the server enforces the EXIF check as a backstop.
 */
export const stripExifClientSide = async (file: File): Promise<File> => {
	if (typeof window === "undefined" || !file.type.startsWith("image/")) {
		return file;
	}
	const outMime = canvasCompatibleMime(file.type);

	const bitmap = await loadBitmap(file);
	if (!bitmap) return file;

	const canvas = document.createElement("canvas");
	canvas.width = bitmap.width;
	canvas.height = bitmap.height;
	const ctx = canvas.getContext("2d");
	if (!ctx) return file;
	ctx.drawImage(bitmap, 0, 0);
	if ("close" in bitmap && typeof bitmap.close === "function") bitmap.close();

	const blob: Blob | null = await new Promise((resolve) => {
		canvas.toBlob(
			(b) => resolve(b),
			outMime,
			outMime === "image/jpeg" ? JPEG_QUALITY : undefined,
		);
	});
	if (!blob) return file;

	// Keep the extension aligned with the encoded mime.
	const name = file.name.replace(
		/\.[^.]+$/,
		outMime === "image/png" ? ".png" : outMime === "image/webp" ? ".webp" : ".jpg",
	);
	return new File([blob], name, { type: outMime, lastModified: Date.now() });
};

const loadBitmap = async (file: File): Promise<ImageBitmap | HTMLImageElement | null> => {
	if (typeof createImageBitmap === "function") {
		try {
			// `imageOrientation: "from-image"` bakes EXIF orientation into
			// pixels so the stripped output looks the same as the original.
			return await createImageBitmap(file, { imageOrientation: "from-image" });
		} catch {
			// fall through to <img>
		}
	}
	return await loadImageElement(file);
};

const loadImageElement = (file: File): Promise<HTMLImageElement | null> =>
	new Promise((resolve) => {
		const url = URL.createObjectURL(file);
		const img = new Image();
		img.onload = () => {
			URL.revokeObjectURL(url);
			resolve(img);
		};
		img.onerror = () => {
			URL.revokeObjectURL(url);
			resolve(null);
		};
		img.src = url;
	});
