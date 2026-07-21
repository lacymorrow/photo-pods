/**
 * @fileoverview Shared constants for the Photopods MVP frontend.
 *
 * Mirrors the values in the product spec ([LAC-2854]) and architecture doc
 * ([LAC-2855]). Keep in sync when the backend policy module lands on
 * [LAC-2857].
 */

export const POD_REACTION_EMOJIS = [
	"❤️",
	"😂",
	"😮",
	"🔥",
	"👏",
	"🙌",
	"😍",
	"🥲",
	"🤯",
	"👀",
	"🎉",
	"💯",
] as const;

export type PodReactionEmoji = (typeof POD_REACTION_EMOJIS)[number];

export const POD_VISIBILITY_VALUES = ["private", "group", "public"] as const;

export type PodVisibility = (typeof POD_VISIBILITY_VALUES)[number];

export const POD_VISIBILITY_LABEL: Record<PodVisibility, string> = {
	private: "Private",
	group: "Group",
	public: "Public",
};

export const POD_VISIBILITY_DESCRIPTION: Record<PodVisibility, string> = {
	private: "Only you can view and upload.",
	group: "Members you invite can view, upload, and react.",
	public: "Anyone can view. Signed-in people can upload and react.",
};

// Upload limits (bytes)
export const PHOTO_MAX_BYTES = 50 * 1024 * 1024;
export const VIDEO_MAX_BYTES = 500 * 1024 * 1024;
export const BATCH_UPLOAD_MAX = 50;

export const PHOTO_MIME_TYPES = [
	"image/jpeg",
	"image/png",
	"image/webp",
	"image/heic",
	"image/heif",
] as const;

export const VIDEO_MIME_TYPES = [
	"video/mp4",
	"video/quicktime",
	"video/webm",
] as const;

export const ACCEPTED_MIME_TYPES = [
	...PHOTO_MIME_TYPES,
	...VIDEO_MIME_TYPES,
] as const;

export const ACCEPTED_UPLOAD_ACCEPT = ACCEPTED_MIME_TYPES.join(",");

export const REPORT_REASONS = [
	{ id: "nudity", label: "Nudity or sexual content" },
	{ id: "violence", label: "Violence or graphic content" },
	{ id: "harassment", label: "Harassment or bullying" },
	{ id: "spam", label: "Spam or misleading" },
	{ id: "illegal", label: "Illegal activity" },
	{ id: "other", label: "Something else" },
] as const;

export type ReportReasonId = (typeof REPORT_REASONS)[number]["id"];

export const isPhotoMime = (mime: string) =>
	(PHOTO_MIME_TYPES as readonly string[]).includes(mime);

export const isVideoMime = (mime: string) =>
	(VIDEO_MIME_TYPES as readonly string[]).includes(mime);

/** Returns null if valid, otherwise a human-readable rejection reason. */
export const validateUploadFile = (file: File): string | null => {
	if (!(ACCEPTED_MIME_TYPES as readonly string[]).includes(file.type)) {
		return `${file.name}: unsupported format (${file.type || "unknown"}).`;
	}
	if (isPhotoMime(file.type) && file.size > PHOTO_MAX_BYTES) {
		return `${file.name}: photo exceeds 50MB limit.`;
	}
	if (isVideoMime(file.type) && file.size > VIDEO_MAX_BYTES) {
		return `${file.name}: video exceeds 500MB limit.`;
	}
	return null;
};
