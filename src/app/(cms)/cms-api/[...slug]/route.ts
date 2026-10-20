/**
 * Payload's REST API, behind the Payload feature flag.
 *
 * The generated handlers live in ./payload-rest. See
 * `(cms)/_lib/payload-route` for why they are not imported statically.
 */
import { payloadRoute } from "@/app/(cms)/_lib/payload-route";

const rest = () => import("./payload-rest");

export const GET = payloadRoute(async () => (await rest()).GET);
export const POST = payloadRoute(async () => (await rest()).POST);
export const DELETE = payloadRoute(async () => (await rest()).DELETE);
export const PATCH = payloadRoute(async () => (await rest()).PATCH);
export const PUT = payloadRoute(async () => (await rest()).PUT);
export const OPTIONS = payloadRoute(async () => (await rest()).OPTIONS);
