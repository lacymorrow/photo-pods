import { describe, expect, it, vi } from "vitest";

// pod-reactions imports the DB but the isValidReactionSlug guard is pure —
// we only need the module to load without wiring a real database.
vi.mock("@/server/db", () => ({
	db: { query: {} },
}));

import { isValidReactionSlug } from "@/server/services/pod-reactions";
import { REACTIONS } from "@/lib/pods/reactions";

describe("pod-reactions.isValidReactionSlug — invalid slug guard (LAC-2914)", () => {
	it("accepts every curated slug", () => {
		for (const spec of REACTIONS) {
			expect(isValidReactionSlug(spec.slug)).toBe(true);
		}
	});

	it("rejects arbitrary strings and empty input", () => {
		expect(isValidReactionSlug("")).toBe(false);
		expect(isValidReactionSlug("nope")).toBe(false);
		expect(isValidReactionSlug("LOVE")).toBe(false); // slugs are lower-case
	});

	it("resists prototype pollution — 'hasOwn' guards __proto__/toString/constructor", () => {
		// A naive `slug in REACTION_BY_SLUG` check would return true for
		// inherited object keys. Object.hasOwn keeps them out.
		expect(isValidReactionSlug("__proto__")).toBe(false);
		expect(isValidReactionSlug("toString")).toBe(false);
		expect(isValidReactionSlug("constructor")).toBe(false);
		expect(isValidReactionSlug("hasOwnProperty")).toBe(false);
	});
});
