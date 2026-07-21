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
	method: "PUT" | "GET";
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
	const host = endpointUrl.host;
	const canonicalUri = `/${encodeRfc3986(config.bucket)}/${key
		.split("/")
		.map(encodeRfc3986)
		.join("/")}`;

	const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

	const signedHeaders = ["host"];
	if (method === "PUT" && contentType) signedHeaders.push("content-type");
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
		`host:${host}`,
		...(method === "PUT" && contentType ? [`content-type:${contentType}`] : []),
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
	// contentLength is enforced by the client-side PUT; we do not include it in
	// the signature because doing so would bind us to the exact byte length.
	void contentLength;
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
