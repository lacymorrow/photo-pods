/**
 * @fileoverview Client-side photo upload orchestration for Photopods (LAC-2912).
 *
 * Presigned flow: `requestPresignedUpload` → direct PUT to storage →
 * `finalizeUpload`. Falls back to the legacy formData server action only when
 * the server reports storage is not configured (pre-R2 dev environments); the
 * legacy action is gated off entirely once R2 is provisioned (LAC-2897 M4),
 * so it must never be the primary path.
 *
 * @module lib/pods/upload-media-client
 */

import {
	finalizeUpload,
	requestPresignedUpload,
	uploadPhoto,
} from "@/server/actions/pods";
import { stripExifClientSide } from "@/lib/pods/strip-exif-client";

/**
 * Best-effort dimension probe so `finalizeUpload` can persist width/height —
 * the R2 worker that would extract them server-side isn't built yet
 * (LAC-2855 §3). Failure is non-fatal; dimensions just stay unset.
 */
const readImageDimensions = async (
	file: File,
): Promise<{ width?: number; height?: number }> => {
	try {
		const bitmap = await createImageBitmap(file);
		const dims = { width: bitmap.width, height: bitmap.height };
		bitmap.close();
		return dims;
	} catch {
		return {};
	}
};

/**
 * Upload a single photo to a pod. Throws on failure; callers own retry/UI.
 */
export const uploadPodPhoto = async (
	podId: string,
	file: File,
): Promise<void> => {
	// Client-side EXIF/GPS strip (LAC-2917 H1). Canvas re-encode drops every
	// EXIF/XMP/IPTC segment before bytes leave the browser. No-op for non-image
	// mimes (videos handled by their own path). Bypassable by a hostile client
	// so the LAC-2855 §3 finalize worker must re-enforce server-side.
	const uploadFile = file.type.startsWith("image/")
		? await stripExifClientSide(file)
		: file;

	const presigned = await requestPresignedUpload({
		podId,
		filename: uploadFile.name,
		contentType: uploadFile.type,
		size: uploadFile.size,
	});

	if (presigned.fallback) {
		// Storage not configured (pre-R2 dev): the legacy action still works
		// there and does its own DB insert, so no finalize. Send the stripped
		// file so dev also honors the S4 default.
		const formData = new FormData();
		formData.set("file", uploadFile);
		await uploadPhoto(podId, formData);
		return;
	}

	// Content-Length is a forbidden request header in browsers — fetch derives
	// it from the body, which is exactly the `size` bound into the signature.
	const headers: Record<string, string> = { ...presigned.headers };
	delete headers["Content-Length"];

	const res = await fetch(presigned.uploadUrl, {
		method: presigned.method,
		headers,
		body: uploadFile,
	});
	if (!res.ok) {
		throw new Error(`Storage upload failed (HTTP ${res.status})`);
	}

	const dims = await readImageDimensions(uploadFile);
	await finalizeUpload({ mediaId: presigned.mediaId, ...dims });
};
