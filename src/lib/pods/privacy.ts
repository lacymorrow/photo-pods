/**
 * @fileoverview Photopods privacy visual system.
 * Maps pod visibility values to accent color, icon, label and copy per LAC-2856.
 *
 * DB and UI both use `private | group | public` (LAC-2857 backend rename).
 * The `invite-only` alias is kept in the DB→UI map for backward compatibility
 * with pre-migration test fixtures.
 */

import { Globe, Lock, Users, type LucideIcon } from "lucide-react";

export type PodVisibilityDb = "public" | "private" | "group" | "invite-only";
export type PodPrivacyKey = "public" | "private" | "group";

export interface PrivacyMeta {
	key: PodPrivacyKey;
	dbValue: PodPrivacyKey;
	label: string;
	shortLabel: string;
	description: string;
	icon: LucideIcon;
	/** Tailwind arbitrary values built off HSL tokens per design spec. */
	accentHsl: string;
	accentClass: string;
	accentBorderClass: string;
	accentBgTintClass: string;
	accentTextClass: string;
	badgeClass: string;
}

const meta: Record<PodPrivacyKey, PrivacyMeta> = {
	private: {
		key: "private",
		dbValue: "private",
		label: "Private",
		shortLabel: "Private",
		description: "Just you. A personal media vault.",
		icon: Lock,
		accentHsl: "270 70% 55%",
		accentClass: "bg-[hsl(270_70%_55%)]",
		accentBorderClass: "border-[hsl(270_70%_55%)]",
		accentBgTintClass: "bg-[hsl(270_70%_97%)] dark:bg-[hsl(270_40%_12%)]",
		accentTextClass: "text-[hsl(270_70%_45%)] dark:text-[hsl(270_70%_75%)]",
		badgeClass:
			"bg-[hsl(270_70%_55%)] text-white border-transparent",
	},
	group: {
		key: "group",
		dbValue: "group",
		label: "Group",
		shortLabel: "Group",
		description: "Friends only. Share moments together.",
		icon: Users,
		accentHsl: "25 95% 55%",
		accentClass: "bg-[hsl(25_95%_55%)]",
		accentBorderClass: "border-[hsl(25_95%_55%)]",
		accentBgTintClass: "bg-[hsl(25_80%_96%)] dark:bg-[hsl(25_50%_12%)]",
		accentTextClass: "text-[hsl(25_95%_45%)] dark:text-[hsl(25_95%_65%)]",
		badgeClass:
			"bg-[hsl(25_95%_55%)] text-white border-transparent",
	},
	public: {
		key: "public",
		dbValue: "public",
		label: "Public",
		shortLabel: "Public",
		description: "Open to everyone. Start a community.",
		icon: Globe,
		accentHsl: "175 70% 45%",
		accentClass: "bg-[hsl(175_70%_45%)]",
		accentBorderClass: "border-[hsl(175_70%_45%)]",
		accentBgTintClass: "bg-[hsl(175_50%_96%)] dark:bg-[hsl(175_30%_12%)]",
		accentTextClass: "text-[hsl(175_70%_35%)] dark:text-[hsl(175_70%_65%)]",
		badgeClass:
			"bg-[hsl(175_70%_45%)] text-white border-transparent",
	},
};

const dbToKey: Record<PodVisibilityDb, PodPrivacyKey> = {
	public: "public",
	private: "private",
	group: "group",
	"invite-only": "group",
};

/**
 * Resolve privacy metadata from either a UI key or the current DB enum value.
 * Falls back to `group` for unknown inputs so cards always render an accent.
 */
export const getPrivacyMeta = (
	value: PodPrivacyKey | PodVisibilityDb | string | null | undefined,
): PrivacyMeta => {
	if (!value) return meta.group;
	if (value in meta) return meta[value as PodPrivacyKey];
	const key = dbToKey[value as PodVisibilityDb];
	return key ? meta[key] : meta.group;
};

export const PRIVACY_ORDER: PodPrivacyKey[] = ["private", "group", "public"];

export const PRIVACY_LEVELS: PrivacyMeta[] = PRIVACY_ORDER.map((k) => meta[k]);
