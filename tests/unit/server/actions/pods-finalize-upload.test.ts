import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock refs so vi.mock() factories can share them with test bodies.
const mocks = vi.hoisted(() => ({
	auth: vi.fn(async () => ({ user: { id: "u-1", role: "user" } })),
	findFirst: vi.fn(),
	updateCalls: [] as Array<{ values: Record<string, unknown> }>,
	dbUpdate: vi.fn(),
	loadStorageConfig: vi.fn(),
	presign: vi.fn(
		({ method }: { method: string }) => `https://r2.example/${method.toLowerCase()}`,
	),
	fetch: vi.fn(),
}));

vi.mock("@/server/auth", () => ({ auth: mocks.auth }));

vi.mock("@/server/db", () => ({
	db: {
		query: { podMedia: { findFirst: mocks.findFirst } },
		update: mocks.dbUpdate,
	},
}));

vi.mock("@/server/services/pod-policy", () => ({}));
vi.mock("@/server/services/pod-reactions", () => ({}));

vi.mock("@/server/services/pod-storage", () => ({
	isStorageConfigured: vi.fn(() => true),
	loadStorageConfig: mocks.loadStorageConfig,
	buildStorageKey: vi.fn(),
	presign: mocks.presign,
	publicUrlForKey: vi.fn(() => null),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { finalizeUpload } from "@/server/actions/pods";

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff];

// Minimal JPEG with a GPS-bearing Exif APP1 segment.
const GPS_TAG_LE = [0x25, 0x88, 0x04, 0x00];
const jpegSegment = (marker: number, payload: number[]) => [
	0xff,
	marker,
	...u16be(payload.length + 2),
	...payload,
];
const gpsJpeg = () =>
	Uint8Array.from([
		0xff,
		0xd8,
		...jpegSegment(0xe1, [
			...ascii("Exif\0\0"),
			...ascii("II"),
			0x2a,
			0x00,
			0x08,
			0x00,
			0x00,
			0x00,
			0x01,
			0x00,
			...GPS_TAG_LE,
			0x01,
			0x00,
			0x00,
			0x00,
			0x1a,
			0x00,
			0x00,
			0x00,
			0x00,
			0x00,
			0x00,
			0x00,
		]),
		0xff,
		0xda,
		...u16be(4),
		0x01,
		0x00,
		0x12,
		0x34,
		0xff,
		0xd9,
	]);

const cleanJpeg = () =>
	Uint8Array.from([
		0xff,
		0xd8,
		0xff,
		0xda,
		...u16be(4),
		0x01,
		0x00,
		0x12,
		0x34,
		0xff,
		0xd9,
	]);

const hasBytes = (haystack: Uint8Array, needle: number[]): boolean => {
	outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
		for (let j = 0; j < needle.length; j++) {
			if (haystack[i + j] !== needle[j]) continue outer;
		}
		return true;
	}
	return false;
};

const mediaRow = (overrides: Record<string, unknown> = {}) => ({
	id: "m-1",
	podId: "p-1",
	uploadedById: "u-1",
	type: "photo",
	status: "processing",
	storageKey: "pods/p-1/photos/m-1.jpg",
	mimeType: "image/jpeg",
	size: 100,
	width: null,
	height: null,
	durationSeconds: null,
	caption: null,
	url: null,
	readyAt: null,
	exifStripped: null,
	...overrides,
});

const okResponse = (bytes?: Uint8Array) =>
	({
		ok: true,
		status: 200,
		arrayBuffer: async () =>
			bytes ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : new ArrayBuffer(0),
	}) as unknown as Response;

describe("finalizeUpload — server-side EXIF enforcement (LAC-3169)", () => {
	beforeEach(() => {
		mocks.findFirst.mockReset();
		mocks.updateCalls.length = 0;
		mocks.dbUpdate.mockReset();
		mocks.dbUpdate.mockImplementation(() => ({
			set: (values: Record<string, unknown>) => {
				const call = { values };
				mocks.updateCalls.push(call);
				return {
					where: () => {
						const result = Promise.resolve(undefined) as Promise<unknown> & {
							returning: () => Promise<unknown[]>;
						};
						result.returning = async () => [{ id: "m-1", ...values }];
						return result;
					},
				};
			},
		}));
		mocks.loadStorageConfig.mockReturnValue({
			provider: "r2",
			bucket: "pods",
			publicBaseUrl: null,
			accessKeyId: "k",
			secretAccessKey: "s",
			endpoint: "https://r2.example",
			region: "auto",
		});
		mocks.fetch.mockReset();
		vi.stubGlobal("fetch", mocks.fetch);
	});

	it("strips GPS EXIF from the stored object and stamps exif_stripped_at", async () => {
		mocks.findFirst.mockResolvedValue(mediaRow());
		const putBodies: Uint8Array[] = [];
		mocks.fetch.mockImplementation(
			async (url: string, init?: { method?: string; body?: Uint8Array }) => {
				if (init?.method === "PUT") {
					putBodies.push(init.body as Uint8Array);
					return okResponse();
				}
				expect(url).toBe("https://r2.example/get");
				return okResponse(gpsJpeg());
			},
		);

		await finalizeUpload({ mediaId: "m-1" });

		// The object was rewritten without the GPS Exif segment.
		expect(putBodies).toHaveLength(1);
		expect(hasBytes(putBodies[0]!, GPS_TAG_LE)).toBe(false);

		const mediaUpdate = mocks.updateCalls[0]!.values;
		expect(mediaUpdate.status).toBe("ready");
		expect(mediaUpdate.exifStripped).toBeInstanceOf(Date);
		expect(mediaUpdate.size).toBe(putBodies[0]!.byteLength);
	});

	it("does not re-upload when the image is already clean, but still stamps the timestamp", async () => {
		mocks.findFirst.mockResolvedValue(mediaRow());
		mocks.fetch.mockImplementation(async (_url: string, init?: { method?: string }) => {
			expect(init?.method).not.toBe("PUT");
			return okResponse(cleanJpeg());
		});

		await finalizeUpload({ mediaId: "m-1" });

		expect(mocks.fetch).toHaveBeenCalledTimes(1);
		const mediaUpdate = mocks.updateCalls[0]!.values;
		expect(mediaUpdate.status).toBe("ready");
		expect(mediaUpdate.exifStripped).toBeInstanceOf(Date);
	});

	it("fails closed when the object is not a parseable image", async () => {
		mocks.findFirst.mockResolvedValue(mediaRow());
		mocks.fetch.mockResolvedValue(
			okResponse(Uint8Array.from(ascii("GIF89a not an accepted format"))),
		);

		await expect(finalizeUpload({ mediaId: "m-1" })).rejects.toThrow(
			/rejected/i,
		);
		// The row is never marked ready.
		expect(mocks.updateCalls).toHaveLength(0);
	});

	it("fails when the stored object cannot be fetched", async () => {
		mocks.findFirst.mockResolvedValue(mediaRow());
		mocks.fetch.mockResolvedValue({ ok: false, status: 404 } as Response);

		await expect(finalizeUpload({ mediaId: "m-1" })).rejects.toThrow(/404/);
		expect(mocks.updateCalls).toHaveLength(0);
	});

	it("skips the strip for videos", async () => {
		mocks.findFirst.mockResolvedValue(
			mediaRow({
				type: "video",
				storageKey: "pods/p-1/videos/m-1.mp4",
				mimeType: "video/mp4",
			}),
		);

		await finalizeUpload({ mediaId: "m-1" });

		expect(mocks.fetch).not.toHaveBeenCalled();
		const mediaUpdate = mocks.updateCalls[0]!.values;
		expect(mediaUpdate.status).toBe("processing");
		expect(mediaUpdate.exifStripped).toBeUndefined();
	});
});
