/**
 * @fileoverview Curated emoji reaction set for Photopods media (LAC-2856 §3.6).
 *
 * The set is intentionally fixed — clients enforce membership via this list, and
 * the backend enforces the same set in a policy layer (no pg enum, so the set
 * can evolve without a schema migration). Order here is the render order.
 */

export interface ReactionSpec {
	emoji: string;
	label: string;
	/** Stable string sent to the backend. */
	slug: string;
}

export const REACTIONS: ReactionSpec[] = [
	{ emoji: "❤️", label: "Love", slug: "love" },
	{ emoji: "🔥", label: "Fire", slug: "fire" },
	{ emoji: "😂", label: "Funny", slug: "funny" },
	{ emoji: "😍", label: "Heart eyes", slug: "heart_eyes" },
	{ emoji: "🤩", label: "Amazed", slug: "amazed" },
	{ emoji: "👏", label: "Applause", slug: "applause" },
	{ emoji: "😮", label: "Wow", slug: "wow" },
	{ emoji: "🥹", label: "Touched", slug: "touched" },
	{ emoji: "📸", label: "Great shot", slug: "great_shot" },
	{ emoji: "🏆", label: "Best one", slug: "best_one" },
	{ emoji: "💯", label: "Perfect", slug: "perfect" },
	{ emoji: "👎", label: "Dislike", slug: "dislike" },
];

export const REACTION_BY_SLUG: Record<string, ReactionSpec> = Object.fromEntries(
	REACTIONS.map((r) => [r.slug, r]),
);

export type ReactionCounts = Record<string, number>;
