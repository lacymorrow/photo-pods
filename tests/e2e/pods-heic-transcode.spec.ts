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
/**
 * A 64x64 HEVC HEIC. It decodes fine on its own; what it does is corrupt
 * libheif's asm.js heap so a *later* decode fails (LAC-5717).
 */
const TINY_FIXTURE = path.join(__dirname, "fixtures/tiny-64x64.heic");
const HEIC2ANY = path.join(__dirname, "../../node_modules/heic2any/dist/heic2any.min.js");

/** Keep these in step with `decode-heic-client.ts`. */
const JPEG_QUALITY = 0.92;

test.describe("HEVC HEIC transcode (LAC-5712)", () => {
  test.beforeEach(async ({ page }) => {
    // Any same-origin document will do; the test never touches app routes.
    await page.goto("/");
    // Record the URL heic2any builds its one worker from, exactly as
    // `decode-heic-client.ts` does, so the recovery test can rebuild it.
    await page.evaluate(() => {
      const scope = window as unknown as { __workerUrls: string[]; Worker: typeof Worker };
      scope.__workerUrls = [];
      scope.Worker = new Proxy(scope.Worker, {
        construct(target, args: [string | URL, WorkerOptions?]) {
          scope.__workerUrls.push(String(args[0]));
          return Reflect.construct(target, args);
        },
      });
    });
    await page.addScriptTag({ path: HEIC2ANY });
    await page.evaluate(
      ([main, tiny]) => {
        const decode = (b64: string) => {
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return new Blob([bytes], { type: "image/heic" });
        };
        const scope = window as unknown as { __heic: Blob; __heicTiny: Blob };
        scope.__heic = decode(main);
        scope.__heicTiny = decode(tiny);
      },
      [readFileSync(FIXTURE).toString("base64"), readFileSync(TINY_FIXTURE).toString("base64")]
    );
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

  /**
   * LAC-5717 finding 1. One decode can corrupt libheif's asm.js heap and
   * break *later* ones, and heic2any keeps a single module-global worker that
   * it creates at import and never re-creates. Before the fix the failure was
   * silent: the transcode returned null, the raw HEIC went to storage, and
   * the user got a successful upload with a tile that could never render.
   *
   * This is also the guard on the two heic2any internals the recovery code
   * reaches into. If an upgrade renames `window.__heic2any__worker` or stops
   * building the worker from a Blob URL, this test says so.
   */
  test("a corrupted decoder is rebuilt rather than left broken for the page", async ({ page }) => {
    const decode = (which: "__heic" | "__heicTiny") =>
      page.evaluate(async (key) => {
        try {
          const blob = (window as unknown as Record<string, Blob>)[key];
          const out = (await (
            window as unknown as { heic2any: (o: unknown) => Promise<Blob> }
          ).heic2any({ blob, toType: "image/jpeg", quality: 0.92 })) as Blob;
          const bitmap = await createImageBitmap(out);
          const dims = `${bitmap.width}x${bitmap.height}`;
          bitmap.close();
          return { ok: true, dims };
        } catch (e) {
          // heic2any rejects with a plain `{ code, message }`, not an Error.
          const message = (e as { message?: string })?.message;
          return { ok: false, err: typeof message === "string" ? message : String(e) };
        }
      }, which);

    const hasWorkerGlobal = await page.evaluate(
      () => !!(window as unknown as { __heic2any__worker?: Worker }).__heic2any__worker
    );
    expect(hasWorkerGlobal).toBe(true);

    expect(await decode("__heic")).toEqual({ ok: true, dims: "480x360" });
    // Succeeds on its own. The damage shows up on the next decode.
    expect(await decode("__heicTiny")).toEqual({ ok: true, dims: "64x64" });

    const poisoned = await decode("__heic");
    expect(poisoned.ok).toBe(false);
    expect(poisoned.err).toContain("ERR_LIBHEIF");

    // What `decode-heic-client.ts` does on a failed decode. Terminating
    // without rebuilding would be worse than nothing: heic2any dereferences
    // the global unguarded, so the next call would die on `postMessage` and
    // HEIC would stay broken for the life of the page.
    const rebuilt = await page.evaluate(() => {
      const scope = window as unknown as {
        __heic2any__worker?: Worker;
        __workerUrls: string[];
      };
      const url = scope.__workerUrls[0];
      if (!url?.startsWith("blob:")) return false;
      scope.__heic2any__worker?.terminate();
      scope.__heic2any__worker = new Worker(url);
      return true;
    });
    expect(rebuilt).toBe(true);

    expect(await decode("__heic")).toEqual({ ok: true, dims: "480x360" });
    expect(await decode("__heic")).toEqual({ ok: true, dims: "480x360" });
  });
});
