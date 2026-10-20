/**
 * The 404 boundary for /cms, behind the Payload feature flag.
 *
 * This file matters as much as page.tsx: it is the boundary `notFound()` in
 * page.tsx renders into, and Payload's generated version imports the CMS too.
 * Left unguarded it would turn a disabled-Payload 404 straight back into the
 * 500 this guard exists to remove.
 *
 * With Payload off, /cms is simply not a route this app serves, so it gets the
 * same 404 page as any other unknown URL.
 */
import type { Metadata } from "next";
import { NotFoundPage } from "@/components/pages/not-found-page";
import { env } from "@/env";

interface Args {
  params: Promise<{
    segments: string[];
  }>;
  searchParams: Promise<Record<string, string | string[]>>;
}

const payloadNotFound = () => import("./payload-not-found");

export const generateMetadata = async (args: Args): Promise<Metadata> => {
  if (!env.NEXT_PUBLIC_FEATURE_PAYLOAD_ENABLED) {
    return { title: "Not Found" };
  }

  return (await payloadNotFound()).generateMetadata(args);
};

const NotFound = async (args: Args) => {
  if (!env.NEXT_PUBLIC_FEATURE_PAYLOAD_ENABLED) {
    return <NotFoundPage />;
  }

  const { default: PayloadNotFound } = await payloadNotFound();
  return PayloadNotFound(args);
};

export default NotFound;
