import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PhotoUpload } from "@/components/pods/photo-upload";
import { uploadPodPhoto } from "@/lib/pods/upload-media-client";

vi.mock("@/lib/pods/upload-media-client", () => ({
	uploadPodPhoto: vi.fn(async () => undefined),
}));

const uploadMock = vi.mocked(uploadPodPhoto);

// next/image needs the Next runtime for loaders; a plain <img> preserves the
// src/alt contract the tests assert on.
vi.mock("next/image", () => ({
	default: ({ src, alt, fill: _fill, ...rest }: any) => (
		// biome-ignore lint/performance/noImgElement: test shim
		<img src={src} alt={alt} {...rest} />
	),
}));

const jpeg = (name = "photo.jpg") => new File(["x"], name, { type: "image/jpeg" });
const heic = (name = "IMG_0001.heic", type = "image/heic") =>
	new File(["x"], name, { type });

/** The hidden gallery input (the one accepting HEIC), not the camera input. */
const galleryInput = () =>
	document.querySelector<HTMLInputElement>('input[accept*="heic"]');

const selectFiles = (files: File[]) => {
	const input = galleryInput();
	if (!input) throw new Error("gallery file input not found");
	fireEvent.change(input, { target: { files } });
};

describe("PhotoUpload (LAC-2915)", () => {
	beforeEach(() => {
		let n = 0;
		URL.createObjectURL = vi.fn(() => `blob:mock-${++n}`);
		URL.revokeObjectURL = vi.fn();
		uploadMock.mockReset();
		uploadMock.mockResolvedValue(undefined);
	});

	describe("HEIC previews", () => {
		it("renders an object-URL image preview for browser-decodable files", () => {
			render(<PhotoUpload podId="pod-1" />);
			selectFiles([jpeg()]);

			const img = screen.getByAltText("Preview 1");
			expect(img).toHaveAttribute("src", "blob:mock-1");
		});

		it("shows a filename fallback instead of a broken <img> for HEIC files", () => {
			render(<PhotoUpload podId="pod-1" />);
			selectFiles([heic()]);

			expect(screen.queryByRole("img")).not.toBeInTheDocument();
			expect(screen.getByText("IMG_0001.heic")).toBeInTheDocument();
			// No object URL is minted for a file the browser can't decode.
			expect(URL.createObjectURL).not.toHaveBeenCalled();
		});

		it("still stages HEIC files whose MIME type the browser reports as empty", () => {
			render(<PhotoUpload podId="pod-1" />);
			selectFiles([heic("IMG_0002.heic", "")]);

			expect(screen.getByText("IMG_0002.heic")).toBeInTheDocument();
			expect(screen.getByRole("button", { name: /upload 1 photo/i })).toBeInTheDocument();
		});

		it("mixes HEIC fallbacks and real previews in one batch", () => {
			render(<PhotoUpload podId="pod-1" />);
			selectFiles([jpeg(), heic()]);

			expect(screen.getByAltText("Preview 1")).toBeInTheDocument();
			expect(screen.getByText("IMG_0001.heic")).toBeInTheDocument();
			expect(screen.getByRole("button", { name: /upload 2 photos/i })).toBeInTheDocument();
		});

		it("only revokes object URLs that were created", () => {
			render(<PhotoUpload podId="pod-1" />);
			selectFiles([heic()]);

			fireEvent.click(screen.getByRole("button", { name: "Remove IMG_0001.heic" }));
			expect(URL.revokeObjectURL).not.toHaveBeenCalled();
		});
	});

	describe("dropzone keyboard access (WCAG 2.1.1)", () => {
		it("is a focusable button that opens the file picker via Enter and Space", () => {
			render(<PhotoUpload podId="pod-1" />);
			const dropzone = screen.getByRole("button", { name: "Add photos" });
			expect(dropzone).toHaveAttribute("tabindex", "0");

			const input = galleryInput();
			if (!input) throw new Error("gallery file input not found");
			const click = vi.spyOn(input, "click").mockImplementation(() => {});

			fireEvent.keyDown(dropzone, { key: "Enter" });
			expect(click).toHaveBeenCalledTimes(1);
			fireEvent.keyDown(dropzone, { key: " " });
			expect(click).toHaveBeenCalledTimes(2);
		});
	});

	describe("presigned upload flow (LAC-2912)", () => {
		it("uploads each staged file via the presigned client flow and clears the tray", async () => {
			render(<PhotoUpload podId="pod-1" />);
			const one = jpeg("one.jpg");
			const two = jpeg("two.jpg");
			selectFiles([one, two]);

			fireEvent.click(screen.getByRole("button", { name: /upload 2 photos/i }));

			await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(2));
			expect(uploadMock).toHaveBeenNthCalledWith(1, "pod-1", one);
			expect(uploadMock).toHaveBeenNthCalledWith(2, "pod-1", two);
			await waitFor(() =>
				expect(screen.queryByAltText("Preview 1")).not.toBeInTheDocument(),
			);
		});

		it("keeps failed files in the tray and surfaces the error for retry", async () => {
			uploadMock
				.mockRejectedValueOnce(new Error("Storage upload failed (HTTP 403)"))
				.mockResolvedValueOnce(undefined);
			render(<PhotoUpload podId="pod-1" />);
			selectFiles([jpeg("bad.jpg"), jpeg("good.jpg")]);

			fireEvent.click(screen.getByRole("button", { name: /upload 2 photos/i }));

			const alert = await screen.findByRole("alert");
			expect(alert).toHaveTextContent("Storage upload failed (HTTP 403)");
			// Only the failed file remains staged, so a retry re-sends just it.
			expect(
				screen.getByRole("button", { name: /upload 1 photo/i }),
			).toBeInTheDocument();

			uploadMock.mockResolvedValueOnce(undefined);
			fireEvent.click(screen.getByRole("button", { name: /upload 1 photo/i }));
			await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(3));
			await waitFor(() =>
				expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
			);
		});
	});
});
