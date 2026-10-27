import { describe, expect, it } from "vitest";

import { extensionFor } from "@/lib/pods/media-extension";

describe("extensionFor", () => {
  it("prefers the content type", () => {
    expect(extensionFor("image/png", "/api/pods/media/m-1")).toBe("png");
    expect(extensionFor("image/jpeg", "/api/pods/media/m-1")).toBe("jpg");
    expect(extensionFor("image/webp", "/api/pods/media/m-1")).toBe("webp");
    expect(extensionFor("image/heic", "/api/pods/media/m-1")).toBe("heic");
  });

  it("tolerates content-type parameters and casing", () => {
    expect(extensionFor("Image/PNG; charset=binary", "/api/pods/media/m-1")).toBe("png");
  });

  /**
   * The regression this guards: the old `url.split(".").pop()` returned the
   * entire path for an extensionless media-route URL, producing filenames like
   * `photo-001./api/pods/media/m-1` (LAC-3173).
   */
  it("never returns a path segment for an extensionless media route url", () => {
    const ext = extensionFor(null, "/api/pods/media/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0");
    expect(ext).toBe("jpg");
    expect(ext).not.toContain("/");
  });

  it("falls back to the url extension for direct object urls", () => {
    expect(
      extensionFor(
        "application/octet-stream",
        "https://store.public.blob.vercel-storage.com/pods/p-1/1700000000-a.webp"
      )
    ).toBe("webp");
  });

  it("ignores a query string when reading the url extension", () => {
    expect(extensionFor("", "https://cdn.example.com/a/b.png?X-Amz-Signature=abc")).toBe("png");
  });

  it("ignores dots in earlier path segments", () => {
    expect(extensionFor("", "https://cdn.example.com/v1.2/photo")).toBe("jpg");
  });

  it("defaults to jpg for an unusable extension", () => {
    expect(extensionFor("", "https://cdn.example.com/a/b.somethinglong")).toBe("jpg");
    expect(extensionFor(undefined, "https://cdn.example.com/a/b")).toBe("jpg");
  });
});
