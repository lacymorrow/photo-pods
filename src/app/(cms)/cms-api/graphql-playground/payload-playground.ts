/**
 * Payload codegen output, moved out of route.ts unchanged.
 *
 * route.ts is now a feature-flag guard that reaches this module through a
 * dynamic import, so a build with Payload off never loads it. See
 * `(cms)/_lib/payload-route` for why. If Payload regenerates route.ts, move
 * the new body back in here and restore the guard.
 */
/* THIS FILE WAS GENERATED AUTOMATICALLY BY PAYLOAD. */
/* DO NOT MODIFY IT BECAUSE IT COULD BE REWRITTEN AT ANY TIME. */
import config from "@payload-config";
import "@payloadcms/next/css";
import { GRAPHQL_PLAYGROUND_GET } from "@payloadcms/next/routes";

export const GET = GRAPHQL_PLAYGROUND_GET(config);
