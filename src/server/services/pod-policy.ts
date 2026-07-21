/**
 * @fileoverview Single source of truth for Photopods access-control decisions.
 *
 * Every server action and media-URL signer routes through this module — no
 * route may implement its own ad-hoc membership check. This is the surface the
 * security review sits on (LAC-2859).
 *
 * Privacy matrix (LAC-2855, board-clarified 2026-07-21):
 *
 *   visibility  | view              | add media          | react
 *   ------------|-------------------|--------------------|----------------
 *   private     | owner only        | owner only         | owner only
 *   group       | members           | members            | members
 *   public      | everyone (guests) | members (invited)  | authenticated user
 *
 * @module server/services/pod-policy
 */

import { and, eq } from "drizzle-orm";
import { db } from "@/server/db";
import {
	type Pod,
	type PodMember,
	type PodVisibility,
	podMembers,
	pods,
} from "@/server/db/pods-schema";

export interface Viewer {
	userId: string | null;
	isAdmin?: boolean;
}

export interface PolicyContext {
	pod: Pick<Pod, "id" | "visibility" | "createdById" | "hiddenAt">;
	viewer: Viewer;
	membership: Pick<PodMember, "role"> | null;
}

const requireDb = () => {
	if (!db) throw new Error("Database not initialized");
	return db;
};

/**
 * Load the policy context for a given (pod, viewer) pair. Callers should build
 * this once per request/action and pass it to the `can*` predicates below.
 */
export const loadPolicyContext = async (
	podId: string,
	viewer: Viewer,
): Promise<PolicyContext | null> => {
	const database = requireDb();
	const pod = await database.query.pods.findFirst({
		where: eq(pods.id, podId),
		columns: {
			id: true,
			visibility: true,
			createdById: true,
			hiddenAt: true,
		},
	});
	if (!pod) return null;

	let membership: Pick<PodMember, "role"> | null = null;
	if (viewer.userId) {
		const row = await database.query.podMembers.findFirst({
			where: and(
				eq(podMembers.podId, podId),
				eq(podMembers.userId, viewer.userId),
			),
			columns: { role: true },
		});
		membership = row ?? null;
	}

	return { pod, viewer, membership };
};

export const isMember = (ctx: PolicyContext | null): boolean =>
	Boolean(ctx?.membership);

export const isOwner = (ctx: PolicyContext | null): boolean =>
	Boolean(ctx?.membership?.role === "owner");

/**
 * Who can see the pod (and its media that is not hidden)?
 *
 * - private: owner only (membership required, role does not matter beyond that
 *   because private pods never have non-owner members)
 * - group: any member
 * - public: everyone, including unauthenticated guests
 */
export const canView = (ctx: PolicyContext | null): boolean => {
	if (!ctx) return false;
	if (ctx.pod.hiddenAt && !ctx.viewer.isAdmin && !isOwner(ctx)) return false;
	switch (ctx.pod.visibility) {
		case "public":
			return true;
		case "group":
			return isMember(ctx);
		case "private":
			// Owner-only, even if the pod was downgraded from group→private with
			// prior members still in pod_members. Fixes LAC-2897 H5.
			return isOwner(ctx);
	}
};

/**
 * Who can add media?
 *
 * Uniform across visibility: membership is required. Public pods are
 * world-viewable, but adding media requires an invite — board clarification on
 * LAC-2855 (2026-07-21) supersedes the spec's "any authenticated user uploads
 * to public pods" line.
 */
export const canUpload = (ctx: PolicyContext | null): boolean => {
	if (!ctx) return false;
	if (ctx.pod.hiddenAt) return false;
	// Private pods are owner-only across the matrix. Membership can persist
	// after a group→private downgrade; policy trumps stale rows.
	if (ctx.pod.visibility === "private") return isOwner(ctx);
	return isMember(ctx);
};

/**
 * Who can react?
 *
 * - private: owner only
 * - group: members only
 * - public: any authenticated user (viewer.userId must be set)
 */
export const canReact = (ctx: PolicyContext | null): boolean => {
	if (!ctx) return false;
	if (ctx.pod.hiddenAt) return false;
	if (!ctx.viewer.userId) return false;
	switch (ctx.pod.visibility) {
		case "public":
			return true;
		case "group":
			return isMember(ctx);
		case "private":
			return isOwner(ctx);
	}
};

/** Only pod owners can invite. Private pods have no invite flow. */
export const canInvite = (ctx: PolicyContext | null): boolean => {
	if (!ctx) return false;
	if (ctx.pod.visibility === "private") return false;
	if (ctx.pod.visibility === "public") return false;
	return isOwner(ctx);
};

/** Owners moderate their group pods; platform admins moderate anywhere. */
export const canModerate = (ctx: PolicyContext | null): boolean => {
	if (!ctx) return false;
	if (ctx.viewer.isAdmin) return true;
	return isOwner(ctx);
};

/** Anyone authenticated can follow a public pod (feed subscription). */
export const canFollow = (ctx: PolicyContext | null): boolean => {
	if (!ctx) return false;
	if (!ctx.viewer.userId) return false;
	return ctx.pod.visibility === "public";
};

/** Public pods surface in discovery/search; group and private do not. */
export const isDiscoverable = (visibility: PodVisibility): boolean =>
	visibility === "public";

export interface PolicyError extends Error {
	code: "not_found" | "forbidden" | "unauthenticated";
	status: number;
}

const err = (
	code: PolicyError["code"],
	message: string,
	status: number,
): PolicyError => {
	const e = new Error(message) as PolicyError;
	e.code = code;
	e.status = status;
	return e;
};

/**
 * Guard helper. Loads policy context and either returns it or throws a typed
 * error the action layer can map to an HTTP status.
 */
export const guardPod = async (
	podId: string,
	viewer: Viewer,
	predicate: (ctx: PolicyContext) => boolean,
	action: string,
): Promise<PolicyContext> => {
	const ctx = await loadPolicyContext(podId, viewer);
	if (!ctx) throw err("not_found", "Pod not found", 404);
	if (!predicate(ctx)) {
		if (!viewer.userId) {
			throw err("unauthenticated", `Sign in required to ${action}`, 401);
		}
		throw err("forbidden", `Not allowed to ${action} this pod`, 403);
	}
	return ctx;
};
