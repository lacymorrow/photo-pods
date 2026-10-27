import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { parsePodMediaQuality, parsePodMediaWidth } from "@/lib/pods/media-url";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { podMedia } from "@/server/db/pods-schema";
import { isResizableImageMime, resizeMediaImage } from "@/server/services/pod-media-resize";
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
 *
 * With `?w=` this route is also the image optimizer for non-public pods.
 * Next's own optimizer cannot be: it fetches a local src with no headers, so
 * the ACL rejects it, and PR #50 had to set `unoptimized` on every src that
 * points here — which made a private pod's grid download originals. Resizing
 * on this side of the membership check gets the resized bytes back without
 * handing anyone a URL that works without a session (LAC-5698).
 */
export const GET = async (
  req: NextRequest,
  { params }: { params: Promise<{ mediaId: string }> }
) => {
  if (!db) return NextResponse.json({ error: "db_unavailable" }, { status: 503 });
  const { mediaId } = await params;
  // Read off `req.url` rather than `nextUrl` so the handler works against a
  // plain `Request` in tests as well as a `NextRequest` in production.
  const query = new URL(req.url).searchParams;

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

  const width = parsePodMediaWidth(query.get("w"));
  // Only non-public pods resize here. A public pod's src is its CDN URL, so
  // `next/image` already optimizes it the normal way; honouring `?w=` for one
  // would just donate unauthenticated CPU.
  const shouldResize =
    width !== null && ctx.pod.visibility !== "public" && isResizableImageMime(media.mimeType);

  if (plan.kind === "redirect" && !shouldResize) {
    const res = NextResponse.redirect(plan.url, 302);
    if (ctx.pod.visibility !== "public") {
      // Presigned and expiring — let the browser reuse it, but keep it out
      // of any shared cache.
      res.headers.set("Cache-Control", "private, max-age=240");
    }
    return res;
  }

  // Fetch server-side. The upstream URL stays here and is never disclosed to
  // the client, which is the whole point for a non-public pod. A resize takes
  // this path even when the plan said `redirect`, because the bytes have to
  // be on this side of the membership check to be resized at all.
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

  const upstreamEtag = upstream.headers.get("etag");

  if (shouldResize && width !== null) {
    const quality = parsePodMediaQuality(query.get("q"));
    // Buffered, not streamed: sharp needs the whole object. Note this body is
    // consumed, so the fallback below has to reuse `original` rather than
    // reach for `upstream.body` again.
    const original = await upstream.arrayBuffer();
    const resized = await resizeMediaImage(original, { width, quality });
    if (resized) {
      const headers = buildMediaHeaders(resized.contentType);
      headers.set("Content-Length", String(resized.body.byteLength));
      if (upstreamEtag) {
        // The render is a different entity than the stored object, so the
        // upstream ETag cannot be reused as-is — a cache keyed on it would
        // answer a 640px request with the full-size bytes.
        headers.set("ETag", `W/"${stripEtag(upstreamEtag)}-w${width}-q${quality}"`);
      }
      return new Response(new Uint8Array(resized.body), { status: 200, headers });
    }
    // Decode failed. Serve the original rather than 500 — the ACL already
    // passed, so the viewer is entitled to these bytes.
    const headers = buildMediaHeaders(
      upstream.headers.get("content-type") ?? media.mimeType ?? "application/octet-stream"
    );
    headers.set("Content-Length", String(original.byteLength));
    if (upstreamEtag) headers.set("ETag", upstreamEtag);
    return new Response(original, { status: 200, headers });
  }

  const headers = buildMediaHeaders(
    upstream.headers.get("content-type") ?? media.mimeType ?? "application/octet-stream"
  );
  const contentLength = upstream.headers.get("content-length");
  if (contentLength) headers.set("Content-Length", contentLength);
  if (upstreamEtag) headers.set("ETag", upstreamEtag);

  return new Response(upstream.body, { status: 200, headers });
};

const buildMediaHeaders = (contentType: string): Headers => {
  const headers = new Headers();
  headers.set("Content-Type", contentType);
  // `private` keeps the CDN and any intermediary from serving these bytes to
  // a viewer this route has not membership-checked.
  headers.set("Cache-Control", "private, max-age=240");
  // The bytes are user media, not a document — never let a browser sniff it
  // into something executable.
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Disposition", "inline");
  return headers;
};

const stripEtag = (etag: string): string => etag.replace(/^W\//, "").replace(/"/g, "");
