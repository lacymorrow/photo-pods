/**
 * QA test-infra Playwright fixtures for the LAC-2860 Photopods pass (LAC-3138).
 *
 * Provides:
 *   - `qaFixture` manifest reader (seeded users + pods; see scripts/seed-qa-fixtures.ts)
 *   - `signInAs(page, "A" | "B")` credentials helper
 *   - `applyVercelBypass(context)` — injects VERCEL_AUTOMATION_BYPASS_SECRET
 *     as a request header on every request so preview URLs served behind
 *     Vercel SSO respond 200 instead of 401. Complements LAC-2916.
 *   - `throttle4G(page)` — Chromium CDP network throttle matching spec
 *     §Performance P4 (Regular 4G: 12 Mbps down, 3 Mbps up, 70ms RTT).
 *   - Extended `test` and `expect` that automatically apply the SSO bypass
 *     header when VERCEL_AUTOMATION_BYPASS_SECRET is set.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MANIFEST_PATH =
	process.env.E2E_FIXTURE_MANIFEST ?? path.join(__dirname, "fixtures/qa.json");

export interface QAManifest {
	seededAt: string;
	users: { A: { id: string; email: string }; B: { id: string; email: string } };
	pods: {
		privateOwnedByA: { id: string; name: string; visibility: string; ownerEmail: string };
		publicOwnedByA: { id: string; name: string; visibility: string; ownerEmail: string };
		privateOwnedByB: { id: string; name: string; visibility: string; ownerEmail: string };
	};
}

export function loadManifest(): QAManifest | null {
	try {
		return JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) as QAManifest;
	} catch {
		return null;
	}
}

export function requireManifest(): QAManifest {
	const m = loadManifest();
	if (!m) {
		throw new Error(
			`QA manifest not found at ${MANIFEST_PATH}. ` +
				"Run `bun run scripts/seed-qa-fixtures.ts` against the target DB first.",
		);
	}
	return m;
}

export function passwordFor(role: "A" | "B"): string {
	const key = role === "A" ? "E2E_USER_A_PASSWORD" : "E2E_USER_B_PASSWORD";
	const value = process.env[key];
	if (!value) {
		throw new Error(`${key} is not set. Playwright cannot sign in as user ${role}.`);
	}
	return value;
}

/**
 * Vercel Automation Bypass — the header the SSO-protected preview honors.
 * Doc: https://vercel.com/docs/security/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation
 */
const VERCEL_BYPASS_HEADER = "x-vercel-protection-bypass";
const VERCEL_BYPASS_SET_COOKIE_HEADER = "x-vercel-set-bypass-cookie";

export function vercelBypassHeaders(): Record<string, string> {
	const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
	if (!secret) return {};
	return {
		[VERCEL_BYPASS_HEADER]: secret,
		// Ask Vercel to persist the bypass as a same-site cookie so client-side
		// navigations don't need to re-send the header on every hop.
		[VERCEL_BYPASS_SET_COOKIE_HEADER]: "samesitenone",
	};
}

export async function applyVercelBypass(context: BrowserContext): Promise<void> {
	const headers = vercelBypassHeaders();
	if (Object.keys(headers).length === 0) return;
	await context.setExtraHTTPHeaders(headers);
}

/**
 * Applies the "Regular 4G" throttle profile via the Chromium DevTools
 * Protocol. Matches Chrome DevTools' documented values and the LAC-2854
 * Performance §P4 target (page loads must remain under budget on 4G).
 *
 * Only works on Chromium-based projects; a no-op elsewhere.
 */
export async function throttle4G(page: Page): Promise<void> {
	if (page.context().browser()?.browserType().name() !== "chromium") return;
	const client = await page.context().newCDPSession(page);
	await client.send("Network.enable");
	await client.send("Network.emulateNetworkConditions", {
		offline: false,
		latency: 70, // ms RTT
		downloadThroughput: (12 * 1024 * 1024) / 8, // 12 Mbps
		uploadThroughput: (3 * 1024 * 1024) / 8, // 3 Mbps
	});
}

export async function clearThrottle(page: Page): Promise<void> {
	if (page.context().browser()?.browserType().name() !== "chromium") return;
	const client = await page.context().newCDPSession(page);
	await client.send("Network.enable");
	await client.send("Network.emulateNetworkConditions", {
		offline: false,
		latency: 0,
		downloadThroughput: -1,
		uploadThroughput: -1,
	});
}

/**
 * Credentials sign-in for the seeded QA user. Uses the /sign-in page's
 * password form — deliberately not OAuth so tests are hermetic.
 */
export async function signInAs(page: Page, role: "A" | "B"): Promise<void> {
	const manifest = requireManifest();
	const email = manifest.users[role].email;
	const password = passwordFor(role);

	await page.goto("/sign-in");
	await page.waitForLoadState("networkidle");
	await page.getByLabel("Email").fill(email);
	await page.getByLabel("Password").fill(password);
	await page.getByRole("button", { name: /sign in/i }).click();
	await expect(page).not.toHaveURL(/\/sign-in/, { timeout: 20_000 });
}

/**
 * Extended test that auto-applies the Vercel SSO bypass header (when the
 * secret is present) and exposes `manifest` + `signIn` shortcuts.
 */
export const test = base.extend<{
	manifest: QAManifest;
	signIn: (role: "A" | "B") => Promise<void>;
}>({
	context: async ({ context }, use) => {
		await applyVercelBypass(context);
		await use(context);
	},
	manifest: async ({}, use) => {
		await use(requireManifest());
	},
	signIn: async ({ page }, use) => {
		await use((role: "A" | "B") => signInAs(page, role));
	},
});

export { expect };
