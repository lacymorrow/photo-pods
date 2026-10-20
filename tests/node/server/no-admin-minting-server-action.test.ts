import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * After LAC-4959, `isAdmin()` has three grants and exactly one of them is live
 * in production: the `role` column on the application `users` row. The static
 * `ADMIN_EMAIL`/`ADMIN_DOMAINS` config is unset there, and the RBAC
 * `system:admin` path is unseeded (nothing writes such a permission row, and
 * `hasPermission` compares resource and action by exact equality, so a
 * wildcard row never matches).
 *
 * So `users.role = "admin"` is the admin grant. A `"use server"` module is an
 * HTTP endpoint the moment anything imports it, callable by anyone who can
 * reach the app, with whatever arguments they choose. A server action that
 * writes that value is therefore a privilege-escalation endpoint unless it
 * checks the caller first, and a static check cannot tell a real
 * authorization check from a convincing-looking one.
 *
 * This pins the stricter line instead: no server action writes the admin role
 * at all. `src/server/actions/setup/configure-setup.ts` did — unauthenticated,
 * with a caller-chosen email and password, plus `emailVerified` set, which
 * also satisfied grant 1. It was dead code, unreferenced and absent from the
 * server-reference manifest, but one `import` from a setup page away from
 * being live anonymous admin. It is deleted (LAC-5017).
 *
 * If a setup wizard or an admin-management screen is ever wanted, granting
 * admin belongs behind an `isAdmin()` check in a service, with a
 * refuse-if-an-admin-already-exists guard and a test pinning that an anonymous
 * caller is refused. Then narrow this test to that one path by name rather
 * than deleting it.
 */
const SRC_DIR = join(process.cwd(), "src");
const SKIP_DIRS = new Set(["node_modules", ".next", "__snapshots__"]);

/** Leading `"use server"` directive, single or double quoted, file or function scope. */
const USE_SERVER = /^\s*["']use server["']\s*;?\s*$/m;

/**
 * Writes `role: "admin"` as an object property, which is how a Drizzle
 * `insert`/`update` on the `users` table names the column.
 */
const MINTS_ADMIN_ROLE = /\brole\s*:\s*["'`]admin["'`]/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const serverActionModules = walk(SRC_DIR).filter((file) =>
  USE_SERVER.test(readFileSync(file, "utf8"))
);

describe("no server action mints the admin role (LAC-5017)", () => {
  it("finds the server action modules (sanity)", () => {
    // Without this the suite would pass by matching nothing at all, which is
    // how a renamed or moved directory turns a guard into a no-op.
    expect(serverActionModules.length).toBeGreaterThan(10);
  });

  it('none of them write role: "admin"', () => {
    const offenders = serverActionModules
      .filter((file) => MINTS_ADMIN_ROLE.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC_DIR, file));

    expect(offenders).toEqual([]);
  });
});
