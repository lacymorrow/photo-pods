/**
 * Payload's GraphQL playground, behind the Payload feature flag.
 *
 * The generated handler lives in ./payload-playground. See
 * `(cms)/_lib/payload-route` for why it is not imported statically.
 */
import { payloadRoute } from "@/app/(cms)/_lib/payload-route";

export const GET = payloadRoute(async () => (await import("./payload-playground")).GET);
