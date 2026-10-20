import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * LAC-5015: with Payload disabled, `/cms` and `/cms-api/*` must answer 404.
 *
 * Production served 500 `{"message":"There was an error initializing Payload"}`
 * from these routes because Payload's generated entrypoints boot the CMS on
 * every request regardless of the feature flag. The guard has to short-circuit
 * *before* the Payload import, not catch a failure after it, so these tests
 * also assert the loader is never called.
 */

let payloadEnabled = false;

vi.mock("@/env", () => ({
  env: new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "NEXT_PUBLIC_FEATURE_PAYLOAD_ENABLED") return payloadEnabled;
        return undefined;
      },
    }
  ),
}));

const { payloadRoute } = await import("@/app/(cms)/_lib/payload-route");

const request = () => new Request("https://photo-pods.vercel.app/cms-api/users?limit=1");

describe("payloadRoute", () => {
  beforeEach(() => {
    payloadEnabled = false;
  });

  it("answers 404 when Payload is disabled", async () => {
    const handler = payloadRoute(async () => async () => new Response("payload", { status: 200 }));

    const response = await handler(request(), { params: Promise.resolve({}) });

    expect(response.status).toBe(404);
  });

  it("never loads the Payload body when disabled", async () => {
    const load = vi.fn(async () => async () => new Response(null, { status: 200 }));

    await payloadRoute(load)(request(), { params: Promise.resolve({}) });

    // A guard that imported Payload and then failed would still be a 500 in
    // production. The import must not happen at all.
    expect(load).not.toHaveBeenCalled();
  });

  it("delegates to the Payload handler when enabled", async () => {
    payloadEnabled = true;
    const inner = vi.fn(async () => new Response("payload", { status: 201 }));

    const response = await payloadRoute(async () => inner)(request(), {
      params: Promise.resolve({ slug: ["users"] }),
    });

    expect(response.status).toBe(201);
    expect(inner).toHaveBeenCalledOnce();
  });

  it("passes the route arguments through untouched", async () => {
    payloadEnabled = true;
    const inner = vi.fn(async () => new Response(null, { status: 200 }));
    const req = request();
    const context = { params: Promise.resolve({ slug: ["users"] }) };

    await payloadRoute(async () => inner)(req, context);

    expect(inner).toHaveBeenCalledWith(req, context);
  });
});

describe("the generated /cms-api routes with Payload disabled", () => {
  beforeEach(() => {
    payloadEnabled = false;
  });

  it("REST answers 404 on every method", async () => {
    const route = await import("@/app/(cms)/cms-api/[...slug]/route");
    const context = { params: Promise.resolve({ slug: ["users"] }) };

    for (const method of ["GET", "POST", "DELETE", "PATCH", "PUT", "OPTIONS"] as const) {
      const response = await route[method](request(), context);
      expect(response.status, `${method} /cms-api/users`).toBe(404);
    }
  });

  it("GraphQL answers 404", async () => {
    const route = await import("@/app/(cms)/cms-api/graphql/route");
    const context = { params: Promise.resolve({}) };

    expect((await route.POST(request(), context)).status).toBe(404);
    expect((await route.OPTIONS(request(), context)).status).toBe(404);
  });

  it("the GraphQL playground answers 404", async () => {
    const route = await import("@/app/(cms)/cms-api/graphql-playground/route");

    expect((await route.GET(request(), { params: Promise.resolve({}) })).status).toBe(404);
  });
});
