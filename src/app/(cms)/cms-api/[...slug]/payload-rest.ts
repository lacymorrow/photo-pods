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
import {
  REST_DELETE,
  REST_GET,
  REST_OPTIONS,
  REST_PATCH,
  REST_POST,
  REST_PUT,
} from "@payloadcms/next/routes";

export const GET = REST_GET(config);
export const POST = REST_POST(config);
export const DELETE = REST_DELETE(config);
export const PATCH = REST_PATCH(config);
export const PUT = REST_PUT(config);
export const OPTIONS = REST_OPTIONS(config);
