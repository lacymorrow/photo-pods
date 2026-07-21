import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { podMedia } from "@/server/db/pods-schema";
import * as policy from "@/server/services/pod-policy";
import {
	loadStorageConfig,
	presign,
	publicUrlForKey,
} from "@/server/services/pod-storage";

/**
 * Membership-checked media read route.
 *
 * Public pods with a public CDN URL are redirected straight to the CDN.
 * Private/group pods issue a short-lived (5 min) presigned GET so viewers
 * without direct storage credentials can still see media through their
 * browser's `<img>` / `<video>` element.
 */
export const GET = async (
	_req: NextRequest,
	{ params }: { params: Promise<{ mediaId: string }> },
) => {
	if (!db) return NextResponse.json({ error: "db_unavailable" }, { status: 503 });
	const { mediaId } = await params;

	const session = await auth();
	const viewer: policy.Viewer = {
		userId: session?.user?.id ?? null,
		isAdmin: session?.user?.role === "admin",
	};

	const media = await db.query.podMedia.findFirst({
		where: eq(podMedia.id, mediaId),
		columns: {
			id: true,
			podId: true,
			status: true,
			storageKey: true,
			url: true,
			hiddenAt: true,
		},
	});
	if (!media) return NextResponse.json({ error: "not_found" }, { status: 404 });
	if (media.status !== "ready" || media.hiddenAt) {
		return NextResponse.json({ error: "not_available" }, { status: 404 });
	}

	const ctx = await policy.loadPolicyContext(media.podId, viewer);
	if (!ctx || !policy.canView(ctx)) {
		return NextResponse.json(
			{ error: viewer.userId ? "forbidden" : "unauthorized" },
			{ status: viewer.userId ? 403 : 401 },
		);
	}

	const config = loadStorageConfig();

	// Public pod on a CDN-backed bucket — redirect straight to the CDN so the
	// browser can cache aggressively without hitting the app on every request.
	if (ctx.pod.visibility === "public" && media.storageKey) {
		const publicUrl = publicUrlForKey(config, media.storageKey);
		if (publicUrl) return NextResponse.redirect(publicUrl, 302);
	}

	// Legacy blob URLs (uploadPhoto path) — just redirect through.
	if (media.url && !media.storageKey) {
		return NextResponse.redirect(media.url, 302);
	}

	// Group/private: presigned GET, valid for 5 minutes.
	if (media.storageKey && config.provider !== "vercel-blob") {
		try {
			const signedUrl = presign({
				config,
				method: "GET",
				key: media.storageKey,
				expiresInSeconds: 60 * 5,
			});
			const res = NextResponse.redirect(signedUrl, 302);
			res.headers.set("Cache-Control", "private, max-age=240");
			return res;
		} catch {
			// fall through
		}
	}

	if (media.url) {
		return NextResponse.redirect(media.url, 302);
	}

	return NextResponse.json({ error: "no_media_url" }, { status: 404 });
};
