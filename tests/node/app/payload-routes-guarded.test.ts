import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Payload's codegen writes `/cms` and `/cms-api/*` as unconditional static
 * imports of `@payload-config` and `@payloadcms/next`. That is wrong for this
 * project, because Payload is a feature flag here:
 *
 * 1. With Payload disabled the generated entrypoints still boot the CMS on
 *    request and answer 500 rather than 404. That is how LAC-5015 shipped:
 *    production served 500s from `/cms` and `/cms-api/users` for months.
 * 2. `withPayloadConfig` (`src/config/nextjs/with-payload.ts`) only applies
 *    `withPayload` when the flag is on, so a disabled build keeps the
 *    externalised `@payloadcms/*` packages in the bundle without the Next
 *    config that makes them loadable. `(cms)/layout.tsx` already documents
 *    that this is what blows up on Vercel at runtime.
 *
 * So every Next file-convention module under `(cms)` keeps nothing but a flag
 * guard and reaches its generated body through a dynamic `import()`. The
 * bodies live in sibling `payload-*` modules, which are free to import
 * whatever they like because nothing loads them until the flag is on.
 *
 * Re-running Payload's codegen will overwrite the guards. If this test fails
 * after a regeneration, move the generated body into the sibling
 * `payload-*` module again rather than deleting the assertion.
 */
const CMS_DIR = join(process.cwd(), "src", "app", "(cms)");

/**
 * Filenames Next.js loads as part of a route. Anything else under `(cms)` is a
 * plain module that only runs when something imports it.
 */
const ROUTE_CONVENTIONS = new Set([
  "page",
  "layout",
  "route",
  "not-found",
  "template",
  "default",
  "loading",
  "error",
  "global-error",
]);

const isConventionFile = (file: string) => {
  const stem = /^(.+)\.(tsx?|jsx?)$/.exec(basename(file))?.[1];
  return stem !== undefined && ROUTE_CONVENTIONS.has(stem);
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * A static `import ... from "@payloadcms/..."` or `"@payload-config"`, i.e. one
 * the bundler must resolve eagerly. A dynamic `await import("./payload-rest")`
 * is on one line as a call expression and never matches, which is the whole
 * point of the distinction.
 */
const STATIC_PAYLOAD_IMPORT = /^\s*import\s[^;]*?["'](@payload-config|@payloadcms\/[^"']*)["']/m;

const conventionFiles = walk(CMS_DIR).filter(isConventionFile);

describe("Payload route entrypoints stay behind the feature flag", () => {
  it("finds the (cms) route entrypoints (sanity)", () => {
    // /cms page + its not-found, three /cms-api routes, and the group layout.
    expect(conventionFiles.length).toBeGreaterThanOrEqual(6);
  });

  it.each(conventionFiles.map((file) => [relative(CMS_DIR, file), file]))(
    "%s does not statically import Payload",
    (_label, file) => {
      const source = readFileSync(file, "utf8");
      const offender = STATIC_PAYLOAD_IMPORT.exec(source);
      expect(
        offender?.[1] ?? null,
        `${relative(CMS_DIR, file)} statically imports ${offender?.[1]}. Move the generated body into a sibling payload-* module and load it with a dynamic import behind NEXT_PUBLIC_FEATURE_PAYLOAD_ENABLED.`
      ).toBeNull();
    }
  );

  // Only the entrypoints that actually front a Payload body need the guard.
  // `(cms)/not-found.tsx` is a plain app 404 and has nothing to gate.
  const guardedFiles = conventionFiles.filter((file) =>
    /import\(\s*["']\.\/payload-/.test(readFileSync(file, "utf8"))
  );

  it("finds the entrypoints that front a Payload body (sanity)", () => {
    expect(guardedFiles.length).toBeGreaterThanOrEqual(6);
  });

  it.each(guardedFiles.map((file) => [relative(CMS_DIR, file), file]))(
    "%s gates its dynamic Payload import on the feature flag",
    (_label, file) => {
      const source = readFileSync(file, "utf8");

      // Two legitimate guard shapes. Pages and layouts read the flag inline,
      // because they answer with `notFound()` or a React element. Route
      // handlers delegate to `payloadRoute`, which reads the same flag and
      // owns the 404 Response.
      const guarded =
        source.includes("NEXT_PUBLIC_FEATURE_PAYLOAD_ENABLED") || source.includes("payloadRoute");

      expect(
        guarded,
        `${relative(CMS_DIR, file)} loads Payload without checking NEXT_PUBLIC_FEATURE_PAYLOAD_ENABLED, directly or via payloadRoute.`
      ).toBe(true);
    }
  );

  it.each(guardedFiles.map((file) => [relative(CMS_DIR, file), file]))(
    "%s still has a real Payload body behind the guard",
    (_label, file) => {
      // A guard that 404s because the handler was deleted would pass every
      // assertion above while quietly removing the CMS. Follow each dynamic
      // import and check the body is still there, and still the real thing.
      const specifiers = [
        ...readFileSync(file, "utf8").matchAll(/import\(\s*["'](\.\/payload-[^"']+)["']\s*\)/g),
      ].flatMap((match) => match[1] ?? []);

      expect(specifiers.length).toBeGreaterThan(0);

      for (const specifier of specifiers) {
        const base = join(dirname(file), specifier.replace(/\.js$/, ""));
        const resolved = [".ts", ".tsx", ".js", ".jsx"]
          .map((ext) => `${base}${ext}`)
          .find((candidate) => existsSync(candidate));

        expect(
          resolved ? readFileSync(resolved, "utf8") : null,
          `${specifier}, imported by ${relative(CMS_DIR, file)}, is missing or is no longer the real Payload body`
        ).toMatch(STATIC_PAYLOAD_IMPORT);
      }
    }
  );
});
