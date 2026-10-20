/**
 * Phase 5 e2e smoke suite. These tests catch the most common breakage
 * classes:
 *   - dev server fails to boot
 *   - top-level routes 500
 *   - auth gate is misconfigured (/settings/account not protected)
 *   - sign-in page doesn't render
 *   - a route loses its <title> / <meta name="description">
 *
 * They run against a Postgres testcontainer started in globalSetup; no
 * provider sandboxes or external services required.
 *
 * Deeper flows (real credentials sign-in, admin interactions) require
 * Payload + sandbox keys and are tracked as separate follow-ups
 * (#24-#26).
 *
 * Assert only against routes this app actually serves. `src/app/(app)/
 * [...slug]/page.tsx` is a catch-all, so a removed route still answers
 * 200 with not-found UI — which silently turns "route works" and
 * "route has SEO tags" assertions green against nothing. That is how
 * the stale /pricing checks here survived PR #37 removing the page.
 */

import { expect, test } from "@playwright/test";
import { hasCredentialsForm } from "./fixtures";

test.describe("public routes render", () => {
  test("/ — home page responds 200 and renders body", async ({ page }) => {
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    await expect(page.locator("body")).not.toBeEmpty();
  });

  test("/sign-in shows the sign-in card with email + password fields", async ({ page }) => {
    const response = await page.goto("/sign-in");
    expect(response?.status()).toBe(200);
    await expect(page.locator("body")).not.toBeEmpty();

    // The email/password form only renders when credentials auth is
    // enabled (PAYLOAD_SECRET or APP_SECRET), so only assert the form
    // when the feature is on. The claim that CI runs without it is no
    // longer true — PR #41 gave this job an APP_SECRET.
    const hasForm = await hasCredentialsForm(page);
    test.skip(
      !hasForm,
      "Credentials auth not enabled — set NEXT_PUBLIC_FEATURE_AUTH_CREDENTIALS_ENABLED"
    );

    // Whatever the heading wording is, the email and password inputs
    // are the load-bearing UI on this page.
    await expect(page.getByLabel(/email/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByLabel(/password/i)).toBeVisible();
  });

  test("/robots.txt is served", async ({ page }) => {
    const response = await page.request.get("/robots.txt");
    expect(response.status()).toBe(200);
    expect(await response.text()).toMatch(/user-agent/i);
  });
});

test.describe("auth gate", () => {
  /**
   * /settings/account is this app's redirecting gate: it calls
   * `redirect(routes.auth.signIn)` when there is no session.
   *
   * It replaced /dashboard and /deployments, which PR #37 deleted along
   * with the rest of the unused Shipkit template pages. Those two tests
   * kept asserting a redirect until PR #41 unbroke collection and the
   * job finally ran (LAC-5012).
   */
  test("/settings/account redirects an unauthenticated user to /sign-in", async ({ page }) => {
    await page.goto("/settings/account");
    await expect(page).toHaveURL(/\/sign-in/, { timeout: 15_000 });
  });

  /**
   * Deliberately not a redirect. /pods renders a sign-in call to action
   * for anonymous visitors so the landing surface stays crawlable, so
   * asserting a redirect here would be wrong, not stricter.
   */
  test("/pods renders a sign-in call to action instead of redirecting", async ({ page }) => {
    const response = await page.goto("/pods");
    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(/\/pods$/);
    // The page's own copy, not a header nav link that would be present
    // on every route and make this pass against anything.
    await expect(page.getByRole("heading", { name: /welcome to photopods/i })).toBeVisible({
      timeout: 15_000,
    });
  });
});

test.describe("SEO: title and meta description present", () => {
  // Carried over from the deleted shipkit-regression spec (LAC-1513).
  // Only `/` — the other routes that spec checked do not exist here, and
  // the catch-all made those assertions pass against not-found UI.
  test('/ has <title> and <meta name="description">', async ({ page }) => {
    await page.goto("/");

    const title = await page.title();
    expect(title, "/: <title> is empty").toBeTruthy();
    expect(title.length, "/: <title> is too short").toBeGreaterThan(3);

    const metaDescription = page.locator('meta[name="description"]');
    await expect(metaDescription, '/: missing <meta name="description">').toHaveCount(1);

    const content = await metaDescription.getAttribute("content");
    expect(content, '/: <meta name="description"> content is empty').toBeTruthy();
    expect(content?.length, '/: <meta name="description"> content is too short').toBeGreaterThan(
      10
    );
  });
});

test.describe("error contract", () => {
  test("a nonexistent route renders not-found UI (Next renders 200 by design)", async ({
    page,
  }) => {
    // Cold-compiling an unknown route + the not-found page's WebGL background
    // (rAF loop blocks `load`) can take >30s in dev.
    test.setTimeout(90_000);
    await page.goto("/this-route-truly-does-not-exist-12345", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await expect(page.locator("body")).toContainText(/not found|404|lost in space/i, {
      timeout: 30_000,
    });
  });
});
