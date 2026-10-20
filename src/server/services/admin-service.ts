import { eq } from "drizzle-orm";
import { adminConfig } from "@/config/admin-config";
import { logger } from "@/lib/logger";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import { rbacService } from "@/server/services/rbac";

/**
 * Admin service for server-side admin checking
 * This service is the single source of truth for admin status
 */

/**
 * Check if a user is an admin based on:
 * 1. Email configuration (`ADMIN_EMAIL` / `ADMIN_DOMAINS`), backed by a real
 *    account with a verified email
 * 2. The `role` column on the application `users` row
 * 3. An RBAC `system:admin` permission
 *
 * Each of those is a grant somebody made on purpose. A fourth check used to
 * return true for any email present in the Payload CMS `users` collection;
 * the note at the end of the function records why it is gone (LAC-4959).
 *
 * @param email The email address to check
 * @param userId Optional user ID for RBAC check
 * @returns Boolean indicating if the user is an admin
 */
export async function isAdmin({
  email,
  userId,
}: {
  email?: string | null;
  userId?: string;
}): Promise<boolean> {
  if (typeof email !== "string") {
    return false;
  }

  // Load the account first. The config check below used to run against the raw
  // email string alone, which meant anyone who could present a matching address
  // was an admin, whether or not they had ever proved they owned it.
  const user = await db?.query.users.findFirst({
    where: eq(users.email, email.toLowerCase()),
    columns: {
      role: true,
      id: true,
      emailVerified: true,
    },
  });

  // 1. Static configuration, but only for a real account with a verified email.
  if (adminConfig.isAdminByEmailConfig(email)) {
    if (user?.emailVerified) {
      return true;
    }
    logger.warn("Admin config matched an email with no verified account; refusing admin", {
      email,
    });
  }

  // 2. Explicit role on the account.
  if (user?.role === "admin") {
    return true;
  }

  // 3. Check RBAC permissions if userId is provided or we found it in the database
  const userIdToCheck = userId ?? user?.id;
  if (userIdToCheck) {
    try {
      const hasRbacPermission = await rbacService.hasPermission(userIdToCheck, "system", "admin");

      if (hasRbacPermission) {
        return true;
      }
    } catch (error) {
      console.error("Error checking RBAC admin permission:", error);
    }
  }

  // There is deliberately no Payload CMS check here (LAC-4959).
  //
  // This function used to end with a fourth grant: look the email up in the
  // Payload `users` collection, and if a document came back, return true. Its
  // comment asserted that "existence in Payload users collection with valid
  // authentication implies admin panel access". Membership in that collection
  // is not a grant anybody makes on purpose:
  //
  //   - `src/lib/payload/collections/Users.ts` declares no fields beyond the
  //     default email/auth pair. No role, no admin-access flag. There was
  //     nothing on the document to check even if we had wanted to check it.
  //   - `AuthService.signUpWithCredentials` writes that collection with a
  //     caller-chosen email from `signUpWithCredentialsAction`, an anonymous
  //     `"use server"` action behind the live `/sign-up` password form. Sign
  //     up, and this returned true for you.
  //   - Photopods does mount the Payload panel at `/cms` and its REST and
  //     GraphQL APIs under `/cms-api`, so panel access is a real thing here.
  //     It still is not Photopods admin, which is what this function answers
  //     for `/admin/*` and the moderation queue.
  //
  // Nor was the branch dead in production: `PAYLOAD` is on whenever
  // `PAYLOAD_SECRET` or `APP_SECRET` is set (`src/config/features-table.ts`),
  // and production sets `APP_SECRET`, so `getPayloadClient()` never
  // short-circuited on the flag there. What kept the grant unreachable on the
  // day it was removed was that production's database was down: the Supabase
  // tenant answered `tenant/user not found`, `PAYLOAD` also
  // `requires: ["DATABASE"]`, and `/cms-api/users` returned 500 "There was an
  // error initializing Payload". The old `catch` swallowed that into a false.
  // That is an outage, not a control — the same outage fail-closes the three
  // grants above, which all need the `users` lookup. Whenever production's
  // database was healthy, this grant was live.
  //
  // Grant admin with `ADMIN_EMAIL`/`ADMIN_DOMAINS` or `users.role`. The RBAC
  // path above is reachable but unseeded: nothing in the repo writes a
  // `system`/`admin` permission row, and `hasPermission` compares resource and
  // action by exact equality, so the `"*"` rows `configureSetup` would write
  // never match (verified in review, LAC-5016).

  return false;
}

/**
 * Get the list of admin emails
 * Should only be called after verifying the requester is an admin
 *
 * @param requestingEmail The email of the user requesting the admin list
 * @returns Array of admin emails if requester is admin, empty array otherwise
 */
export async function getAdminEmails(requestingEmail?: string | null): Promise<string[]> {
  if (!(await isAdmin({ email: requestingEmail }))) {
    return [];
  }

  return adminConfig.emails;
}

/**
 * Get the list of admin domains
 * Should only be called after verifying the requester is an admin
 *
 * @param requestingEmail The email of the user requesting the admin domains
 * @returns Array of admin domains if requester is admin, empty array otherwise
 */
export async function getAdminDomains(requestingEmail?: string | null): Promise<string[]> {
  const userIsAdmin = await isAdmin({ email: requestingEmail });
  if (userIsAdmin) {
    return adminConfig.domains;
  }
  return [];
}
