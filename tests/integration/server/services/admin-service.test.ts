/**
 * Characterization tests for admin-service.isAdmin() against the live
 * Testcontainers DB.
 *
 * isAdmin() has 3 layered grants (any one → true):
 *   1. adminConfig.isAdminByEmailConfig — static env-driven list/domain,
 *      AND the address must belong to an account with a verified email
 *   2. DB `users.role === "admin"` lookup by lowercased email
 *   3. RBAC permission check ("system", "admin") for the resolved userId
 *
 * Check #1 is the only one that is not satisfiable on its own. The static
 * config used to be consulted before any DB lookup, so presenting a matching
 * address was enough — that was the P0-2c hole closed by upstream shipkit
 * 02e5f898 (LAC-3811). A config match now has to be backed by a real account
 * with a verified email, so the three cases below are pinned explicitly.
 *
 * A fourth grant used to follow those: an email present in the Payload CMS
 * `users` collection was an admin, with no role check. It is gone (LAC-4959),
 * and the Payload block at the bottom of this file pins its absence — the
 * stub hands back a matching document and still has to be refused.
 */

import { describe, expect, it, vi } from "vitest";
import { adminConfig } from "@/config/admin-config";
import { getPayloadClient } from "@/lib/payload/payload";
import { users } from "@/server/db/schema";
import { isAdmin } from "@/server/services/admin-service";
import { getTestDb } from "../../../helpers/test-db";

/**
 * Returns a document for every query, the way Payload does for an email that
 * signed up. Nothing in `isAdmin` may read it.
 */
const payloadFind = vi.fn(async () => ({
  docs: [{ id: "payload-doc-1", email: "payload-only@shipkit.test" }],
  totalDocs: 1,
}));

vi.mock("@/lib/payload/payload", () => ({
  getPayloadClient: vi.fn(async () => ({ find: payloadFind })),
}));

vi.mock("@/server/services/rbac", () => ({
  rbacService: {
    hasPermission: vi.fn(async () => false),
  },
}));

describe("isAdmin", () => {
  it("returns false when email is null", async () => {
    expect(await isAdmin({ email: null })).toBe(false);
  });

  it("returns false when email is undefined", async () => {
    expect(await isAdmin({})).toBe(false);
  });

  it("returns false when email is not a string", async () => {
    expect(await isAdmin({ email: 12345 as never })).toBe(false);
  });

  it("returns false when the static admin email list matches but no account exists", async () => {
    const spy = vi.spyOn(adminConfig, "isAdminByEmailConfig").mockReturnValue(true);
    try {
      expect(await isAdmin({ email: "anything@example.com" })).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("returns false when the static admin email list matches an unverified account", async () => {
    const spy = vi.spyOn(adminConfig, "isAdminByEmailConfig").mockReturnValue(true);
    try {
      const db = getTestDb();
      await db.insert(users).values({
        id: "config-unverified",
        email: "unverified@config.shipkit.test",
        role: "user",
        // `emailVerified` defaults to CURRENT_TIMESTAMP, so null is explicit.
        emailVerified: null,
      });

      expect(await isAdmin({ email: "unverified@config.shipkit.test" })).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("returns true when the static admin email list matches a verified account", async () => {
    const spy = vi.spyOn(adminConfig, "isAdminByEmailConfig").mockReturnValue(true);
    try {
      const db = getTestDb();
      await db.insert(users).values({
        id: "config-verified",
        email: "verified@config.shipkit.test",
        role: "user",
        emailVerified: new Date(),
      });

      // Mixed case on the way in; the service lowercases before the lookup.
      expect(await isAdmin({ email: "Verified@Config.Shipkit.Test" })).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("returns true when the DB users row has role='admin' (lowercased email)", async () => {
    vi.spyOn(adminConfig, "isAdminByEmailConfig").mockReturnValue(false);

    const db = getTestDb();
    await db.insert(users).values({
      id: "admin-user-1",
      email: "admin@db.shipkit.test",
      role: "admin",
    });

    // Calls with mixed-case email; service must lowercase before lookup.
    expect(await isAdmin({ email: "Admin@DB.Shipkit.Test" })).toBe(true);
  });

  it("returns false when the user exists but role is not 'admin' and no other check passes", async () => {
    vi.spyOn(adminConfig, "isAdminByEmailConfig").mockReturnValue(false);

    const db = getTestDb();
    await db.insert(users).values({
      id: "regular-user",
      email: "regular@db.shipkit.test",
      role: "user",
    });

    expect(await isAdmin({ email: "regular@db.shipkit.test" })).toBe(false);
  });

  it("returns false when the email matches no row at all", async () => {
    vi.spyOn(adminConfig, "isAdminByEmailConfig").mockReturnValue(false);
    expect(await isAdmin({ email: "nobody@shipkit.test" })).toBe(false);
  });

  it("returns true when RBAC grants ('system','admin') even if DB role is non-admin", async () => {
    vi.spyOn(adminConfig, "isAdminByEmailConfig").mockReturnValue(false);
    const { rbacService } = await import("@/server/services/rbac");
    vi.mocked(rbacService.hasPermission).mockResolvedValueOnce(true);

    const db = getTestDb();
    await db.insert(users).values({
      id: "rbac-user",
      email: "rbac@shipkit.test",
      role: "user",
    });

    expect(await isAdmin({ email: "rbac@shipkit.test" })).toBe(true);
  });

  it("uses an explicitly-passed userId for the RBAC check when no DB user exists", async () => {
    vi.spyOn(adminConfig, "isAdminByEmailConfig").mockReturnValue(false);
    const { rbacService } = await import("@/server/services/rbac");
    vi.mocked(rbacService.hasPermission).mockResolvedValueOnce(true);

    expect(await isAdmin({ email: "no-row@shipkit.test", userId: "explicit-id" })).toBe(true);
    expect(rbacService.hasPermission).toHaveBeenCalledWith("explicit-id", "system", "admin");
  });

  describe("Payload CMS membership (LAC-4959)", () => {
    it("returns false for an email that exists in the Payload users collection", async () => {
      vi.spyOn(adminConfig, "isAdminByEmailConfig").mockReturnValue(false);

      // No row in the app `users` table and no RBAC grant: the only thing
      // this email has is a Payload document, which the stub always returns.
      expect(await isAdmin({ email: "payload-only@shipkit.test" })).toBe(false);
    });

    it("returns false for a Payload member who also has a non-admin app row", async () => {
      vi.spyOn(adminConfig, "isAdminByEmailConfig").mockReturnValue(false);

      const db = getTestDb();
      await db.insert(users).values({
        id: "payload-member",
        email: "payload-member@shipkit.test",
        role: "user",
        emailVerified: new Date(),
      });

      expect(await isAdmin({ email: "payload-member@shipkit.test" })).toBe(false);
    });

    it("never consults Payload at all", async () => {
      vi.spyOn(adminConfig, "isAdminByEmailConfig").mockReturnValue(false);
      vi.mocked(getPayloadClient).mockClear();
      payloadFind.mockClear();

      await isAdmin({ email: "payload-only@shipkit.test" });

      // A grant that is never read cannot be forged by writing to the
      // collection, which `signUpWithCredentials` lets any visitor do.
      expect(getPayloadClient).not.toHaveBeenCalled();
      expect(payloadFind).not.toHaveBeenCalled();
    });
  });
});
