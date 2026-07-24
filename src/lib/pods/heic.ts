/**
 * @fileoverview HEIC/HEIF detection for Photopods uploads (LAC-2915).
 *
 * Client-safe module — no server imports. Most browsers can't decode HEIC,
 * so `PhotoUpload` uses this to skip object-URL previews for these files.
 * MIME type alone is unreliable: some platforms (notably Windows) report an
 * empty type for .heic files, so the extension is checked as a fallback.
 */

export function isHeicFile(file: Pick<File, "name" | "type">): boolean {
	if (/^image\/hei[cf]/.test(file.type)) return true;
	if (file.type !== "") return false;
	return /\.hei[cf]$/i.test(file.name);
}
