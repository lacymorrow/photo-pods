import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { podMedia } from "@/server/db/pods-schema";
import * as policy from "@/server/services/pod-policy";
import { loadStorageConfig, planMediaServe, presign } from "@/server/services/pod-storage";

/**
 * Membership-checked media read route.
 *
 * Public pods are redirected straight to the CDN / object URL so the browser
 * and CDN can cache aggressively without hitting the app on every view.
 *
 * Private and group pods never receive a long-lived storage URL. They get
 * either a short-lived presigned GET (S3/R2) or the bytes proxied through
 * this route (Vercel Blob fallback and legacy rows) — see `planMediaServe`
 * and LAC-3173 for why the old redirect-to-`media.url` behaviour made the
 * membership check below decorative.
 */
export const GET = async (
  _req: NextRequest,
  { params }: { params: Promise<{ mediaId: string }> }
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
      mimeType: true,
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
      { status: viewer.userId ? 403 : 401 }
    );
  }

  const config = loadStorageConfig();
  const plan = planMediaServe({
    visibility: ctx.pod.visibility,
    storageKey: media.storageKey,
    url: media.url,
    config,
    presignGet: (key) => {
      try {
        return presign({ config, method: "GET", key, expiresInSeconds: 60 * 5 });
      } catch {
        // Not presignable (blob fallback, missing credentials, bad endpoint).
        return null;
      }
    },
  });

  if (plan.kind === "not_found") {
    return NextResponse.json({ error: "no_media_url" }, { status: 404 });
  }

  if (plan.kind === "redirect") {
    const res = NextResponse.redirect(plan.url, 302);
    if (ctx.pod.visibility !== "public") {
      // Presigned and expiring — let the browser reuse it, but keep it out
      // of any shared cache.
      res.headers.set("Cache-Control", "private, max-age=240");
    }
    return res;
  }

  // Proxy. The upstream URL stays server-side so it is never disclosed to the
  // client, which is the whole point for a non-public pod.
  let upstream: Response;
  try {
    upstream = await fetch(plan.url);
  } catch {
    return NextResponse.json({ error: "media_fetch_failed" }, { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json(
      { error: upstream.status === 404 ? "not_found" : "media_fetch_failed" },
      { status: upstream.status === 404 ? 404 : 502 }
    );
  }

  const headers = new Headers();
  headers.set(
    "Content-Type",
    upstream.headers.get("content-type") ?? media.mimeType ?? "application/octet-stream"
  );
  const contentLength = upstream.headers.get("content-length");
  if (contentLength) headers.set("Content-Length", contentLength);
  const etag = upstream.headers.get("etag");
  if (etag) headers.set("ETag", etag);
  // `private` keeps the CDN and any intermediary from serving these bytes to
  // a viewer this route has not membership-checked.
  headers.set("Cache-Control", "private, max-age=240");
  // The bytes are user media, not a document — never let a browser sniff it
  // into something executable.
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Disposition", "inline");

  return new Response(upstream.body, { status: 200, headers });
};
