import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PhotoGrid } from "@/components/pods/photo-grid";
import { mediaRouteUrl } from "@/server/services/pod-storage";

// `tests/setup.ts` stubs next/image to render nothing, which is fine for most
// component tests but would erase the very attribute under test here.
vi.unmock("next/image");

vi.mock("@/server/actions/pods", () => ({
  deletePhoto: vi.fn(),
  reactToMedia: vi.fn(),
  updatePhotoCaption: vi.fn(),
}));

/**
 * The regression this guards (LAC-5698): with `unoptimized` set, `next/image`
 * emits a bare src and the browser downloads the original — a 25-photo private
 * pod pulled 100 MB+. The custom loader has to put real widths in the srcset
 * so the browser picks a small render instead.
 */
describe("PhotoGrid srcset for ACL'd media (LAC-5698)", () => {
  const photo = (id: string, url: string) => ({
    id,
    url,
    thumbnailUrl: null,
    caption: null,
    createdAt: new Date("2026-01-01"),
    uploadedById: "u-1",
  });

  it("asks the media route for widths instead of the original", () => {
    render(
      <PhotoGrid
        photos={[photo("m-1", mediaRouteUrl("m-1"))]}
        canDelete={false}
        currentUserId="u-1"
      />
    );

    const img = screen.getByAltText("Photo");
    const srcSet = img.getAttribute("srcset") ?? "";

    expect(srcSet).not.toBe("");
    // Every candidate goes through the membership-checked route, carrying a
    // width — never the raw object URL and never an unsized src.
    for (const candidate of srcSet.split(",").map((s) => s.trim())) {
      expect(candidate).toMatch(/^\/api\/pods\/media\/m-1\?w=\d+ \d+w$/);
    }
    // The widths a phone actually picks from this grid's `sizes` hint.
    expect(srcSet).toContain("/api/pods/media/m-1?w=640 640w");
    expect(img.getAttribute("src")).toMatch(/^\/api\/pods\/media\/m-1\?w=\d+$/);
  });

  it("leaves a public pod's CDN url on the normal optimizer", () => {
    render(
      <PhotoGrid
        photos={[photo("m-2", "https://cdn.photopods.app/pods/p-1/a.jpg")]}
        canDelete={false}
        currentUserId="u-1"
      />
    );

    const img = screen.getByAltText("Photo");
    expect(img.getAttribute("srcset")).toContain("/_next/image?url=");
  });
});
