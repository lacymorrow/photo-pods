/**
 * Payload's GraphQL endpoint, behind the Payload feature flag.
 *
 * The generated handlers live in ./payload-graphql. See
 * `(cms)/_lib/payload-route` for why they are not imported statically.
 */
import { payloadRoute } from "@/app/(cms)/_lib/payload-route";

const graphql = () => import("./payload-graphql");

export const POST = payloadRoute(async () => (await graphql()).POST);
export const OPTIONS = payloadRoute(async () => (await graphql()).OPTIONS);
