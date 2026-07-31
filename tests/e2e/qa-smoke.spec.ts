/**
 * LAC-3138 Definition-of-Done smoke: sign in as seeded user A, create a
 * public pod, upload one photo, delete the pod. Green here proves the
 * QA test-infra pieces (seeded accounts + Playwright fixture + SSO bypass
 * + fixture media) hang together end-to-end.
 *
 * Skips (does not fail) when required env is missing so CI without the
 * secrets stays green while a maintainer sets them up.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

import { expect, loadManifest, test } from "./qa-fixtures";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GPS_FIXTURE = path.join(__dirname, "fixtures/gps-tagged.jpg");

const hasPasswords = !!(process.env.E2E_USER_A_PASSWORD && process.env.E2E_USER_B_PASSWORD);
const hasManifest = !!loadManifest();

test.describe("QA infra smoke (LAC-3138)", () => {
	test.beforeEach(() => {
		test.skip(
			!hasManifest,
			"QA manifest missing — run `bun run scripts/seed-qa-fixtures.ts` first",
		);
		test.skip(!hasPasswords, "E2E_USER_A_PASSWORD / E2E_USER_B_PASSWORD not set");
		test.skip(!existsSync(GPS_FIXTURE), "gps-tagged.jpg missing — run `bun run scripts/gen-e2e-media.ts gps`");
	});

	test("A can sign in, create a public pod, upload a photo, delete the pod", async ({
		page,
		signIn,
	}) => {
		await signIn("A");

		// Create a public pod with a unique name so parallel/re-runs don't collide.
		const podName = `smoke-${Date.now()}`;
		await page.goto("/pods/new");
		await page.getByLabel("Pod Name").fill(podName);
		await page.getByLabel("Visibility").click();
		await page.getByRole("option", { name: "Public" }).click();
		await page.getByRole("button", { name: /create pod/i }).click();
		await expect(page).toHaveURL(/\/pods\/[0-9a-f-]{36}/, { timeout: 20_000 });
		const podUrl = page.url();
		const podId = podUrl.split("/pods/")[1]?.split(/[/?#]/)[0];
		expect(podId).toBeTruthy();

		// Upload one photo via the hidden file input (drag-drop friendly).
		const fileInput = page.locator('input[type="file"]').first();
		await fileInput.setInputFiles(GPS_FIXTURE);
		// The client-side flow shows the file in a tray, then the upload
		// button commits it. If the component auto-uploads, this still
		// resolves because we just wait for the tile to appear.
		await expect(
			page.getByRole("img", { name: /gps-tagged|photo/i }).first().or(page.locator('[data-testid="photo-tile"]').first()),
		).toBeVisible({ timeout: 45_000 });

		// Delete the pod via the settings page.
		await page.goto(`/pods/${podId}/settings`);
		await page.getByPlaceholder(podName).fill(podName);
		await page.getByRole("button", { name: /delete pod/i }).click();
		await expect(page).not.toHaveURL(/\/pods\/[0-9a-f-]{36}/, { timeout: 20_000 });
	});
});
