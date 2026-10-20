import { env } from "@/env";

/**
 * Feature guard for Payload's generated route handlers.
 *
 * Payload's codegen writes `/cms-api/*` as a static import of `@payload-config`
 * plus `@payloadcms/next/routes`, with no notion of the feature flag. When
 * Payload is off that shape is wrong twice over:
 *
 * - The handler still boots the CMS on every request, so a deployment without
 *   a working Payload answers 500 instead of 404. That is LAC-5015: production
 *   served `{"message":"There was an error initializing Payload"}` from
 *   `/cms-api/users` for months while the route looked like it existed.
 * - `withPayloadConfig` (`src/config/nextjs/with-payload.ts`) only applies
 *   `withPayload` when the flag is on, so a disabled build would keep the
 *   externalised `@payloadcms/*` packages without the Next config that makes
 *   them loadable.
 *
 * So the entrypoint keeps only this guard and loads its generated body through
 * `load` once the flag is on. `(cms)/layout.tsx` already uses the same shape
 * for the admin layout.
 *
 * The 404 is bodyless on purpose: with Payload off this endpoint genuinely
 * does not exist, and that is exactly what Next.js answers for a route that
 * was never defined. An error body would imply the CMS is there but unwell.
 */
export const payloadRoute =
  <Args extends unknown[]>(load: () => Promise<(...args: Args) => Promise<Response>>) =>
  async (...args: Args): Promise<Response> => {
    if (!env.NEXT_PUBLIC_FEATURE_PAYLOAD_ENABLED) {
      return new Response(null, { status: 404 });
    }

    const handler = await load();
    return handler(...args);
  };
