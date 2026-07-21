/**
 * @fileoverview Object-storage abstraction for Photopods media (LAC-2857).
 *
 * Target: Cloudflare R2 in production (see LAC-2855 architecture §2).
 * Dev/CI: any S3-compatible endpoint (MinIO) — same API, different env vars.
 * Fallback (no S3 configured): the existing Vercel Blob path in `services/file`.
 *
 * The public surface is presigned PUT URLs for direct-to-storage upload from the
 * client, plus signed GET URLs for private/group media served through a
 * membership-checked route.
 *
 * @module server/services/pod-storage
 */

import crypto from "node:crypto";

import type { MediaType } from "@/server/db/pods-schema";

export interface StorageConfig {
	provider: "r2" | "s3" | "vercel-blob";
	bucket: string | null;
	publicBaseUrl: string | null;
	accessKeyId: string | null;
	secretAccessKey: string | null;
	endpoint: string | null;
	region: string;
}

export const loadStorageConfig = (): StorageConfig => {
	const bucket =
		process.env.PHOTOPODS_R2_BUCKET ??
		process.env.AWS_S3_BUCKET ??
		process.env.S3_BUCKET ??
		null;
	const endpoint =
		process.env.PHOTOPODS_R2_ENDPOINT ??
		process.env.S3_ENDPOINT ??
		process.env.AWS_ENDPOINT_URL_S3 ??
		null;
	const accessKeyId =
		process.env.PHOTOPODS_R2_ACCESS_KEY_ID ??
		process.env.AWS_ACCESS_KEY_ID ??
		null;
	const secretAccessKey =
		process.env.PHOTOPODS_R2_SECRET_ACCESS_KEY ??
		process.env.AWS_SECRET_ACCESS_KEY ??
		null;
	const publicBaseUrl =
		process.env.PHOTOPODS_R2_PUBLIC_URL ??
		process.env.PHOTOPODS_MEDIA_CDN_URL ??
		null;
	const region = process.env.PHOTOPODS_R2_REGION ?? "auto";

	if (accessKeyId && secretAccessKey && bucket) {
		return {
			provider: endpoint?.includes("r2.cloudflarestorage.com") ? "r2" : "s3",
			bucket,
			publicBaseUrl,
			accessKeyId,
			secretAccessKey,
			endpoint,
			region,
		};
	}

	return {
		provider: "vercel-blob",
		bucket: null,
		publicBaseUrl: null,
		accessKeyId: null,
		secretAccessKey: null,
		endpoint: null,
		region,
	};
};

/**
 * Deterministic object key for a media upload. Includes the pod for
 * per-pod cleanup and the media id for uniqueness.
 */
export const buildStorageKey = (
	podId: string,
	mediaId: string,
	type: MediaType,
	extension: string,
): string => {
	const safeExt = extension.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 6) || "bin";
	const bucket = type === "video" ? "videos" : "photos";
	return `pods/${podId}/${bucket}/${mediaId}.${safeExt}`;
};

// --- Signing (SigV4 for S3/R2) ---

const sha256 = (input: string | Buffer): Buffer =>
	crypto.createHash("sha256").update(input).digest();

const hmac = (key: string | Buffer, data: string): Buffer =>
	crypto.createHmac("sha256", key).update(data).digest();

const hexEncode = (buf: Buffer): string => buf.toString("hex");

const encodeRfc3986 = (value: string): string =>
	encodeURIComponent(value).replace(
		/[!'()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	);

interface PresignInput {
	config: StorageConfig;
	method: "PUT" | "GET" | "DELETE";
	key: string;
	contentType?: string;
	contentLength?: number;
	expiresInSeconds: number;
}

/**
 * Presigned URL with AWS SigV4 (compatible with R2, S3, MinIO). Signing
 * is done inline to avoid pulling `@aws-sdk/s3-request-presigner` for a
 * couple of routes.
 */
export const presign = ({
	config,
	method,
	key,
	contentType,
	contentLength,
	expiresInSeconds,
}: PresignInput): string => {
	if (
		config.provider === "vercel-blob" ||
		!config.bucket ||
		!config.accessKeyId ||
		!config.secretAccessKey ||
		!config.endpoint
	) {
		throw new Error("S3-compatible storage is not configured");
	}

	const now = new Date();
	const amzDate = now
		.toISOString()
		.replace(/[:-]|\.\d{3}/g, "")
		.slice(0, 15) + "Z";
	const dateStamp = amzDate.slice(0, 8);
	const service = "s3";
	const region = config.region;

	const endpointUrl = new URL(config.endpoint);
	// Virtual-hosted style: the bucket is already a subdomain of the endpoint
	// host (e.g. `mybucket.s3.amazonaws.com`). Detect and skip the bucket
	// segment in the path; otherwise use path-style (`/bucket/key`) which R2
	// and MinIO both support.
	const bucketHostPrefix = `${config.bucket}.`;
	const isVirtualHosted = endpointUrl.hostname.startsWith(bucketHostPrefix);
	const host = endpointUrl.host;
	const encodedKey = key.split("/").map(encodeRfc3986).join("/");
	const canonicalUri = isVirtualHosted
		? `/${encodedKey}`
		: `/${encodeRfc3986(config.bucket)}/${encodedKey}`;

	const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

	const signedHeaders = ["host"];
	if (method === "PUT" && contentType) signedHeaders.push("content-type");
	// Bind the signature to the exact byte length so the storage backend
	// rejects PUTs that don't match — prevents storage-cost DoS via a
	// presigned URL for 5 MB being used to upload 500 GB.
	if (method === "PUT" && contentLength != null) signedHeaders.push("content-length");
	// SigV4 requires header names sorted alphabetically in the signed list.
	signedHeaders.sort();
	const signedHeadersString = signedHeaders.join(";");

	const query: Record<string, string> = {
		"X-Amz-Algorithm": "AWS4-HMAC-SHA256",
		"X-Amz-Credential": `${config.accessKeyId}/${credentialScope}`,
		"X-Amz-Date": amzDate,
		"X-Amz-Expires": String(expiresInSeconds),
		"X-Amz-SignedHeaders": signedHeadersString,
	};

	const canonicalQueryString = Object.entries(query)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
		.join("&");

	const canonicalHeaders = [
		...(method === "PUT" && contentLength != null
			? [`content-length:${contentLength}`]
			: []),
		...(method === "PUT" && contentType ? [`content-type:${contentType}`] : []),
		`host:${host}`,
	].join("\n") + "\n";

	const payloadHash = "UNSIGNED-PAYLOAD";

	const canonicalRequest = [
		method,
		canonicalUri,
		canonicalQueryString,
		canonicalHeaders,
		signedHeadersString,
		payloadHash,
	].join("\n");

	const stringToSign = [
		"AWS4-HMAC-SHA256",
		amzDate,
		credentialScope,
		hexEncode(sha256(canonicalRequest)),
	].join("\n");

	const kDate = hmac(`AWS4${config.secretAccessKey}`, dateStamp);
	const kRegion = hmac(kDate, region);
	const kService = hmac(kRegion, service);
	const kSigning = hmac(kService, "aws4_request");
	const signature = hexEncode(hmac(kSigning, stringToSign));

	const finalQuery = `${canonicalQueryString}&X-Amz-Signature=${signature}`;
	return `${endpointUrl.protocol}//${host}${canonicalUri}?${finalQuery}`;
};

/**
 * URL used to fetch/serve the media. For public pods with a public bucket
 * we return the CDN URL; otherwise callers should go through the signed
 * media route in `app/api/pods/media/[mediaId]/route.ts`.
 */
export const publicUrlForKey = (
	config: StorageConfig,
	key: string,
): string | null => {
	if (!config.publicBaseUrl) return null;
	const base = config.publicBaseUrl.replace(/\/$/, "");
	return `${base}/${key}`;
};

export const isStorageConfigured = (): boolean =>
	loadStorageConfig().provider !== "vercel-blob";

// --- Object mutation / read helpers ---

export interface DeleteResult {
	ok: boolean;
	status: number;
	error?: string;
}

/**
 * Issue an S3/R2 DELETE for a single object key. Presigned so we don't need
 * to introduce the AWS SDK just for one route.
 *
 * A 404 counts as success (the object is already gone — GDPR requirement is
 * satisfied). 403 is treated as a permission failure worth logging.
 */
export const deleteObject = async (
	config: StorageConfig,
	key: string,
): Promise<DeleteResult> => {
	if (config.provider === "vercel-blob" || !config.bucket) {
		return { ok: false, status: 0, error: "storage_not_configured" };
	}
	try {
		const url = presign({ config, method: "DELETE", key, expiresInSeconds: 60 });
		const res = await fetch(url, { method: "DELETE" });
		if (res.ok || res.status === 404) {
			return { ok: true, status: res.status };
		}
		return {
			ok: false,
			status: res.status,
			error: `${res.status} ${res.statusText}`,
		};
	} catch (err) {
		return {
			ok: false,
			status: 0,
			error: err instanceof Error ? err.message : "unknown",
		};
	}
};

/**
 * Fetch a byte range from an object (used to sniff EXIF from a photo without
 * pulling the whole file). Returns null on any error.
 */
export const fetchObjectRange = async (
	config: StorageConfig,
	key: string,
	rangeEnd: number,
): Promise<Buffer | null> => {
	if (config.provider === "vercel-blob" || !config.bucket) return null;
	try {
		const url = presign({ config, method: "GET", key, expiresInSeconds: 60 });
		const res = await fetch(url, {
			method: "GET",
			headers: { Range: `bytes=0-${Math.max(0, rangeEnd)}` },
		});
		if (!res.ok && res.status !== 206) return null;
		const buf = Buffer.from(await res.arrayBuffer());
		return buf;
	} catch {
		return null;
	}
};

/**
 * Fetch a full object as a Buffer. Used by the video finalize path
 * (LAC-2933) to pull the uploaded MP4/MOV for atom-level GPS scrubbing.
 * Returns null on any error.
 */
export const fetchObject = async (
	config: StorageConfig,
	key: string,
): Promise<Buffer | null> => {
	if (config.provider === "vercel-blob" || !config.bucket) return null;
	try {
		const url = presign({ config, method: "GET", key, expiresInSeconds: 60 });
		const res = await fetch(url, { method: "GET" });
		if (!res.ok) return null;
		return Buffer.from(await res.arrayBuffer());
	} catch {
		return null;
	}
};

/**
 * PUT an object body via a presigned URL. Used by the video finalize path
 * (LAC-2933) to write back scrubbed MP4/MOV bytes. Returns false on any
 * error so the caller can fail closed.
 */
export const putObject = async (
	config: StorageConfig,
	key: string,
	body: Buffer,
	contentType: string,
): Promise<boolean> => {
	if (config.provider === "vercel-blob" || !config.bucket) return false;
	try {
		const url = presign({
			config,
			method: "PUT",
			key,
			contentType,
			contentLength: body.byteLength,
			expiresInSeconds: 60,
		});
		const res = await fetch(url, {
			method: "PUT",
			headers: {
				"Content-Type": contentType,
				"Content-Length": String(body.byteLength),
			},
			body: new Uint8Array(body),
		});
		return res.ok;
	} catch {
		return false;
	}
};
