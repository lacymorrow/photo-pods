/**
 * The property the unit tests cannot assert: an HEVC-coded .heic really does
 * decode in a real browser engine (LAC-5712).
 *
 * The fixture is a genuine HEVC HEIC written by macOS `sips` — the same
 * coding an iPhone produces, `ftypheic` and all. Two facts make this the
 * right guard to keep:
 *
 * - A Chromium `<img>` pointed at those bytes reports `naturalWidth === 0`,
 *   which is why the grid and lightbox showed broken images for every HEIC
 *   upload. The first test pins it, so the reason this code exists stays
 *   visible and the fixture is proved to still be natively undecodable.
 * - This build's sharp cannot read it either: it reports
 *   `format: "heif", compression: "hevc"` from the header and then fails
 *   with "Support for this compression format has not been built in". There
 *   is no server-side fallback behind the browser transcode.
 *
 * Self-contained on purpose — no sign-in, no pod, no storage. It drives
 * heic2any directly, because that library is the only uncertain part of the
 * path; the ~12 lines of app glue around it are covered by
 * `tests/unit/lib/pods/decode-heic-client.test.ts`. The jsdom unit suite
 * cannot host this: libheif needs a real canvas and a real wasm/asm.js
 * runtime. The Vitest browser suite cannot either — `vitest.config.browser.ts`
 * still uses the Vitest 3 string `provider`, which Vitest 4 rejected, and
 * reviving it needs a dependency this fix does not otherwise want.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures/iphone-hevc-480x360.heic");
const HEIC2ANY = path.join(__dirname, "../../node_modules/heic2any/dist/heic2any.min.js");

/** Keep these in step with `decode-heic-client.ts`. */
const JPEG_QUALITY = 0.92;

test.describe("HEVC HEIC transcode (LAC-5712)", () => {
  test.beforeEach(async ({ page }) => {
    // Any same-origin document will do; the test never touches app routes.
    await page.goto("/");
    await page.addScriptTag({ path: HEIC2ANY });
    await page.evaluate((b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      (window as unknown as { __heic: Blob }).__heic = new Blob([bytes], {
        type: "image/heic",
      });
    }, readFileSync(FIXTURE).toString("base64"));
  });

  test("the browser cannot display the fixture on its own", async ({ page }) => {
    const natural = await page.evaluate(() => {
      const blob = (window as unknown as { __heic: Blob }).__heic;
      return new Promise<number | null>((resolve) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => resolve(img.naturalWidth);
        img.onerror = () => resolve(null);
        img.src = url;
      });
    });

    // Either an outright load error or a zero-width decode; both mean the
    // same thing to a user, which is a broken image.
    expect(natural === null || natural === 0).toBe(true);
  });

  test("transcodes to a JPEG the browser does display, at the right size", async ({ page }) => {
    const result = await page.evaluate(async (quality) => {
      const blob = (window as unknown as { __heic: Blob }).__heic;
      const out = (await (
        window as unknown as { heic2any: (o: unknown) => Promise<Blob> }
      ).heic2any({ blob, toType: "image/jpeg", quality })) as Blob;

      const dims = await new Promise<{ w: number; h: number } | null>((resolve) => {
        const url = URL.createObjectURL(out);
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => resolve(null);
        img.src = url;
      });

      const bytes = new Uint8Array(await out.arrayBuffer());
      const has = (needle: string) => {
        const n = [...needle].map((c) => c.charCodeAt(0));
        outer: for (let i = 0; i <= bytes.length - n.length; i++) {
          for (let j = 0; j < n.length; j++) if (bytes[i + j] !== n[j]) continue outer;
          return true;
        }
        return false;
      };

      return {
        type: out.type,
        dims,
        // JPEG SOI.
        isJpeg: bytes[0] === 0xff && bytes[1] === 0xd8,
        hasExif: has("Exif\u0000\u0000"),
        hasXmp: has("http://ns.adobe.com/xap/1.0/"),
        hasIptc: has("Photoshop 3.0"),
      };
    }, JPEG_QUALITY);

    expect(result.type).toBe("image/jpeg");
    expect(result.isJpeg).toBe(true);
    // Source is 480x360. Equal dimensions out means libheif applied the HEIF
    // `irot` box rather than leaving the photo sideways.
    expect(result.dims).toEqual({ w: 480, h: 360 });

    // The source HEIC carries EXIF; libheif renders to pixels and heic2any
    // re-encodes from those, so none of it is copied forward. This is what
    // lets `stripExifClientSide` return the transcode directly and still
    // honour the LAC-3174 strip.
    expect(result.hasExif).toBe(false);
    expect(result.hasXmp).toBe(false);
    expect(result.hasIptc).toBe(false);
  });
});
